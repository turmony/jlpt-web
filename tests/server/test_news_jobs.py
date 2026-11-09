"""Resumable news streams: a model job outlives the HTTP connection that started it.

The public HTTPS edge cuts every response at about 16 s, and a sentence analysis often takes longer.
So /analyze and /ask run the model in a background job and each connection carries at most
`segment` seconds of it; the browser continues with /resume until the job ends.
"""
import http.client
import json
import socket
import threading
import time

from server.news_jobs import JobBoard
from tests.server.test_news_http import ANALYSIS, ORIGIN, NewsHTTPBase


def parse_frames(raw):
    """[(id or None, event, data)] from raw SSE bytes; comment frames are skipped."""
    frames = []
    for block in raw.decode('utf-8').split('\n\n'):
        event_id, name, data = None, None, []
        for line in block.split('\n'):
            if line.startswith('id: '):
                event_id = int(line[4:])
            elif line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: '):
                data.append(line[6:])
        if name:
            frames.append((event_id, name, json.loads('\n'.join(data))))
    return frames


class JobTestBase(NewsHTTPBase):
    def use(self, *args, **kwargs):
        svc = super().use(*args, **kwargs)
        svc.jobs.grace = 0.3
        return svc

    def post(self, path, body, origin=ORIGIN):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        self.addCleanup(conn.close)
        conn.request('POST', path, json.dumps(body), {'Cookie': self.cookie, 'Origin': origin,
                                                     'Content-Type': 'application/json'})
        return conn.getresponse()

    def segment(self, path, body):
        """One connection: (response, frames, seconds it stayed open)."""
        start = time.monotonic()
        resp = self.post(path, body)
        raw = resp.read()
        return resp, parse_frames(raw), time.monotonic() - start

    def follow(self, path, body, limit=40):
        """What the userscript does: continue with /resume while a connection ends in `resume`.
        Returns (all frames, [seconds per connection])."""
        resp, frames, took = self.segment(path, body)
        self.assertEqual(resp.status, 200)
        job = resp.getheader('X-News-Job')
        self.assertTrue(job)
        everything, times = list(frames), [took]
        while frames[-1][1] == 'resume':
            self.assertLess(len(times), limit)
            resp, frames, took = self.segment('/api/news/resume', {'job': job, 'next': everything[-2][0]})
            self.assertEqual(resp.status, 200)
            everything += frames
            times.append(took)
        return everything, times


