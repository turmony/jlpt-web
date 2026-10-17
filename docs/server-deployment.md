# JLPT 服务器网站

已部署入口：<https://01a124c1da807b288db3e3a22b4fddb5.ap-northeast-2.c9b2d4.cloud/>。

云平台提供该域名的可信 HTTPS，将 HTTP 请求转发到服务器 `10.222.24.165:8080`。Caddy 监听 8080，应用只监听 `127.0.0.1:8765`。HTTPS 证书及续期由云平台管理；此部署不申请公网 IP 证书。`38.127.4.98:10014` 是 SSH 入口。

## 登录

初次安装在服务器生成 32 字符随机网站密码。管理员通过 SSH 读取 `/srv/jlpt/state/website-password`；`config.json` 只保存 scrypt 密码哈希。密码、SQLite 会话及任务信息不进入 Git。该目录权限为 700，配置与密码文件权限为 600。

Windows PowerShell 可使用本机已有私钥读取：

```powershell
ssh -i "$env:USERPROFILE\.ssh\Win26-10.pem" -p 10014 root@38.127.4.98 "cat /srv/jlpt/state/website-password"
```

登录 Cookie 使用 HttpOnly、Secure、SameSite=Strict，有效期一年。应用重启后登录仍有效；退出会吊销当前登录。所有学习页面、图片及 API 使用同一会话检查。登录页和其样式、脚本可公开读取。

## 使用

1. 打开首页或登录后默认进入语法记忆。选择范围后，同时显示图片与完整“核心”内容；核心区域固定为 240 像素高，超出内容通过滚动查看，不再显示卡片主题。上一张／下一张下方、核心上方列出当前卡片全部功能，点击功能只滚动核心区域至对应位置。核心正文为 15 像素、行距 1.6、段间距 8 像素；标题为 16 像素加粗，例句与译文保持成组。显示时合并多余空行并渲染 Markdown 标题、加粗、列表和表格，资料原文不变。通过页面顶部的“智能体练习”进入 `/practice.html`。
2. 在聊天输入框底部选择 CLI、模型和推理强度，输入自由文本后直接发送。新建 Codex 对话默认选择模型列表第一项，并在该模型支持时使用 `high` 思考强度；已有对话保留原设置。发送给智能体的提示词就是输入原文，保留空格、换行和斜杠文本；模型及强度作为独立参数传入。根据提示词处理普通问答、出卷或判卷。
3. 智能体要求补充信息或运行失败时，选择原任务，输入后续提示后直接发送。会话保持原 CLI；新建对话后可选择其他 CLI。
4. 桌面页面左侧管理对话，中间聊天，右侧管理试卷与产物，各区域独立滚动。右侧按试卷 ID 分组，同组并列展示“查看试卷”和“查看成绩报告”，报告可直接打开。报告使用 Markdown 渲染标题、表格、列表、加粗及链接，不检查分数；报告中的配套试卷、答案链接在同一面板打开。返回列表或切换时保留阅读位置和草稿。已登记试卷的报告按资料库标准路径自动发现，在任务完成后刷新入口，也支持发现此前已经生成的报告。本轮在标准 `quizzes/papers/` 目录生成的试卷自动登记并关联当前对话，无需交接文件；有可用最终清单时支持在线作答，缺少清单时仍可查看试卷 Markdown 原文。已有试卷的草稿与正式交卷记录保留。手机通过“对话列表”和“试卷与产物”切换面板。多标签页冲突时，本页答案保留，可选择服务器版本或保存本页作答。
5. 正式交卷只发生一次并锁定答案。网页自动选择判卷操作并填入可编辑的目标试卷提示词，直接发送。网页展示智能体的判卷输出，不另行校验分数、追加作答历史或自动提交 Git。
6. 旧版本已经验证、等待提交的任务仍可使用“重试本地提交”；新对话没有后台自动提交步骤。

当前服务器 Codex 已安装并确认登录，真实调用与恢复同一会话已验证。Antigravity 已安装，真实调用能够启动并返回会话 ID，但 API 返回 `FAILED_PRECONDITION: User location is not supported for the API use`，目前无法执行模型任务；页面显示上次实际错误。Qoder CN 已安装为 `qoderclicn`，真实模型列表读取成功；网站依次检测 `qoder`、`qodercli`、`qoderclicn`，检测、模型读取和任务执行使用同一命令。不会自动切换 CLI。CLI 的用户认证和会话文件沿用服务器当前账户的本地配置。

智能体练习与登录页面使用语法记忆页的深灰背景、浅色文字和暖色强调色。

点击发送后，用户原文立即出现在聊天中；请求失败时保留输入，重试仍复用同一发送记录。回复和过程通过 SSE 增量展示，断线后按事件编号续读，不轮询消息。执行时显示工作秒数，结束后在回复下保留工作时间，重新打开会话也可查看。Qoder 使用部分消息流并以 `--resume` 继续已有会话。

右侧点击当前试卷可折叠，再次点击展开；折叠前保存草稿。完成或已交卷的试卷仍可查看解析与成绩。

默认构建不生成 source map，只有 `JLPT_DEBUG_BUILD=1 npm run build` 才启用。增量更新使用 `python3 scripts/prepare_release.py` 准备新版本，再运行 `node scripts/build-server.mjs <新版本路径>/static`；相同依赖版本复用共享 node_modules，课程图片以硬链接复用，网页代码单独复制以保留回滚能力。验证后只保留当前版本和上一个可回滚版本。测试保留 Chromium Headless Shell 与 WebKit，无需另存完整 Chromium。Qoder 登录诊断使用不保存会话的临时探测，正式会话历史继续保留。

Codex 模型及各模型支持的强度读取本机 `models_cache.json`，只展示可见模型；Antigravity 使用 `agy models`，Qoder 安装后使用 `qoder --list-models`，模型列表缓存五分钟。列表读取失败时在运行诊断展示原因，保留 CLI 默认配置选项。选择模型后才开放推理强度。输入框下拉菜单直接复用 AionUi `AcpConfigSelector`。发送时锁定该轮原文和配置，继续输入或修改配置会保留为下一轮草稿；发送失败保留输入。

模型或强度选择“默认模型”／“默认强度”时不发送该参数：新会话使用 CLI 配置，继续会话时沿用执行器已有会话设置。这不是重置；需要改变时选择明确的模型和强度。

