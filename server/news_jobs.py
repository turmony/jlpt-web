"""Background jobs for the news streams (analysis and follow-up questions).

The public HTTPS edge in front of this server cuts every response at about 16 s, but a model
answer can take 30 s. So a stream is not tied to one connection: the model runs in a job
thread that records its events, and each HTTP connection only *follows* the job for at most
`segment` seconds. A connection that ends with a `resume` event is continued by the browser
with POST /resume {job, next}; `next` is the id of the last event it has seen. Events are
numbered from 1 and sent with an SSE `id:` line, so a replay never repeats or skips one.

A job nobody has followed for `grace` seconds (the page was closed, a newer analysis replaced
it) stops its model request; POST /cancel stops it at once. Finished jobs are kept for `keep`
seconds so a browser that missed the tail can still fetch it.
"""
import secrets
import threading
import time

from server.news_errors import NewsError

SEGMENT = 12.0      # seconds one connection follows a job; well under the edge's ~16 s
GRACE = 5.0         # seconds without any follower before the job is abandoned
KEEP = 300.0        # seconds a finished job stays available for /resume
MAX_LIVE = 30       # unfinished jobs at once
PING_GAP = 0.5      # a quiet connection writes a comment this often, which also notices a closed client

R_BUSY = '服务器忙，请稍后再试'
R_GONE = '这次回答已过期，请重试'


class ClientGone(BaseException):
    """The browser closed the stream. A BaseException so generic handlers never swallow it."""


class Job:
    def __init__(self, job_id, now):
        self.id = job_id
        self.events = []          # [(event, data)], event number n is events[n - 1]
        self.done = False
        self.cancelled = False
        self.readers = 0
        self.idle_since = now     # when the job last had no follower
        self.finished_at = None
        self.cond = threading.Condition()


class JobBoard:
    def __init__(self, segment=SEGMENT, grace=GRACE, keep=KEEP, max_live=MAX_LIVE, clock=time.monotonic):
        self.segment = segment
        self.grace = grace
        self.keep = keep
        self.max_live = max_live
        self.clock = clock
        self._jobs = {}
        self._lock = threading.Lock()

    # -- jobs ------------------------------------------------------------------
    def start(self, run):
        """Start `run(emit)` in a thread and return its Job. `emit(event, data)` records an event;
        emit(None) only checks whether the job is still wanted (raises ClientGone when not)."""
        with self._lock:
            now = self.clock()
            for key in [k for k, j in self._jobs.items() if j.finished_at is not None and now - j.finished_at > self.keep]:
                del self._jobs[key]
            if sum(1 for j in self._jobs.values() if not j.done) >= self.max_live:
                raise NewsError('stream', R_BUSY)
            job = Job(secrets.token_urlsafe(12), now)
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, run), name='news-job', daemon=True).start()
        return job

    def _run(self, job, run):
        def emit(event, data=None):
            with job.cond:
                abandoned = job.readers == 0 and self.clock() - job.idle_since > self.grace
                if job.cancelled or abandoned:
                    raise ClientGone()
                if event is not None:
                    job.events.append((event, data))
                    job.cond.notify_all()
        try:
            try:
                run(emit)
            except ClientGone:
                pass
            except NewsError as error:
                emit('error', error.to_dict())
            except Exception as error:
                emit('error', NewsError('stream', '服务器内部错误：%s' % type(error).__name__).to_dict())
        except ClientGone:
            pass
        finally:
            with job.cond:
                job.done = True
                job.finished_at = self.clock()
                job.cond.notify_all()

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise NewsError('stream', R_GONE)
        return job

    def cancel(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
        if job is not None:
            with job.cond:
                job.cancelled = True
                job.cond.notify_all()

    # -- following -------------------------------------------------------------
    def serve(self, job, first, write):
        """Send the events of `job` after the first `first` of them through write(event, data, id).

        Returns when the job's last event was sent, or after `segment` seconds with a final
        `resume` event. write raises ClientGone when the connection is closed; a quiet job gets
        write(None) comments so that is noticed."""
        deadline = self.clock() + self.segment
        sent = first
        with job.cond:
            job.readers += 1
        try:
            while True:
                with job.cond:
                    if sent >= len(job.events) and not job.done:
                        job.cond.wait(max(0.0, min(PING_GAP, deadline - self.clock())))
                    batch = job.events[sent:]
                    finished = job.done
                for event, data in batch:
                    sent += 1
                    write(event, data, sent)
                    if event in ('done', 'error'):
                        return
                if finished and not batch:
                    return  # cancelled or abandoned: nothing more will come
                if not batch:
                    write(None, None, None)
                if self.clock() >= deadline:
                    write('resume', {}, None)
                    return
        finally:
            with job.cond:
                job.readers -= 1
                if job.readers == 0:
                    job.idle_since = self.clock()
