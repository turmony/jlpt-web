# AionUi Codex chat implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline. The user explicitly requested execution of the approved design.

**Goal:** Run AionUi v1.9.25 components and Codex ACP connection code in the existing JLPT site.

**Architecture:** Vendor pinned upstream source; use application adapters around React components and a Node ACP runner. Python retains transactional previews, task scheduling, event persistence and exercise checks.

**Tech Stack:** Python stdlib/SQLite, Node 22, TypeScript/esbuild, React and AionUi dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-aionui-codex-design.md`

## Global Constraints

- Pin AionUi to `bbada2a9268060d2b41ddf1d885a9b27ecd2103d` (v1.9.25); preserve licenses and source hashes.
- Prefer unmodified upstream files and explicit platform adapters.
- Preserve existing uncommitted work, preview binding and exercise workflows.
- Explicit model/effort requests must apply or fail; never silently discard them.
- Do not alter global Codex configuration or silently replace a restored session.

## Review Focus

- Partial streamed replies survive errors and reconnections without duplicate text.
- Switching conversations during asynchronous requests cannot mix their histories.
- Legacy databases and exec sessions remain readable and fail visibly on incompatible restore.
- IME composition cannot accidentally send a prompt; Markdown cannot execute HTML/scripts.
- Cancelled/failed processes terminate and unsupported configuration fails before prompting.

### Task 1: Pinned upstream integration and Codex runner

**Files:** `vendor/aionui/`, `agent/`, root package/build configuration, `tests/agent/`.

**Interfaces:** Node runner reads one JSON line `{prompt,session,cwd,model,effort}` from stdin, outputs JSON event lines; diagnostics use stderr. Actual ACP transport is upstream `AcpConnection`.

- [x] Add executable fake ACP fixture and tests for new/load, streaming, settings, errors and cancellation; observe missing runner failures.
- [x] Vendor needed source and licensing with SHA256 manifest; install pinned dependency set.
- [x] Implement platform adapters and runner using upstream connection methods, preserving isolation and selected settings.
- [x] Run Node transport tests; expected all pass.

### Task 2: Structured history and Python integration

**Files:** `server/store.py`, `server/cli.py`, `server/acp.py`, `server/worker.py`, `server/app.py`, `tests/server/`.

**Interfaces:** `Store.event(task,kind,text,data=None)` persists structured events; `events(task,after)` remains compatible. Codex default runner uses ACP; tasks with legacy transport remain identifiable.

- [x] Add tests for old-schema migration, idempotent user history, worker ACP events and authenticated cursor streams; observe failures.
- [x] Implement history migration, ACP process runner and worker event handling.
- [x] Add bounded authenticated SSE responses and cursor validation.
- [x] Run complete Python server suite; expected all pass.

### Task 3: Upstream chat components and exercise integration

**Files:** `chat/`, `web/index.html`, `web/practice.mjs`, styles, `scripts/build-server.mjs`, browser tests.

**Interfaces:** Chat adapter renders server events as upstream messages and connects preview/send/stop controls to existing business API. Paper submission can select its task and prefill grading prompt.

- [x] Add browser assertions for history, streamed Markdown, conversation switching, preview binding and narrow screens; observe failures.
- [x] Wire upstream sendbox/message components with supported contexts and application bridge.
- [x] Mount chat and preserve draft/submission/report behavior.
- [x] Run Chromium/WebKit suites; expected all pass.

### Task 4: Packaging and deployment documentation

**Files:** build/install scripts, README/deployment docs, source provenance.

- [x] Verify clean dependency install and complete static/agent build.
- [x] Document Node requirement, pinned ACP bridge and old-session behavior.
- [x] Verify source hashes and license packaging.

### Task 5: End-to-end verification and fresh review

- [x] Run Python, agent and browser suites, inspect outputs.
- [x] Attempt real authenticated Codex two-turn ACP conversation in a disposable workspace.
- [x] Request fresh review per executing-plans; address important findings and rerun relevant checks.
- [x] Report actual changes, verification and remaining external limitations.

## Verification evidence

- Clean `npm ci` and `npm run build` succeeded without an upstream checkout.
- Agent suite: 7 passed, including restore replay filtering, policy enforcement, rejection, cancellation and partial errors.
- Server suite: 40 tests; 2 external-environment tests skipped. Includes schema migration, authenticated SSE cursors, full history drainage and wall timeout cancellation.
- Chromium/WebKit practice suite: 4 passed, covering Markdown safety, IME, mobile layout, previews, switching, delayed actions, drafts and submission.
- Existing mobile unit suite: 19 passed.
- Real installed Codex ACP: two turns restored the same session; second answer was exactly `紫藤`.
- Fresh independent review and focused follow-up found no remaining important issues.
- Source manifest: 121 upstream files, 119 identical, two documented minimal adaptations; plus the local provenance README.
- Changes remain in the shared working tree. The original integration was deployed on 2026-10-10; no fabricated Git author identity.

## User-directed follow-up: direct sending and in-composer settings

- [x] Assert exact raw prompts without skill prefixes, observe failing Python tests, then remove prompt rewriting.
- [x] Reuse upstream `AcpConfigSelector` inside `SendBox.tools` for model and reasoning selection.
- [x] Remove preview UI and automatically use existing immutable snapshot/enqueue transaction from one Send action.
- [x] Preserve IME, later drafts/settings, task-switch guards and same-turn retry; include quoted text visibly and handle in-flight stop.
- [x] Obtain fresh independent review and address accessible label, model discovery diagnostics and failed-cancel recovery.
- [x] Verify final browser suite and publish updated app/static release; preserve all original records.

CLI/history filtering remains a recommendation awaiting the user's decision.

Follow-up evidence: source-independent build succeeded; 40 server tests without
skips and 6 browser tests passed. Public Chromium desktop and WebKit mobile checks
verified real model/reasoning menus in the composer, no preview controls, history,
authenticated SSE and zero page errors. Release:
`/srv/jlpt/releases/20261010T161438Z-direct-send`.

## Follow-up: ordinary chat and a full-height three-column workspace

User requested removal of duplicate Qoder answers and false missing-artifact errors, a bottom composer, and right-side papers using the available screen width. Keep reused AionUi SendBox, MessageList and model controls and existing backend validation.

- [ ] Reproduce stream/result duplication and mandatory-handoff failures with failing transport/worker tests; cover legacy replay and viewport/paper behavior in the browser.
- [ ] Treat terminal CLI result text as a fallback when assistant content was streamed. Default new/freeform turns to auto; permit successful plain replies without handoff, while explicit artifact operations and actual quiz changes require validated handoff. Retain grade/commit protections.
- [ ] Use a viewport-height grid for history, chat and artifacts. Keep composer below flexible message history. Move the existing paper form into the independently scrolling right panel; support mobile panel toggles without changing draft/submission behavior.
- [ ] Build sequentially, run server/transport/browser checks, obtain an independent review, then deploy with a reversible release and public desktop/mobile verification. Preserve all user data and pre-existing edits.
