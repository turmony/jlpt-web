# JLPT Server Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly requested execution of the written spec; proceed in this session.

**Goal:** Implement the personal HTTPS JLPT site, persistent CLI practice and precise local study commits.

**Architecture:** Python standard-library HTTP server and SQLite handle auth, task state and submissions. A single worker runs CLI turns and independent upstream validators in the study worktree. Caddy protects static content using the same authentication endpoint. Existing mobile assets are preserved.

**Tech Stack:** Python 3.12+, SQLite, Node.js 22+ for builds, Caddy, uv for study validators.

**Spec:** docs/superpowers/specs/2026-10-10-jlpt-server-design.md

## Global Constraints

- Password hashes and session state live outside Git; cookies last one year.
- CLI choice is explicit; no fallback. Preview text is immutable and is exactly what execution receives.
- Model writes and commits are serialized in one persistent study worktree.
- One final submission per paper; drafts survive restarts; retries preserve history.
- No generation-stage commit, no automatic push; commit only related verified study artifacts.
- Original mobile range, navigation, caching and retry behavior remain available.

## Review Focus

- Cross-origin requests, expired/revoked credentials and traversal must not expose protected files.
- Multiple tabs and duplicate HTTP requests must not submit or append history twice.
- CLI death, cancellation, and restart must preserve session association and output.
- Symlinks, stale handoffs and unrelated dirty/staged files must not enter a study commit.
- Commit success followed by process death must be recoverable without a second commit.

### Task 1: Persistent state and authentication

**Files:** server/store.py, server/auth.py, tests/server/test_state.py

**Interfaces:** Store provides durable JSON records with transaction-serialized mutation; Auth provides password verification and persistent hashed session tokens.

- [x] Write tests for password rejection, session restart/revocation/expiration, stale draft writes, simultaneous submission, task restart recovery.
- [x] Run `python3 -m unittest discover -s tests/server -v`; expected RED before implementation.
- [x] Implement SQLite transactions, optimistic draft versions, unique paper binding, atomic one-time submission and session authentication.
- [x] Run same command; expected PASS.

### Task 2: CLI execution and exact previews

**Files:** server/cli.py, server/prompts.py, server/worker.py, tests/server/test_cli.py

**Interfaces:** cli.command(cli, prompt, session) produces argv/stdin; CLI event decoding produces session/text/error. Worker consumes persisted task/preview records and outputs status/events/handoff.

- [x] Test all three CLI envelopes and resume flags, literal prompts with shell metacharacters, preview binding, subprocess errors, serialization/cancellation and restart.
- [x] Run suite; expected RED.
- [x] Implement adapters using argv without shell, bounded output, process group cancellation and immutable preview enqueue.
- [x] Run suite; expected PASS.

### Task 3: Study validation and commits

**Files:** server/artifacts.py, server/git.py, tests/server/test_artifacts.py

**Interfaces:** validate_handoff(root, task, handoff) yields validated paper/grade and exact related files; commit_exercise(root, task_id, files) returns recoverable commit hash.

- [x] Test real Git repositories for exact staging, no push, failed commit retry, history preservation, symlink rejection, wrong submission/score and missing validation evidence.
- [x] Run suite; expected RED.
- [x] Reuse quiz_pipeline final validator and render comparisons, run upstream quiz/link validators, check per-question grade and append-only attempts, and use isolated Git index plus durable commit trailer.
- [x] Run suite; expected PASS.

### Task 4: HTTP and practice UI

**Files:** server/app.py, server/__main__.py, web/*, scripts/build-server.mjs, tests/server/test_http.py, tests/server/browser.test.mjs

**Interfaces:** authenticated /api endpoints expose CLI status, previews, tasks, paper drafts, submit and commit retry; /auth/check serves Caddy forward_auth.

- [x] Add actual HTTP integration tests for auth coverage, CSRF, exact preview execution and repeated submission; browser tests cover login, safe output rendering and draft restoration.
- [x] Run tests; expected RED.
- [x] Implement HTTP API and accessible Chinese mobile UI with free text, preview, progress, continue/cancel/retry, readable questions, always-accessible explanations and locked submission.
- [x] Build server assets and run Python, mobile and browser suites; expected PASS.

### Task 5: Deployment and acceptance

**Files:** deploy/*, scripts/setup_study.py, scripts/configure_server.py, docs/server-deployment.md, README.md

**Interfaces:** deploy points to /srv/jlpt/{app,state,static,repos,worktrees}; Caddy authenticates every non-login resource; Certbot renews trusted short-lived IP certs.

- [x] Test image materialization from pinned Git blobs and repeated worktree setup without changing existing learning history.
- [x] Run tests; expected RED.
- [x] Add pinned local image build, password initialization, systemd service, Caddy config and reproducible operator instructions. Use the user's trusted cloud HTTPS ingress for certificates and renewal.
- [x] Run full tests/build and independent final review; expected PASS. Deploy and verify live site when SSH connection information is available.

## Execution record

- Baseline: 19 mobile tests pass. Node 22 installed locally after SHA256 verification.
- Server SSH coordinates absent from provided workspace; requested while independent implementation proceeds.
- Work in a dedicated feature branch in the shared workspace; no additional checkout needed.
- User supplied SSH access and a cloud HTTPS HTTP-proxy endpoint forwarding to internal port 8080. Caddy serves HTTP behind that trusted HTTPS ingress; IP certificate provisioning is unnecessary for this deployment.
- Tasks 1–5 implemented. State, worker, validation and HTTP tests passed, including independent review fixes. Real study-tool fixture covers generation through failed-commit recovery without touching personal learning history.
- Final independent review found eight state/UI/report issues; all addressed with failing regression tests followed by passing runs. No deferred review findings.
- Public acceptance found a Caddy redirect matcher error; corrected and covered by an actual Caddy integration test.
- Browser acceptance found existing stalled-image retry reused a pending request; fixed in the mobile loader and verified against the existing regression.
- Final verification: 24 backend/tool tests + 19 mobile unit tests + 24 mobile browser tests + 3 practice UI tests pass. Live HTTPS, local images, restart-persistent login and real Codex session continuation pass.
- Actual Antigravity execution reaches the provider but fails with a location-not-supported API response; its session and actual error remain visible. Qoder is not installed. No CLI fallback or remote push was performed.