class SegmentTests(JobTestBase):
    def test_a_long_analysis_arrives_in_short_connections(self):
        self.use(script=[('chunks', ANALYSIS, 0.3)], first_timeout=5, total_timeout=20)
        self.svc.jobs.segment = 0.7
        self.login()
        frames, times = self.follow('/api/news/analyze', self.analyze_body(0, 1))
        events = [(name, data) for _, name, data in frames if name != 'resume']
        self.assertEqual(events[-1], ('done', {'analysis_text': ''.join(ANALYSIS)}), events)
        self.assertIn('translation', [n for n, _ in events])
        self.assertGreaterEqual(len(times), 3)              # one connection could not carry it
        self.assertTrue(all(t < 1.6 for t in times), times)  # and none ran far past the segment
        ids = [i for i, name, _ in frames if name != 'resume']
        self.assertEqual(ids, list(range(1, len(ids) + 1)))  # every event once, in order
        self.assertEqual(len(self.fake.requests), 1)         # one model call for all of it

    def test_ask_streams_resume_too(self):
        self.use(script=[('chunks', ['因为', '是', '持续', '。'], 0.3)], first_timeout=5, total_timeout=20)
        self.svc.jobs.segment = 0.5
        self.login()
        body = {**self.analyze_body(0, 1), 'analysis': '', 'history': [], 'question': '为什么？'}
        frames, times = self.follow('/api/news/ask', body)
        text = ''.join(d['text'] for _, n, d in frames if n == 'delta')
        self.assertEqual(text, '因为是持续。')
        self.assertEqual(frames[-1][1], 'done')
        self.assertGreaterEqual(len(times), 2)

    def test_a_fast_answer_needs_one_connection_and_has_no_resume(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.login()
        resp, frames, _ = self.segment('/api/news/analyze', self.analyze_body())
        self.assertEqual(frames[-1][1], 'done')
        self.assertNotIn('resume', [n for _, n, _ in frames])

    def test_response_names_the_job_and_exposes_it_to_the_news_site(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.login()
        resp = self.post('/api/news/analyze', self.analyze_body(), origin='https://news.yahoo.co.jp')
        resp.read()
        self.assertEqual(resp.getheader('Access-Control-Allow-Origin'), 'https://news.yahoo.co.jp')
        self.assertRegex(resp.getheader('X-News-Job'), r'^[A-Za-z0-9_-]{16,}$')
        self.assertEqual(resp.getheader('Access-Control-Expose-Headers'), 'X-News-Job')

    def test_resume_replays_only_the_events_after_next(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.login()
        resp, frames, _ = self.segment('/api/news/analyze', self.analyze_body())
        job = resp.getheader('X-News-Job')
        last = frames[-1][0]
        _, later, _ = self.segment('/api/news/resume', {'job': job, 'next': last - 1})
        self.assertEqual([(i, n) for i, n, _ in later], [(last, 'done')])
        _, nothing, _ = self.segment('/api/news/resume', {'job': job, 'next': last})
        self.assertEqual(nothing, [])

    def test_resume_of_a_finished_job_survives_the_keep_time_only(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.svc.jobs.keep = 0.2
        self.login()
        resp, _, _ = self.segment('/api/news/analyze', self.analyze_body())
        job = resp.getheader('X-News-Job')
        time.sleep(0.4)
        self.segment('/api/news/analyze', self.analyze_body())  # starting a job sweeps expired ones
        err = self.json('/api/news/resume', {'job': job, 'next': 0}, status=502)['error']
        self.assertEqual((err['stage'], err['retryable']), ('stream', True))
        self.assertIn('过期', err['reason'])

    def test_resume_rejects_a_bad_request(self):
        self.use()
        self.login()
        for body in ({}, {'job': 5, 'next': 0}, {'job': 'x', 'next': -1}, {'job': 'x', 'next': 'a'},
                     {'job': 'x', 'next': True}):
            err = self.json('/api/news/resume', body, status=400)['error']
            self.assertEqual(err['stage'], 'client', body)
        self.assertEqual(self.json('/api/news/resume', {'job': 'nope', 'next': 0}, status=502)['error']['stage'], 'stream')

    def test_model_errors_are_events_of_the_job(self):
        self.use(script=[('status', 429, 'slow down')])
        self.login()
        _, frames, _ = self.segment('/api/news/analyze', self.analyze_body())
        self.assertEqual(frames[-1][1], 'error')
        self.assertEqual(frames[-1][2]['stage'], 'model')


class LifetimeTests(JobTestBase):
    def start_raw(self, path, body):
        """Send a request on a raw socket and return it once the job is announced."""
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        data = json.dumps(body).encode()
        sock.sendall(('POST %s HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nCookie: %s\r\n'
                      'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n'
                      % (path, ORIGIN, self.cookie, len(data))).encode() + data)
        got = b''
        while b'\r\n\r\n' not in got:
            chunk = sock.recv(4096)
            self.assertTrue(chunk)
            got += chunk
        job = [l.split(b': ')[1].strip().decode() for l in got.split(b'\r\n') if l.lower().startswith(b'x-news-job')][0]
        return sock, job

    def test_a_job_survives_its_connection_dropping_and_can_be_resumed(self):
        self.use(script=[('chunks', ANALYSIS, 0.1)], first_timeout=5, total_timeout=20)
        self.svc.jobs.grace = 5
        self.login()
        sock, job = self.start_raw('/api/news/analyze', self.analyze_body())
        sock.close()  # the proxy cut it, the phone went through a tunnel...
        _, frames, _ = self.segment('/api/news/resume', {'job': job, 'next': 0})
        self.assertEqual(frames[-1][1], 'done', frames)
        self.assertEqual(len(self.fake.requests), 1)
        self.assertEqual(self.fake.disconnects, 0)

    def test_an_abandoned_job_stops_the_model_after_the_grace_period(self):
        self.use(script=[('reasoning', 10, ['never']), ('chunks', ANALYSIS, 0)], first_timeout=5, total_timeout=20)
        self.svc.slots = threading.BoundedSemaphore(1)  # a leaked slot would queue the next request
        self.login()
        sock, _ = self.start_raw('/api/news/analyze', self.analyze_body())
        self.assertTrue(self.fake.wait_requests(1))
        sock.close()
        self.assertTrue(self.fake.wait_disconnect(timeout=4))
        _, frames, _ = self.segment('/api/news/analyze', self.analyze_body())
        self.assertEqual(frames[-1][1], 'done', frames)

    def test_cancel_stops_the_model_at_once(self):
        self.use(script=[('reasoning', 10, ['never'])], first_timeout=5, total_timeout=20)
        self.svc.jobs.grace = 60
        self.login()
        sock, job = self.start_raw('/api/news/analyze', self.analyze_body())
        self.assertTrue(self.fake.wait_requests(1))
        self.assertEqual(self.json('/api/news/cancel', {'job': job}), {})
        self.assertTrue(self.fake.wait_disconnect(timeout=3))
        sock.close()
        self.assertEqual(self.json('/api/news/cancel', {'job': 'unknown'}), {})  # cancelling twice is fine

    def test_cancel_needs_a_job_name(self):
        self.use()
        self.login()
        self.assertEqual(self.json('/api/news/cancel', {}, status=400)['error']['stage'], 'client')

    def test_too_many_running_jobs_are_refused(self):
        self.use(script=[('reasoning', 10, ['never'])], first_timeout=5, total_timeout=20)
        self.svc.jobs.max_live = 2
        self.svc.jobs.grace = 60
        self.login()
        socks = [self.start_raw('/api/news/analyze', self.analyze_body())[0] for _ in range(2)]
        err = self.json('/api/news/analyze', self.analyze_body(), status=502)['error']
        self.assertEqual((err['stage'], err['retryable']), ('stream', True))
        self.assertIn('忙', err['reason'])
        for s in socks:
            s.close()


class JobBoardTests(JobTestBase):
    def test_a_job_that_raises_unexpectedly_ends_with_an_error_event(self):
        board = JobBoard()
        job = board.start(lambda emit: (_ for _ in ()).throw(RuntimeError('boom')))
        frames = []
        board.serve(job, 0, lambda event, data=None, event_id=None: frames.append((event_id, event, data)))
        self.assertEqual(frames[-1][1], 'error')
        self.assertEqual(frames[-1][2]['stage'], 'stream')