参数依据：[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[Antigravity 模型与强度](https://antigravity.google/docs/cli/headless/#select-a-model-effort-or-agent)、[Qoder 模型与推理参数](https://docs.qoder.com/cli/cli-reference#models-and-reasoning)。Antigravity 强度按服务器已安装版本的 `--help` 支持 `low`、`medium`、`high`、`xhigh`、`max`，实际模型服务拒绝某项配置时仍显示原始错误。

Antigravity 模型名带 `-low`、`-medium` 或 `-high` 时，强度列表只提供相同档位及沿用选项；实测不同档位会被 CLI 判定为冲突。未返回可选强度的模型保留执行器配置，例如服务器上的 Claude Sonnet 模型拒绝额外 `--effort` 参数。

## 目录与边界

| 目录 | 内容 |
| --- | --- |
| `/srv/jlpt/app` | 网站与后台代码 |
| `/srv/jlpt/static` | 网站和固定资料版本的 960 张本地图片 |
| `/srv/jlpt/state` | 密码配置、SQLite、登录和任务状态 |
| `/root/projects/jlpt-study` | 资料克隆和 worktree 管理（`main` 分支） |
| `/root/projects/jlpt-study/.worktrees/web-study` | 长期 `web-study` 分支、练习资料和 CLI 工作目录 |

目录与图片固定到 `data/catalog.json` 的提交，不从原仓库自动更新。初次同步用 `git archive` 读取该提交的真实图片，不受当前工作区未提交图片影响。安装脚本重复运行不会重置学习分支或替换已有密码。项目默认位于当前账户的 `~/projects`，可通过 `JLPT_PROJECTS_ROOT` 指定其他项目根目录；`.worktrees/` 由仓库本地排除规则忽略。

从旧 `/srv/jlpt/repos`、`/srv/jlpt/worktrees` 布局升级时，先在无运行任务时停止服务，将原仓库移到新位置，使用 `git worktree repair` 修复关联，再用 `git worktree move` 移动学习工作区，重建其虚拟环境并更新服务器配置。安装脚本检测到尚未迁移的旧仓库时会停止，避免创建新工作区使已有成果无法访问。

单一后台进程持有持久状态锁，单一 worker 串行运行 CLI 与提交。重启后中断任务显示可继续；已验证的判卷显示提交待重试。systemd 终止整个进程组，避免旧 CLI 在重启后继续写入。

每轮启动 CLI 前，后台将网页对话上下文说明作为标记区块写入工作区根 `AGENTS.md`，保留原有规则并替换旧版网页交接规则。当前任务编号、轮次及正式作答上下文单独写入 `jlpt-notes/quizzes/web/current-turn.json`。正式作答仍以 JSON 和原技能 `N-答案` / `*N-语序` 格式导出，保留用户原始答案。

对话只记录并展示智能体的流式输出：回复、思考、工具调用和实际运行错误。文本被工具或思考过程隔开时分段展示，最终回答保持在对应处理过程之后；流式接收与历史重放使用相同顺序。CLI 成功结束后状态为“回复完成”，无需交接文件，不追加交接文件中的消息，也不在回复后执行网页产物校验、判分一致性校验或自动提交。

判分、完整报告、学习历史和文件操作由智能体按用户提示与资料库原有 skill 处理，用户根据模型回答自行判断。网页读取已登记试卷在 `jlpt-notes/quizzes/results/<试卷ID>-result.md` 的报告，或旧记录中登记的报告文件；这个读取过程不改动任务、成绩记录或学习文件，也不依赖 handoff。后台仍保留旧版提交收据的重试功能和原有网页试卷数据；新的出卷结果不会自动转为右侧网页试卷。原资料仓库的 push URL 仍设置为不可用的本地路径。

## 部署与维护

智能体对话复用 [AionUi v1.9.25 源码](../vendor/aionui/README.md)，而非仅模仿外观。`agent/` 将上游 `AcpConnection` 接到 Python worker，`chat/` 将持久事件映射到上游消息组件。对话输出不再经过网页判分或产物校验；原有试卷和正式交卷数据继续保留。工具调用、思考、错误和回复分别显示，原始日志收在“运行诊断”。手机通过“对话列表”切换历史。

安装需要 Node 22–24 和 npm。`deploy/install.sh` 执行 `npm ci`、构建 ACP runner 和聊天资源，再复制到静态目录。单独更新静态资源前也需先运行 `npm run build:chat`；worker 需要保留 `/srv/jlpt/app/node_modules`、`agent/dist` 与 `agent/launcher.mjs`。Codex ACP 依赖固定为 `@agentclientprotocol/codex-acp@2.2.2`，使用现有账户认证；每轮通过工作区模式设置工作区写入沙箱、网络访问及无需交互批准，不修改账户全局配置。维护版桥接器的模式会覆盖 `CODEX_CONFIG`，因此构建时通过 `agent/bridge-policy.mjs` 的源码 hash 门禁对该模式作兼容补丁，并拒绝任何额外权限请求。

新 Codex 对话以 ACP 创建与恢复会话。已有未标记通道的 exec 会话仍走原调用方式，保证历史上下文可继续。模型和强度通过 ACP 会话配置协商；不支持的明确选择会显示错误。升级 SQLite 时自动增加事件 payload 列，保留旧事件。SSE 使用登录认证和事件游标重连，失败后的部分回复保留。Markdown 默认关闭 HTML，CSP 继续限制脚本为本站；Arco/React 样式需要允许内联 style。

网页不提供桌面文件上传、语音和本机路径打开；`/export` 将当前文字对话下载为 Markdown，文件 diff 等内容通过页面弹窗查看。

需要 Ubuntu 24.04、Python 3.12+、Node 22+、Git、uv，以及已安装和登录的所选 CLI。将仓库代码复制到 `/srv/jlpt/app` 后执行：

```bash
cd /srv/jlpt/app
bash deploy/install.sh https://你的云平台HTTP代理域名
systemctl status jlpt caddy
```

查看运行记录：`journalctl -u jlpt -u caddy`。重新部署前后保留 `/srv/jlpt/state` 与 `~/projects/jlpt-study`（包括 `.git` 和 `.worktrees`），不要删除长期学习 worktree。备份时一并保存这些目录；SQLite 可使用 `.backup` 或停服务复制，避免只复制活动数据库而漏掉 WAL。

开发验证：

```bash
node scripts/build.mjs
npm ci
npm run build
npm run test:agent
npm ci --prefix mobile
python3 -m unittest discover -s tests/server -v
npm --prefix mobile test
npm exec --prefix mobile -- playwright install --with-deps chromium webkit
node --test tests/server/browser.test.mjs
JLPT_STUDY_ROOT=/absolute/path/to/jlpt-study npm --prefix mobile run test:browser
PATH="$HOME/.local/bin:$PATH" JLPT_STUDY_ROOT=/absolute/path/to/jlpt-study \
  CADDY_BINARY=/usr/bin/caddy python3 -m unittest discover -s tests/server -v
```

最后一项同时运行真实 Caddy 配置门禁及资料库原校验器。完整流水线验收使用独立临时 Git 仓库的机械测试 fixture，不写入个人学习记录，覆盖出卷、草稿、交卷、判卷、Git 失败恢复及提交后的重试。

本次验收：24 项后台/真实资料校验测试、19 项原移动单元测试、24 项 WebKit 语法与缓存测试、3 项 Chromium/WebKit 练习界面测试均通过。公网真实验证包括 HTTPS 登录与门禁、本地图片、大图切换、重启后登录以及 Codex 同会话继续。Antigravity 的地域限制作为外部运行失败保留。

提示词与模型选择更新的验收：30 项后台测试（含真实 Caddy 与资料库校验器）和 3 项浏览器测试通过。公网手机页面验证真实模型列表、强度限制、预览失效和页面宽度；真实 Codex 两轮澄清任务使用同一会话，依次选择 `gpt-6.1-sol / low` 与 `gpt-6-luna / medium`，均按工作区规则写出正确轮次交接。

CLI 调用依据已核对的 [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)、[Qoder 脚本模式](https://docs.qoder.com/cli/run-in-scripts) 与 [Antigravity 非交互模式](https://antigravity.google/docs/cli/headless/)。没有云平台 HTTPS 代理且直接使用公网 IP 时，需要另行配置公网验证及可信 IP 证书；[Certbot 的 IP 证书支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) 不适用于当前只有 SSH 端口映射的入口。

AionUi 接入的开发验收：干净 `npm ci` 和完整构建成功；7 项 ACP 测试、40 项后台测试（2 项依赖外部环境跳过）、4 项 Chromium/WebKit 练习界面测试及 19 项原移动单元测试通过。新增测试覆盖权限模式、取消/超时、历史回放、SSE 续读、中文输入法确认、延迟请求和保留新输入。临时工作区中的真实 Codex 两轮恢复同一会话，第二轮准确返回第一轮记住的测试词；未改个人学习记录。此记录是本地开发验收，不表示已更新线上部署。

## AionUi 上线记录（2026-10-10）

初次 AionUi 发布目录为 `/srv/jlpt/releases/20261010T153616Z-aionui`。旧目录、旧 Caddy 配置及 SQLite 一致性备份保存在该发布目录的 `backup/` 中，权限为 700。原有密码配置、登录状态、3 个任务、1 份试卷及学习 worktree 保留。现行版本见下面的直接发送更新记录。

上线前 40 项后台测试含真实 Caddy 与原资料校验器全部通过。公网 Chromium 桌面与 WebKit 手机检查通过登录门禁、聊天资源、历史及认证 SSE，页面无脚本错误。与生产服务相同的 systemd 权限设置下，真实 Codex 完成临时工作区工具写入并恢复同一会话的第二轮。

Caddy 样式策略已同步允许 Arco/React 内联样式，脚本仍限制本站。静态构建脚本显式设置目录 755、文件 644，避免部署时继承严格 umask 后 Caddy 无法读取。新发布的父目录允许路径遍历，状态目录及回滚备份仍保持私有权限。

## 直接发送更新（2026-10-10）

直接发送更新的发布目录为 `/srv/jlpt/releases/20261010T161438Z-direct-send`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 均已切换至该版本。聊天框内的模型和推理强度直接复用 AionUi `AcpConfigSelector`，发送原文不再附加 skill 指令或要求预览；引用先插入可编辑输入框。发送中的新草稿、中文输入法确认、网络失败重试去重和停止请求有浏览器覆盖。

源码独立构建、40 项后台测试和 6 项浏览器测试全部通过。公网 Chromium 桌面和 WebKit 手机验证真实模型／强度下拉菜单、无预览控件、历史、认证 SSE 及窄屏布局，均无页面脚本错误；生产后台原文保留也已核对。保留 3 个任务、1 份试卷及全部原有配置。

本次依赖清单和锁文件与先前上线版本逐字节一致，复制了此前验证过的完整依赖安装。小内存环境下安装依赖和浏览器测试应顺序执行。发布目录需显式 `chmod 711`，仅传入 `mkdir` 的模式仍会受严格 umask 影响；`backup/` 保持 700。

CLI 切换后的历史筛选目前仅为推荐方案，本次保留全部历史展示。已有对话固定 CLI，新建对话后可切换。

## 主题与智能体验证更新（2026-10-10）

智能体选择使用与 AionUi 相同的 Arco 组件并匹配深色页面；聊天框移除出卷／判卷选择，聚焦时隐藏占位文字及内部下划线。模型与推理强度继续在聊天框设置。

运行诊断提供“刷新诊断”：服务通过既有真实聊天通道，在临时目录中逐个发送随机验证文本，收到对应助手回复且进程成功结束才标记可用。登录状态或已安装不足以通过验证。选择列表只包含已验证可用的 CLI；失败原因及检查时间显示在诊断区。结果缓存至手动刷新或服务重启，验证默认模型不代表每一个模型均可用。刷新会立即撤下旧选项，网络响应丢失时重新读取服务器状态，保留输入草稿。

本次构建成功；46 项后台测试（含真实 Caddy 和资料校验器）及 8 项浏览器测试全部通过。浏览器新增覆盖深色下拉框、选项过滤、聚焦样式及刷新响应丢失恢复。

发布目录为 `/srv/jlpt/releases/20261010T165715Z-cli-health`，app/static 已原子切换，保留 3 个任务、1 份试卷、配置和学习 worktree。公网刷新诊断的真实验证结果：Codex、Qoder 均成功回复随机验证文本；Antigravity 返回地域限制错误，因此不在智能体选择列表。公网 Chromium 桌面、WebKit 手机通过登录门禁、历史、SSE、深色选择列表、输入聚焦样式、诊断刷新按钮和窄屏检查，无页面脚本错误。

## 对话归档更新（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-archive`，app/static 已切换至该版本。历史对话提供“归档”、撤销和“已归档”列表中的恢复入口。归档时间保存在原任务记录的 `archived_at` 字段，刷新或换设备后保持；CLI 会话、消息、试卷、作答、成绩和学习文件均保留。归档对话仍可查看，恢复后可继续发送。

排队、运行、检查产物或提交中的任务不能归档。归档与继续发送、重试提交的互斥检查在数据库事务内执行；前端忽略归档前发出的旧列表响应，防止延迟刷新覆盖归档结果。输入框已彻底移除提示文本，用户消息使用深灰圆角框。

验证：61 项服务端测试运行成功（2 项按环境条件跳过）、7 项智能体测试和14 项浏览器测试通过；最终消息流调整后重跑3项归档浏览器测试通过。公网 Chromium 桌面及 WebKit 手机实测归档、撤销、刷新后归档状态和恢复，核对原7个任务、CLI 会话、消息及试卷均保持原样。实测结束后恢复测试对话。

上一版本路径记录在发布目录的 `previous-release.txt`；发布前 SQLite 一致性备份位于私有 `backup/state.sqlite`。恢复旧程序版本只需切回 app/static 并重启服务；归档字段不影响旧版本读取原任务记录。

## 对话历史样式更新（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-history`，app/static 已切换。历史按浏览器本地日期分组为今天、昨天和具体日期，并仅显示当前选择的 CLI。标题取用户第一条消息的简短摘要，新对话保存在任务记录中，旧对话从最早消息或已执行的原始预览推导；继续对话不会替换标题。

有实际试卷关联的对话显示文件图标。桌面悬停或键盘聚焦时显示右侧三点按钮，点击打开归档／恢复菜单；手机直接显示三点按钮。菜单位置限制在视口内，支持 Escape 和外部点击关闭，轮询刷新时保持已打开的菜单。

构建成功；69 项服务端测试运行成功（2 项按环境条件跳过），7 项智能体测试、16 项浏览器测试通过；发布副本中的26项服务端验证通过。新增回归覆盖日期边界、CLI 筛选、试卷图标、菜单和旧对话原始标题来源。

公网 Chromium 桌面与 WebKit 手机验证日期分组、原消息摘要、CLI 切换后的筛选、试卷文件图标、三点菜单和窄屏布局，页面无脚本错误。手机实测归档后刷新仍保留状态，再通过菜单恢复，核对原任务、消息和试卷内容保持原样。发布前 SQLite 备份在私有 `backup/state.sqlite`，旧发布路径保留在 `previous-release.txt`。

## 消息时间常驻显示（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-message-time`，app/static 已切换。用户消息和模型文字回复的时间不再使用悬停显隐样式，始终在消息下方显示；保留原有时间格式和模型工作时长。记录了该 AionUi 组件的适配说明和源码校验值。

构建成功，16 项浏览器测试全部通过。修改前公网 Chromium 桌面及 WebKit 手机均复现时间透明度为0；新版本公网实测双方时间透明度均为1，鼠标移入、移出保持可见，页面无脚本错误或横向溢出。此次服务端源码逐字节一致，发布未重启服务。旧发布路径及 SQLite 一致性备份保存在发布目录内。


## SSE 展示及判分流程更新（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-sse-display`，app/static 已切换并重启后台，Caddy 配置保持原样。工具、思考与文字之间的消息分段按事件顺序展示，最终回答位于对应处理过程之后。对话完成后直接记录 CLI 结果，不再执行网页交接、产物校验、判分一致性校验或自动追加历史与提交；实际运行错误继续显示。

新发布依赖目录使用独立真实目录，以硬链接复用相同包文件，避免旧共享目录布局导致构建工具无法解析包路径。与原静态版本逐文件核对，仅聊天脚本和判卷说明变化；960 张课程图片继续复用原文件。

发布副本的 79 项后台测试通过（1 项资料库集成测试按环境条件跳过），8 项智能体测试通过。公网 Chromium 桌面与 WebKit 手机验证 HTTPS、认证门禁、聊天脚本版本、原对话历史、工具步骤顺序及展开、错误展示和窄屏布局，均无页面脚本错误。展示验证的测试事件仅写入临时浏览器状态，不新增正式对话或学习记录。

部署前后核对 SQLite 的 32 条记录、1868 条事件及 35 个登录会话，内容保持一致；学习 worktree 的提交及工作区状态保持一致。备份保存在私有 `backup/`，回滚路径为原应用 `/srv/jlpt/releases/20261011-message-time/app` 与原静态资源 `/srv/jlpt/releases/20261011-readable-core/static`，同时记录在 `previous-release.txt`。

## 已有试卷报告入口修复（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-report-discovery`，app/static 已切换并重启后台。停止旧版 handoff 流程后，已有试卷的新报告未登记到网页数据库，导致报告文件存在但右侧入口缺失。本次在读取试卷列表、试卷详情和报告时发现标准路径中的文件，也保留旧记录中的报告路径；文件存在即提供入口，不读取分数、不核对逐题判定、不改写任务或学习文件。右侧显示“报告已生成”，SSE 任务完成后自动刷新报告入口。新出卷的自动登记仍不在此次修复范围内。

发布副本的82项后台测试通过（1项资料库集成测试按环境条件跳过），8项智能体测试及21项浏览器测试通过。新增回归覆盖无判卷收据时的报告展示、矛盾分数原文展示、文件删除、符号链接拒绝、旧报告路径和缺失路径回退。报告入口刷新测试的等待时间小于定时轮询周期，覆盖 SSE 完成后的刷新。

公网 Chromium 桌面和 WebKit 手机均已实际打开 N1 第21–30条报告，核对网页文本与工作区文件逐字一致，无页面脚本错误和横向溢出。SQLite 的34条记录、2450条事件及35个登录会话在发布及浏览器验证后保持一致；学习 worktree 的 HEAD、状态、已跟踪修改、报告内容和作答历史保持一致。临时验证会话已删除，备份位于私有 `backup/`；回滚 app/static 路径均为 `/srv/jlpt/releases/20261011-sse-display/` 下对应目录。

## 配套报告入口与 Markdown 阅读（2026-10-11）

发布目录为 `/srv/jlpt/releases/20261011-paired-reports`，app/static 已切换；此次仅变更前端资源，后台代码逐文件一致，服务持续运行。试卷列表按 ID 分组，在组标题下并列展示试卷和成绩报告入口。直接打开报告仅请求报告接口，不先加载试卷；报告复用已有 Markdown 组件，在独立滚动区域展示标题、表格、列表、加粗及安全链接。配套试卷和答案链接打开面板中的对应内容。

返回列表和切换配套产物时记住每份内容的滚动位置，切换前保存草稿。报告与试卷请求使用导航序号，取消或较晚返回的响应不会覆盖当前内容或打开其他试卷的答案。打开内容时将键盘焦点移入阅读区域，返回时恢复到对应入口，定时列表刷新保留按钮焦点。

82项后台测试通过（发布副本含真实 Caddy，1项资料库集成测试按环境条件跳过），8项智能体测试和21项浏览器测试通过。回归覆盖直接报告访问、Markdown 表格及危险 HTML/链接处理、重复配套链接、取消答案导航、草稿和滚动位置保存、焦点恢复。公网 Chromium 桌面及 WebKit 手机实际打开 N1 第21–30条报告，验证并列入口、Markdown 渲染、阅读位置恢复和反复切换配套试卷，无脚本错误或横向溢出。

发布和公网验证后的34条记录、2450条事件及35个登录会话保持一致；报告、作答历史与学习工作区保持一致。静态资源仅变更 `practice.html`、`practice.mjs`，新增 `artifacts.css`。备份和验证截图保存在私有 `backup/`，临时验证会话已删除。回滚路径为 `/srv/jlpt/releases/20261011-report-discovery/` 下的 app/static，记录在 `previous-release.txt`。

## 出卷产物登记与 Codex 默认设置修复（2026-10-12）

发布目录为 `/srv/jlpt/releases/20261012-paper-artifacts-defaults`，app/static 已切换并重启后台。每轮 CLI 完成后，网页比较标准试卷文件及最终清单的变化，自动登记本轮生成的试卷并关联对话，无需旧交接文件。可用清单提供在线作答；只有 Markdown 时仍显示原文，后续同一对话补齐清单可转为在线作答。答案文件后来补齐时也会显示入口。已有可作答试卷不被同名成果覆盖，草稿、正式交卷和历史记录保留；判分与学习历史仍由智能体处理。

首次进入、新建对话和切回 Codex 时，默认模型为可见模型列表第一项，默认思考强度为该模型支持的 `high`。当前服务器实测为 `gpt-6.1-sol / high`。已有对话及用户主动修改的配置保留，模型元数据延迟返回不覆盖已选操作。

验证：构建成功，87 项后端测试通过（2 项因外部环境条件跳过），9 项智能体测试、23 项 Chromium/WebKit 浏览器测试全部通过。新增生成测试经实际 Worker 登记，再验证页面试卷入口、答案入口、Markdown 原文及刷新后的草稿。发布后通过本机 Caddy 的 Chromium 桌面和 WebKit 手机检查实际默认设置与既有试卷入口，无页面脚本错误或横向溢出。11 个任务、1 份既有试卷、24 条预览的数据库记录与发布前逐字节一致。发布前 SQLite 备份位于私有 `backup/state.sqlite`，上一版本路径记录在 `previous-release.txt`。

### 补登记修复前已生成的 41–50 试卷（2026-10-12）

用户指出既有 N1 第41–50课试卷仍缺少入口。核对发布前 SQLite 备份，生成对话 `b1c60e52-5be6-44ee-9fe7-c42549a1d276` 已完成，试卷、答案及清单均已落盘，但当时未登记。此前修复只覆盖后续生成，没有补登记这份成果。

已从原文件补登记 `2026-10-12-n1-41-50-test-1` 的10道题并关联原对话，未重新生成题目或更改对话状态、CLI会话、消息、已有试卷和作答。变更前备份为发布目录下的私有 `backup/missing-41-50-before.sqlite`。本机 Caddy 的 Chromium 与 WebKit 实测产物列表、10道在线题目、配套答案与原对话文件图标均可用。

## 试卷与报告独立阅读区域（2026-10-12）

发布目录为 `/srv/jlpt/releases/20261012-artifact-reader`，app/static 已切换。后端源码保持一致，现有后台进程继续运行，未重启。产物列表与阅读内容改为切换显示：打开试卷、Markdown 原文或成绩报告时隐藏列表及列表页底部说明，内容占满面板剩余高度；通过“返回列表”恢复入口和列表位置。保留草稿保存、内容阅读位置、配套试卷/答案跳转及焦点恢复。

23 项浏览器测试全部通过，87 项后端测试通过（2 项按外部环境条件跳过），9 项智能体测试通过。发布后通过本机 Caddy 实测 Chromium 桌面与 WebKit 手机：41–50试卷10道题及已有成绩报告均可打开，阅读内容分别占面板92%和90%，列表与底部说明不占阅读空间；返回列表和报告阅读位置恢复正常，无页面脚本错误或横向溢出。任务、试卷和草稿记录与更新前一致。更新前 SQLite 备份位于私有 `backup/state.sqlite`，上一版本路径保存在 `previous-release.txt`。

## 隐藏思考消息与思考计时（2026-10-12）

发布目录为 `/srv/jlpt/releases/20261012-chat-no-thinking`，app/static 已切换，现有后台进程继续运行。聊天事件映射跳过 `thinking` 消息，不再展示“思考中”“思考完成”及该组件的计时；工具调用和文字输出保持原有顺序，既有对话回放也使用相同规则。整轮工作时长沿用原有显示。后台持久事件未删除或修改。

构建成功，9 项智能体测试、87 项后端测试（2 项按环境条件跳过）和23项 Chromium/WebKit 浏览器测试全部通过。新增断言覆盖流式思考事件到达时和历史回放时均不产生思考行，工具步骤和最终文字仍保留。发布后通过本机 Caddy 在 Chromium 和 WebKit 打开实际51–60出卷对话，确认思考行数量为0，工具步骤和文字输出正常，无页面脚本错误。任务、试卷、草稿及全部持久事件与更新前一致。回滚路径保存在 `previous-release.txt`，私有 SQLite 备份位于 `backup/state.sqlite`。

## Codex 运行中直接发送补充消息（2026-10-12）

发布目录为 `/srv/jlpt/releases/20261012-codex-live-input`，app/static 已切换并重启后台。仅支持实时输入的 Codex ACP 会话开启此功能，Qoder、Antigravity 以及旧 exec 通道保持原发送行为。Codex 执行过程中输入新消息时显示发送按钮，空白输入显示停止按钮；新消息经同一连接直接进入当前 Codex 轮次，收到实际送达确认后显示“补充指令已送达”。当前会话、模型、强度和轮次保持。不会暂停、重启、另开一轮或安排下一轮排队。

HTTP 接口校验登录、请求来源、任务身份及运行状态；按发送编号去重，并保留用户原文。发送期间继续编辑的草稿、切换对话及网络响应丢失后的重试均有覆盖。任务尚未就绪或已经结束时明确拒绝实时发送并保留草稿。版本校验的兼容补丁限定 ACP steering 的 activeOnly 行为，防止结束边界启动额外轮次；停止或连接结束会结算未确认消息，旧消息记录保留。

验证：构建成功，17 项智能体测试、94 项后端测试（2 项按外部环境条件跳过）通过；完整28项 Chromium/WebKit 浏览器测试通过，修复收尾竞争后重测5项实时输入浏览器测试全部通过。隔离临时目录中的真实 `gpt-6.1-sol` 在工具执行期间确认接收补充消息，随后按新的最终回复要求完成，同一进程及会话未重启，耗时29.5秒。发布后本机 Caddy 的 Chromium 桌面与 WebKit 手机核对 Codex 专用发送门禁、停止按钮及其他CLI限制，已结束任务的实际接口返回409，无页面脚本错误。12个任务、3份试卷、28条预览及全部原有持久事件与发布前一致。私有备份位于 `backup/state.sqlite`，上一版本路径记录在 `previous-release.txt`。


## N1 第77卡语法图片修复（2026-10-13）

资料修复提交为 `7e762bbdce4da91233f7c9c39b777781dcf20618`。第77卡「～ばこそ」的接续图原为例句页，现替换为原视频1:35的语法板书，图片为1340×840；卡片同步更正截图时间及裁切记录，核心与例句图保持原样。

服务器静态发布目录为 `/srv/jlpt/releases/20261013-n1-77-grammar-image/static`，仅切换 `/srv/jlpt/static`。目录与960张图片固定到新资料提交，图片URL和手机缓存键随版本变化；保留旧图片URL供尚未刷新页面使用。应用与运行中任务不变，无服务重启。源 `data/catalog.json` 同步更新，Cloudflare站点未发布。回滚静态路径记录于该发布目录的 `previous-release.txt`，无需回滚应用。

卡片机械检查、全库图片链接检查及资料版本缓存隔离测试通过。实际公网HTTPS返回的新图片与修复文件逐字节一致；WebKit手机模拟验证已有旧缓存后刷新会加载新语法图，例句图仍为1895×1030，阅读位置可继续，页面无脚本错误。公网手机截图与验证记录保存在发布目录，临时验证登录均已退出。手机刷新或重新打开网站即可读取新目录。

## 界面重新设计：紺色与山吹金（2026-10-14）

服务器静态发布目录为 `/srv/jlpt/releases/20261014-yamabuki-redesign/static`，仅切换 `/srv/jlpt/static`。应用代码与线上 `/srv/jlpt/releases/20261012-codex-live-input/app` 逐文件一致，服务未重启，任务与数据库未改动。与上一静态版本相比仅 7 个样式及页面文件变化（`site.css`、`chat.css`、`artifacts.css`、`login.html`、`practice.html`、`grammar/index.html`、`grammar/styles.css`），脚本、目录及 960 张图片不变（图片为硬链接）。Cloudflare 站点未发布。

语法记忆与智能体练习统一使用紺色底与山吹金强调色；首页标题竖排，快捷区间对齐各自输入框，练习页三栏标题同高，试卷选项整行可选。元素 id、链接文字与交互逻辑不变。

验证：构建成功；94 项后端测试（2 项按环境条件跳过）、17 项智能体测试、21 项移动单元测试、28 项练习浏览器测试与 27 项语法浏览器测试通过。公网 HTTPS 以 Chromium 桌面与 WebKit 手机登录，检查语法首页竖排标题、阅读页实际图片、练习页历史与产物列表，无页面脚本错误及横向溢出，验证后已退出登录。回滚静态路径记录于发布目录的 `previous-release.txt`。

### 改为墨灰底色并统一标题字体（2026-10-14）

用户认为蓝色底色带有 AI 感，且标题衬线与非衬线混用。底色改为中性墨灰（`#181818`／`#212121`），保留山吹金强调色；所有标题改用与正文相同的非衬线字体，练习页不再被 Arco 的 Inter 字体栈覆盖，登录、语法及练习页字体栈一致。

发布目录为 `/srv/jlpt/releases/20261014-sumi-fonts/static`，仅切换 `/srv/jlpt/static`，应用代码不变、服务未重启。相对上一版本仅 `site.css`、`chat.css`、`grammar/styles.css`、`grammar/index.html` 变化。全部测试套件通过（同上一节）。公网 Chromium 桌面与 WebKit 手机登录验证底色、标题字体、历史与产物列表，无脚本错误及横向溢出，验证后已退出。回滚路径见 `previous-release.txt`（即上一节的发布目录）。

### 移除“云端开发”入口与 code-server（2026-10-14）

语法页导航只保留“智能体练习”，`/code/` 不再转发，未登录时与其他页面一样跳转登录页。已停用并卸载 `code-server@root`（释放约 718 MB），删除 `/etc/caddy/code-server.caddy`、其配置与数据目录；Caddyfile 与 code-server 配置的删除前副本在 root-only 的 `/var/backups/remove-code-server-20261014T182751Z/`。

发布目录为 `/srv/jlpt/releases/20261014-remove-code-server/static`，由上一版本硬链接复制，仅 `grammar/index.html`、`grammar/styles.css` 变化；仅切换 `/srv/jlpt/static`，应用代码不变、服务未重启。同时删除了不再作为回滚目标的旧发布目录。回滚路径见 `previous-release.txt`。

### 移除智能体练习（2026-10-14）

智能体练习（`/practice.html`）及其全部代码已删除：`chat/`、`agent/`、`vendor/aionui/`、`scripts/build-chat.mjs`，服务端的任务队列、ACP/CLI 执行器、模型与健康检查（`worker`、`acp`、`cli`、`models`、`health` 等模块）及相应测试。服务端现在只负责登录、静态页面和试卷作答接口；`Store` 只保留登录会话表，旧数据库中的任务表保持原样，不再读写。npm 依赖只剩构建核心 Markdown 所需的 React、react-markdown 和 esbuild，`node_modules` 从约 1.1 GB 降到约 37 MB。删除前的源码打包在 `/var/backups/agent-practice-20261014T201057Z.tar.gz`。下文较早的智能体练习记录仅作历史参考。

### 网页作答试卷（2026-10-14）

语法页导航为“做题”（`/papers.html`）和“云开发”（`/code/`），原“智能体练习”入口已移除（`/practice.html` 仍可直接访问）。出题和判卷都由 Claude 在云开发中完成（项目选 `jlpt-study/.worktrees/web-study`，即配置中的 `study`），网页只渲染试卷并写入作答：

- 列表只显示最近生成的 20 份试卷，最新的在最上面，交过答案的标“已提交”。
- 试卷 md 原样渲染（不显示成绩报告）。选项整行是可点的长方块；题干含 ★ 的排序题按句子顺序依次点选，块上显示①②③④，下方显示语序（如 `2 → 4 → 1 → 3`）。每题标题右侧有“不确定”开关。作答草稿存在浏览器本地。
- 提交时只改写试卷末尾 `## 答案填写区` 中的 `N-__`，格式与 quiz-grade 读取的一致（`N-答案`，不确定为 `*N-答案`），其余内容逐字保留；之后页面给出判卷指令和“打开云开发”。每次提交整张覆盖。已有 `results/<试卷名>-result.md` 的试卷拒绝提交。网页不做 git 提交。

接口为 `GET /api/quiz/papers`、`GET /api/quiz/papers/<slug>`、`POST /api/quiz/papers/<slug>/answers`（需要登录和同源 Origin），实现在 `server/papers.py`。当前发布目录为 `/srv/jlpt/releases/20261014-paper-blocks`（app 与 static 均已切换，已重启 `jlpt.service`，切换前确认无运行中任务）。服务端、智能体、移动端和浏览器测试全部通过。

### 云端 Claude Code（CloudCLI，2026-10-14）

`/code/` 现在是 [CloudCLI](https://github.com/siteboon/claudecodeui) 1.37.4（AGPL-3.0），用于手机或平板操作服务器上的 Claude Code：粘贴图片和上传附件、历史会话（读取 `~/.claude/projects`）、文件树和 git 面板（暂存、提交、切换分支）。它使用 `claude /login` 的 Pro 订阅登录，服务里清除了 `ANTHROPIC_API_KEY`，避免改为按 token 计费。

- 程序安装在 `/srv/cloudcli`（约 1.3 GB），服务为 `cloudcli.service`，监听 `127.0.0.1:3001`，`MemoryHigh=1G`、`MemoryMax=1400M`。数据库在 `/root/.cloudcli`。
- 访问需先通过网站登录（Caddy `forward_auth`），再登录 CloudCLI 自己的单用户账号。首个访问者会创建该账号。
- CloudCLI 只支持挂在根路径。`deploy/cloudcli/patch-subpath.mjs` 在每次服务启动前修改其前端，并注入 `subpath-shim.js`：设置路由前缀，把 API、WebSocket、service worker 的根路径改为 `/code/...`。`<img>` 等无法改写的根路径请求，由 Caddy 按 `Referer` 含 `/code/` 转给 CloudCLI。补丁固定校验版本 1.37.4，升级后服务会拒绝启动，需重新核对补丁。
- 页面右上角（手机为标题栏下方）显示订阅额度：5 小时和每周窗口的已用百分比，点开可看重置时间。数据来自 `cloudcli-quota.service`（`deploy/cloudcli/quota.py`，`127.0.0.1:3003`），读取 Claude 官方 OAuth usage 接口，缓存 60 秒，不刷新令牌。
- 部署文件在 `deploy/cloudcli/`，对应安装位置：`/srv/cloudcli/`（补丁、shim、quota.py）、`/etc/systemd/system/`（两个服务）、`/etc/caddy/cloudcli.caddy` 和 `cloudcli-proxy.caddy`（Caddy 2.6 的 import 参数写作 `{args.0}`）。Caddyfile 修改前的副本在 `/var/backups/add-cloudcli-*`。
- 手机尺寸已验证：创建账号、项目列表、git 面板、粘贴图片后 Claude 能读取图片并回复、额度显示。
- 新建项目只能放在 `/root/projects` 下：服务设置 `WORKSPACES_ROOT=/root/projects`，同一个启动补丁去掉了 CloudCLI 对 `/root` 的整体禁止（它以 root 运行，原规则会拒绝整个 `/root/projects`）。`/root` 本身、`/root/.ssh` 以及 `/etc` 等系统目录仍被拒绝。2026-10-15 已从 CloudCLI 数据库清理已不存在的临时项目和 Codex 会话，删除前副本在 `/var/backups/cloudcli-cleanup-20261015T034156Z/`。

### 对话页状态栏与体验优化（2026-10-14）

发布目录为 `/srv/jlpt/releases/20261014-chat-status-ux/static`，仅切换 `/srv/jlpt/static`，应用代码不变、服务未重启，任务与数据库未改动。相对上一版本仅 `chat.css`、`chat.mjs`、`practice.html`、`practice.mjs`、`site.css` 变化，960 张图片为硬链接。

输入框上方合并为一行状态栏：运行中计时固定在最左侧（如“工作中 3 分 26 秒”），其后是状态、最近一条思考或工具步骤，以及“恢复对话 / 重新验证 / 重试保存成绩”中当前需要的操作；完成后的“工作时间”只显示在最后一条回复页脚。时长统一为分钟和秒的组合。删除重复的“停止任务”和手动“刷新”按钮（窗口重新获得焦点时立即刷新，另有 10 秒定时刷新）。输入框占位文字说明无法发送的原因；本对话的试卷以卡片固定在输入框上方，面板收起时新产物在切换按钮上显示圆点。提示分为不自动消失的错误和 4 秒后消失的普通提示。状态文字不再出现“本地提交”，提交号移到运行诊断。已有对话的智能体显示为可点击说明的锁定标签。导出对话按实际智能体命名。页面随系统切换深浅色（登录页、首页与练习页；语法阅读页仍为深色）。

验证：20 项智能体测试、94 项后端测试（2 项按环境条件跳过）与 31 项 Chromium/WebKit 浏览器测试通过。公网 HTTPS 以 Chromium 桌面（深色）与 WebKit 手机（浅色）登录，确认新状态栏、计时位置、实际对话的“工作时间 8 分 4 秒”等格式，无页面脚本错误及横向溢出，验证后已退出登录。回滚路径见 `previous-release.txt`。

### 运行计时移到消息流下方（2026-10-14）

发布目录为 `/srv/jlpt/releases/20261014-chat-working-line/static`，仅切换 `/srv/jlpt/static`，应用代码不变、服务未重启。相对上一版本仅 `chat.css`、`chat.mjs`、`practice.html` 变化。运行中的“工作中 X 分 Y 秒”及当前思考或工具步骤固定在消息流正下方，与消息列（最宽 780px）左对齐，不随消息滚动；完成后该行消失，最后一条回复页脚显示总工作时间。状态栏只保留状态、操作与快捷键提示。

验证：20 项智能体测试通过；31 项浏览器测试中 30 项一次通过，“配套报告在 SSE 完成后打开”的 Chromium 用例在整套运行中失败一次，单独重跑 8 次均通过。新增断言检查运行行与消息列对齐且位于消息区与输入框之间。公网 Chromium 桌面与 WebKit 手机登录确认新布局与“工作时间 7 分 31 秒”，无脚本错误及横向溢出；发布时没有运行中的对话，运行行未在线上实测。回滚路径见 `previous-release.txt`。

## 新增 Claude Code 智能体（2026-10-14）

发布目录为 `/srv/jlpt/releases/20261014-claude-agent`，app/static 已切换并重启后台（切换前确认无运行中对话）。新增依赖 `@agentclientprotocol/claude-agent-acp@0.90.0`，构建时打包为单文件 `agent/dist/claude-acp.mjs`，通过 `CLAUDE_CODE_EXECUTABLE` 使用服务器已登录的 `claude`；SDK 附带的 246 MB 原生程序不在运行时使用。新共享 `node_modules/0f3d199ce5b3dd23` 以硬链接创建，几乎不占额外空间。

Claude Code 只走 ACP，以 `bypassPermissions` 运行（root 需 `IS_SANDBOX=1`），与 Antigravity、Qoder 一样拥有完整权限：Claude 自带的 bubblewrap 沙箱在 Ubuntu 24.04 的 AppArmor 用户命名空间限制下无法启动，为其安装的 bubblewrap/socat 已卸载，主机安全设置未改。登录状态取自 `claude auth status`；模型与推理强度来自真实对话验证时 ACP 会话报告的选项。

运行中补充指令：适配器实现了与 Codex 相同的 `_session/steering`，并在初始化时声明支持。适配器在空闲时默认会另开一轮，因此请求附带 `_meta.steering.idleBehavior: "promptRequired"`，空闲时返回 `promptRequired`，网页显示为未送达。Claude 收到补充指令会立即打断当前步骤，进行中的命令可能转入后台。vendored `AcpConnection` 同时改为向自定义启动的智能体发送绝对路径 cwd（Claude 拒绝相对路径）。

验证：23 项智能体测试、98 项后端测试（2 项按环境条件跳过）、31 项浏览器测试通过。真实 Claude（Haiku）在命令执行中第 7 秒收到补充指令，返回 injected 并在最终回复中遵循；同一会话续聊正确记得该指令。上线后后台真实对话验证 Claude 通过，公网 Chromium 确认选择器出现 Claude Code 与模型列表，无脚本错误。Codex 此次验证未通过：`~/.codex/config.toml` 的默认模型 `gpt-6.1-sol` 已被账号端停用，与本次改动无关（新旧 runner 结果一致）。SQLite 备份位于发布目录私有 `backup/state.sqlite`，回滚路径见 `previous-release.txt`。

## 语法联想网复习入口（2026-10-17）

发布目录为 `/srv/jlpt/releases/20261017-review-plan`，app 与 static 均已切换并重启 `jlpt.service`（由 `scripts/prepare_release.py --name 20261017-review-plan` 准备，`node scripts/build-server.mjs` 构建 static）。上线前先把线上运行的工作区原样提交为基线（`9595e18`；`docs/password-sync-2026-10-13.md` 含账号复用说明，按学习者决定加入 `.gitignore`，不进公开仓库）。

- 新页面 `/review/`（今日安排）：登录后与打开首页默认进入。显示轮次与总进度、体系表／功能小组分段进度、当前位置、距下次复习的学习日与全程目录；状态卡片按 `GET /api/review/today` 的状态显示。单元在同一页依次进行回忆（锁定后才返回对比页、成员原卡核心、5 题与造句题）、选择题、造句与备注，交卷后全部锁定；复习卷 12 题作答后交卷。页面不调用智能体，也不显示判分或准备指令。
- 后台 `server/review.py` 按文件路径加载学习仓库的 `src/jlpt_notes/groups.py`（规则唯一实现，按修改时间缓存），接口为 `/api/review/today`、`/api/review/units/<id>`（`/recall`、`/submit`）、`/api/review/reviews/<id>`（`/submit`）与 `/api/review/asset?path=assets/...`（仅 `jlpt-notes/assets/` 下的图片，拒绝 `..`、`.git`、绝对路径与符号链接）。规则拒绝映射为 403／409／400，学习数据损坏返回 500 与含文件路径的中文错误，页面直接显示。
- 登记在 `groups/units/*.json`、`groups/reviews/*.json` 的试卷不再出现在“做题”页，`/api/quiz/papers/<slug>` 读写均为 404。
- 语法记忆页（服务器构建）导航增加「今日安排」；三个链接在手机上单独占一行，避免遮挡标题。Cloudflare 构建（`public/`、`mobile/`、`scripts/build.mjs`）未改。

验证：52 项后端测试（1 项按环境条件跳过）与 9 项 Chromium/WebKit 浏览器测试通过，含 iPhone 13 视口下完整学习一个单元并交卷、无横向溢出。上线后本机 `/review/` 未登录返回 303、`/api/review/today` 返回 401，日志无异常；以真实学习仓库读取状态为 `not_prepared`（117 个单元，尚未准备单元）。学习者手机登录确认默认进入今日安排、语法记忆页链接与“做题”页正常。回滚：按发布目录内 `previous-release.txt`（app=`/srv/jlpt/releases/20261014-remove-agent-practice/app`，static=`/srv/jlpt/releases/20261015-dark-papers/static`）切回链接并重启 `jlpt.service`。

### 今日安排阶段进度与主屏幕图标（2026-10-17）

发布目录为 `/srv/jlpt/releases/20261017-review-progress/static`，仅切换 `/srv/jlpt/static`，后台代码不变、服务未重启（app 仍为 `20261017-review-plan`）。按学习者手机试用后的意见修改：

- 进度区改为阶段进度条：基础体系表与 6 个最上位类按单元数比例分段，▼ 标出当前单元；条下列出各阶段“已学/总数”（当前阶段高亮、学完打 ✓）与“下一个节点：学完…（还差 n 个单元）”。全程目录按阶段折叠，显示小进度条与阶段状态（已完成／当前阶段／进行中／未开始／待整理），当前阶段默认展开、当前单元高亮。数据全部来自 `/api/review/today`。
- 主屏幕图标：iOS 主屏幕图标固定打开添加时的地址，原图标从语法记忆添加，启动时停在 `/grammar/`。新增 `launch-home.js`（服务器构建注入语法记忆页，并由 `/review/` 引用）：以主屏幕应用启动且是本次启动的第一个页面时跳到 `/review/`，之后点「语法记忆」照常打开；普通浏览器不受影响。`/review/` 也加了主屏幕应用的 meta，从今日安排重新添加的图标直接从这里启动。
- 修复状态卡片没有按钮时（如“尚未准备”）末尾显示 “null”。

验证：52 项后端测试（1 项按环境条件跳过）与 11 项浏览器测试通过，新增模拟主屏幕启动、阶段进度条与目录在学一个单元前后的检查，以及状态卡片完整文字断言；本机以真实学习仓库只读预览 117 个单元的进度条与目录，iPhone 13 视口无横向溢出。上线后 `/review/` 未登录 303、日志无异常。回滚：把 `/srv/jlpt/static` 切回 `/srv/jlpt/releases/20261017-review-plan/static`（见 `previous-release.txt`）。

### 回忆环节改为遮挡核对（2026-10-17）

发布目录为 `/srv/jlpt/releases/20261017-recall-check`，app 与 static 均已切换并重启 `jlpt.service`。学习仓库同时把 `recall-check` 分支快进合并到 main（合并前 `be6f037`），线上随即加载新的 `groups.py`。设计见学习仓库 `docs/superpowers/specs/2026-10-16-grammar-network-review-design.md` 的 2026-10-17 修订。

- 单元第 1 步由打字回忆改为“回忆核对”：只显示范围与“共 n 项”，各行默认遮住，点「点击显示」后显示“日语形式 ― 中文用法关键词”；每行默认算想到，没想到的点「没想到」（`aria-pressed`，再点撤回）。点开与标记暂存在浏览器（`review:<单元>:recall`，行号按当前行数截断），「进入对比页」随时可点，锁定后各行只读展开。
- 内容来自单元材料新增的 `recall_items`（`card`、`form`、`usage`）。`GET /api/review/units/<id>` 的 `recall` 改为 `{"items":[{form,usage}],"missed":null|[行号]}`；`POST …/recall` 请求体改为 `{"missed":[行号]}`，行号非整数、重复或越界返回 400；交卷文件写入服务器生成的 `recall.marks`。

验证：55 项后端测试（1 项按环境条件跳过）与 12 项 Chromium/WebKit 浏览器测试通过（含中途刷新恢复、过期草稿截断、按钮触控高度 ≥44px）；学习仓库 534 项测试通过，`validate-groups`、`validate-links` 通过。上线后 `/review/` 未登录 303、`/api/review/today` 401、日志无异常；以线上代码只读读取 B-01-1，锁定前只返回 6 行与状态。回滚：按 `previous-release.txt`（app=`/srv/jlpt/releases/20261017-review-plan/app`，static=`/srv/jlpt/releases/20261017-review-progress/static`）切回并重启，同时 `git -C /root/projects/jlpt-study checkout be6f037 -- src/jlpt_notes/groups.py` 恢复旧规则模块。

### 回忆核对分组与对比页精简（2026-10-17）

发布目录为 `/srv/jlpt/releases/20261017-recall-groups`，app 与 static 均已切换并重启 `jlpt.service`；学习仓库规则模块未改（学习仓库提交 `407fb05` 只改校验、出题技能与设计文档）。

- 回忆核对按 `recall_items` 的 `form` 分组：组标题（日语形式）直接显示，组下用法行默认遮住、跨组连续编号，点开只显示中文用法；同一形式的行必须相邻（`validate-groups` 检查）。
- 对比页：单元页正文只留“成员接续图”；网页把每个成员的原卡核心（默认折叠）插到其 `### [卡号 …]` 小节的接续图下，取消页面底部集中的“成员原卡核心”。功能说明、对照表、反义组、最小对立句与易错点不再写入单元页。

验证：55 项后端测试（1 项按环境条件跳过）与 12 项 Chromium/WebKit 浏览器测试通过；学习仓库 535 项测试、`validate-groups`、`validate-links` 通过。上线后 `/review/` 未登录 303、`/api/review/today` 401、日志无异常。回滚：按 `previous-release.txt`（app、static 均为 `/srv/jlpt/releases/20261017-recall-check`）切回并重启。
