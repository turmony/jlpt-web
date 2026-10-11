# AionUi source reused by JLPT chat

Source: https://github.com/iOfficeAI/AionUi/tree/v1.9.25

Pinned commit: `bbada2a9268060d2b41ddf1d885a9b27ecd2103d`.
Upstream copyright and Apache-2.0 license are retained in source files and `LICENSE`.
`manifest.json` records each file's current and original SHA256. The vendored
dependency closure builds without downloading or cloning the upstream repository.

Reused code includes `AcpConnection`, `acpConnectors`, `SendBox`, `AcpConfigSelector`, `MessageList`,
ACP tool/thinking/plan views, Markdown, syntax highlighting, contexts, utilities,
locale files and assets. `sendbox.tsx` has optional
DOM ids, `sendDisabled`, `clearOnSend`, `enableBuiltinCommands` and `inlineReplyQuote` let JLPT send
exact user input directly and preserve later drafts. Defaults preserve the
original desktop behavior. Model/reasoning controls use the unmodified
`AcpConfigSelector` in its upstream local mode, inside `SendBox.tools`.
Quoted text is inserted visibly into the input instead of prepended during
submission, and the accessible send label no longer references a preview step.
`MessageText.tsx` also displays optional application work-time metadata below an
assistant response. Its Markdown and normal timestamp rendering stay upstream.
`AcpConnection.ts` has a small protocol fix: selecting a reject option uses ACP
`selected`, and failed permission callbacks use `cancelled`. The original
`rejected` outcome is invalid in the maintained bridge SDK.

Application bindings are in `agent/` and `chat/`, selected by
`scripts/build-chat.mjs`. Electron IPC, OS dialogs, attachment upload and speech
are unavailable in this web application. Built-in slash commands are disabled so
user text reaches the agent unchanged. Upstream file preview requests use a browser preview dialog.

The original `@zed-industries/codex-acp` binary is deprecated and cannot use the
installed Codex model catalog. The launcher preserves AionUi's argument contract
but starts its maintained successor, `@agentclientprotocol/codex-acp@2.2.2`.
This adapter uses Codex App Server and the account's existing login. Explicit
model/reasoning options are negotiated through ACP or rejected visibly.

`agent/bridge-policy.mjs` applies a separate, hash-guarded compatibility patch to
the maintained bridge's WorkspaceWrite preset when creating the build output:
approval policy `never`, workspace write sandbox, network access enabled. Its
unmodified preset otherwise overrides `CODEX_CONFIG` on each turn. The launcher
and runner force this mode, and permission extensions are rejected. The package
in `node_modules` is unchanged; upgrades fail the hash guard pending review.

Build: `npm ci && npm run build` with Node 22–24. The optional
`JLPT_AIONUI_SOURCE` build variable is only for maintainers importing additional
source from this exact commit, and is unnecessary for ordinary builds.
