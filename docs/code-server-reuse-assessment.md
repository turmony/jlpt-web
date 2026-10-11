# code-server 在 JLPT 网页中管理智能体 CLI 的复用评估

检查日期：2026-10-11。源码基准：`coder/code-server` 的 main 提交
`41cf6f7eaffd34eed01a985b6e843e09b0f98ed7`，提交时间 2026-10-09。
本次通过 GitHub API、少量源码和官方文档检查，没有克隆仓库、安装依赖或修改运行中的网站。

## 结论

可以复用其浏览器 IDE、终端和扩展基础设施，但没有可直接移植到当前网页的
Codex / Qoder / Antigravity 统一 CLI 对话管理模块。
当前需求是对话列表、结构化消息、模型选择、流式回复与试卷管理，建议继续使用
已有 AionUi 消息组件、CLI/ACP 适配器、SQLite 和 SSE。
需要原生 CLI 交互时，可直接接入 VS Code 也使用的 xterm.js 与 PTY，避免引入整个 IDE。
这是基于源码的集成判断，尚未进行 code-server 运行或扩展兼容性验证。

## 源码依据

- [`src/node/routes/vscode.ts`](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/src/node/routes/vscode.ts)
  加载 VS Code 的 `out/server-main.js`，调用 `createServer`，把 HTTP 请求和
  WebSocket 升级交给 VS Code。它不是独立的智能体对话服务。
- [`.gitmodules`](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/.gitmodules)
  中的 `lib/vscode` 指向 `microsoft/vscode`。编辑器、终端等核心界面来自该子模块。
- [`src/node/wsRouter.ts`](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/src/node/wsRouter.ts)
  实现 Express 的连接升级路由；CLI 会话续接、消息归一化和历史存储仍需应用实现。
- [`src/node/http.ts`](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/src/node/http.ts)
  包含 Cookie 鉴权、Origin 校验和反向代理路径处理。当前 Python 服务已有登录与
  Origin 校验，因此这些 TypeScript/Express 代码不能直接替换现有实现。
- [`patches/copilot.diff`](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/patches/copilot.diff)
  处理 Copilot 扩展的构建和原生依赖打包，不能直接作为上述三种 CLI 的统一适配器。
- [官方贡献指南](https://coder.com/docs/code-server/CONTRIBUTING)
  明确说明 code-server 主要负责登录和启动远程 Code 进程，主要功能位于 `lib/vscode`，
  本地构建还需维护 VS Code 补丁。

## 与当前需求对应

| 能力 | 复用判断 | 当前项目的接入位置 |
| --- | --- | --- |
| 在网页运行原生 CLI，显示颜色、光标、交互菜单 | 可通过完整 IDE 终端实现；轻量方案直接使用 xterm.js + PTY | 新增可选终端视图及服务端进程连接 |
| 各 CLI 的历史、续聊、模型和推理强度 | 仍需各 CLI 的协议适配，终端进程身份不等于模型会话身份 | `server/cli.py`、`server/store.py`、`agent/runner.ts` |
| 结构化回复、Markdown、工具调用、工作时间 | 没有可直接替换当前 UI 的通用模块；采用 IDE 时需要自定义扩展或 Webview | 现有 `chat/` 与 vendored AionUi 组件 |
| 流式输出、断线后补齐历史 | WebSocket 基础设施可参考；当前 SSE 已具有事件游标恢复 | `server/app.py`、`web/practice.mjs` |
| 文件编辑、目录浏览、Git 差异 | 完整 code-server 能提供，移植独立组件成本更高 | 可作为单独的工作区编辑入口 |
| 试卷作答、草稿、交卷、判卷 | 需要保留业务实现或开发专用扩展 | 现有 paper/submission API 与右侧试卷面板 |

## 可行接入方式

### 保留现有网页，按需增加终端

已有结构化 CLI 输出继续走 `CLI/ACP → SQLite 事件 → SSE → AionUi`。
若需要原生交互界面，增加 `CLI ↔ PTY ↔ WebSocket ↔ xterm.js`。
终端连接需要处理输入、尺寸调整、断线恢复与进程生命周期；聊天历史依然由 SQLite 保存。
优先使用已有 Python 服务可支持的 PTY 方案，确有必要时才增加 Node 的 node-pty 进程服务。
终端滚屏可限制长度并在内存保留近期内容，避免无界终端录像占用硬盘。

依据：[xterm.js](https://github.com/xtermjs/xterm.js) 明确支持独立网页集成，
提供 attach、fit、serialize 等组件；[node-pty](https://github.com/microsoft/node-pty)
提供进程的伪终端接口。这属于复用其底层依赖，不是直接移植 code-server 自有代码。

### 使用完整 code-server 并开发扩展

如果目标还包括文件编辑、终端、Git 和扩展管理，可以单独运行 code-server，
开发在服务端执行的工作区扩展，通过 Webview 展示对话和试卷。
现有后端仍可承担 CLI 适配、历史和试卷校验，扩展负责展示与交互。
需要新增扩展、登录衔接和反向代理配置，并验证每个 CLI 的运行与续聊。
[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
支持自定义 HTML 界面与扩展之间传递消息；不能据此推断所有 AI 扩展都兼容 code-server。

## 存储与许可证

当前服务器检查结果为 19 GB 磁盘、约 5.1 GB 可用。
通过 GitHub Release API 查询，v4.141.0 的 Linux amd64 压缩包约 228.8 MiB；
解压后占用尚未测量，扩展、用户数据和构建依赖会额外占用空间。
仅为对话管理引入完整 IDE 的成本不划算；若采用完整 IDE，应优先官方预构建版本，
下载完成后删除安装包，避免在这台小磁盘服务器克隆 VS Code 子模块并编译。

来源：[Release](https://github.com/coder/code-server/releases/tag/v4.141.0)、
[Release API](https://api.github.com/repos/coder/code-server/releases/tags/v4.141.0)、
[构建指南](https://coder.com/docs/code-server/CONTRIBUTING)。

[code-server LICENSE](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/LICENSE)
和 [VS Code 源码 LICENSE](https://github.com/microsoft/vscode/blob/main/LICENSE.txt)
使用 MIT，源码复用需保留相应版权与许可证。扩展和第三方依赖需按各自许可证处理。

## 当前建议

继续在现有网页上完善多 CLI 会话管理；需要原生 CLI 交互时增加轻量终端。
只有当文件编辑、Git 和扩展体系也成为主要需求时，才引入完整 code-server。
