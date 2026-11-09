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

`/code/` 现在是 [CloudCLI](https://github.com/siteboon/claudecodeui) 1.37.6（AGPL-3.0，2026-10-28 由 1.37.5 升级），用于手机或平板操作服务器上的 Claude Code：粘贴图片和上传附件、历史会话（读取 `~/.claude/projects`）、文件树和 git 面板（暂存、提交、切换分支）。它使用 `claude /login` 的 Pro 订阅登录，服务里清除了 `ANTHROPIC_API_KEY`，避免改为按 token 计费。

- 程序安装在 `/srv/cloudcli`（约 0.93 GB，已删去用不到的 Codex 原生二进制），服务为 `cloudcli.service`，监听 `127.0.0.1:3001`，`MemoryHigh=1G`、`MemoryMax=1400M`。数据库在 `/root/.cloudcli`。
- 访问需先通过网站登录（Caddy `forward_auth`），再登录 CloudCLI 自己的单用户账号。首个访问者会创建该账号。
- CloudCLI 只支持挂在根路径。`deploy/cloudcli/patch-subpath.mjs` 在每次服务启动前修改其前端，并注入 `subpath-shim.js`：设置路由前缀，把 API、WebSocket、service worker 的根路径改为 `/code/...`。`<img>` 等无法改写的根路径请求，由 Caddy 按 `Referer` 含 `/code/` 转给 CloudCLI。补丁里每处替换都必须恰好匹配 1 次，打包结构变了就会抛错、服务拒绝启动；`VERIFIED` 列出已核对的版本（1.37.4、1.37.5、1.37.6），其他版本只告警。
- 升级用 `deploy/cloudcli/upgrade.sh <版本>`：先在 `/srv/cloudcli-next` 安装、删去 `@openai/codex-linux-x64`（370 MB，`codex`、`codex-sdk` 两个 JS 包启动时会被导入，必须保留）并对其打补丁，补丁失败则线上不受影响；再 `upgrade.sh <版本> --swap` 换目录并重启，健康检查失败自动换回并恢复数据库副本（`/var/backups/cloudcli-db-*`）。旧版留在 `/srv/cloudcli.prev`，确认 `/code/` 正常后手工删除。安装需约 1.3 GB 加 0.9 GB 的临时 npm 缓存（`/tmp/npm-cache-up`，脚本退出时清理），可用空间低于 2.5 GB 时脚本拒绝执行。`package.json` 精确锁定版本，不要在 `/srv/cloudcli` 里直接 `npm install`。
- 页面右上角（手机为标题栏下方）显示订阅额度：5 小时和每周窗口的已用百分比，点开可看重置时间。数据来自 `cloudcli-quota.service`（`deploy/cloudcli/quota.py`，`127.0.0.1:3003`），读取 Claude 官方 OAuth usage 接口，缓存 60 秒，不刷新令牌。
- 部署文件在 `deploy/cloudcli/`，对应安装位置：`/srv/cloudcli/`（补丁、shim、quota.py）、`/etc/systemd/system/`（两个服务）、`/etc/caddy/cloudcli.caddy` 和 `cloudcli-proxy.caddy`（Caddy 2.6 的 import 参数写作 `{args.0}`）。Caddyfile 修改前的副本在 `/var/backups/add-cloudcli-*`。
- 手机尺寸已验证：创建账号、项目列表、git 面板、粘贴图片后 Claude 能读取图片并回复、额度显示。
- 新建项目只能放在 `/root/projects` 下：服务设置 `WORKSPACES_ROOT=/root/projects`，同一个启动补丁去掉了 CloudCLI 对 `/root` 的整体禁止（它以 root 运行，原规则会拒绝整个 `/root/projects`）。`/root` 本身、`/root/.ssh` 以及 `/etc` 等系统目录仍被拒绝。2026-10-15 已从 CloudCLI 数据库清理已不存在的临时项目和 Codex 会话，删除前副本在 `/var/backups/cloudcli-cleanup-20261015T034156Z/`。

### 云开发聊天页滚动跳动修复（2026-10-25）

现象：在 iPhone/iPad 上，Claude 回答完后往回滑，内容会突然跳动，已看过的尾部消息又出现；滑到第一条提问后往下滑偶尔失效。原因：上游给每条消息设了 `content-visibility: auto`，WebKit 先按 180/240px 的估计高度排版屏幕外的消息，进入视口时换成真实高度却不修正滚动位置；回答结束后的刷新会重建消息行，使其丢失已记住的高度，所以刚答完时最明显。上游 `LazyMessageRow` 已卸载远处消息，因此 `subpath-shim.js` 直接把 `.chat-messages-pane .chat-message` 改为 `content-visibility: visible`。

发布：只复制新 shim 到 `/srv/cloudcli/` 并重新执行 `patch-subpath.mjs`（与 `ExecStartPre` 相同，幂等）。`index.html` 每次从磁盘读取且不缓存，因此未重启 `cloudcli.service`，进行中的对话不受影响；`index.html` 只有 shim 的 `?v=` 哈希变化。提交 `03df302`。

验证：用隔离的 CloudCLI 实例（数据库副本、3011 端口）在 WebKit iPhone 13 模拟中从底部每次上滑 200px，滑过一个长会话（约 77 步，含分页加载更早消息）。修复前可见内容累计偏移约 2.4 万 px，约 15 步超过 300px；修复后约 47px，无一步超过 300px。Chromium 修复前约 200px，本就基本正常。上线后本机 3001 返回的 shim 与提交一致，Caddy `/code/` 未登录仍 303 到登录页。“到顶后往下滑失效”在模拟中未能复现，待真机观察。测试时线上 CloudCLI 自动登记了临时项目 `cc-scroll-test`，已删除其项目和会话行，删除前数据库副本在 `/var/backups/cloudcli-db-scrolltest-20261025T150413Z.db`。

回滚：把 `/var/backups/cloudcli-shim-20261025T150643Z/subpath-shim.js` 复制回 `/srv/cloudcli/subpath-shim.js`，再执行 `node /srv/cloudcli/patch-subpath.mjs /srv/cloudcli/node_modules/@cloudcli-ai/cloudcli`（或回退提交后重启 `cloudcli.service`）。

### 云开发聊天页键盘弹出时输入框错位修复（2026-10-26）

现象：在 iPhone/iPad 上点聊天输入框后，有时输入框的底边跑到屏幕最上方，只露出一点；有时完整显示但和输入法之间空出一大段；有时被输入法完全挡住。

原因：上游把工作区外壳设为 `fixed inset-0`，用 `bottom: var(--keyboard-height)` 给键盘让位，该值为 `innerHeight - visualViewport.height`，只在 `visualViewport` 的 `resize` 事件里更新。Safari 不支持 `interactive-widget=resizes-content`，弹键盘时不缩布局视口，还会把可视视口上移 `offsetTop` 来露出输入框，上游没有考虑这一项。输入框底边与键盘上沿的距离 = (所用值 − 真实键盘高度) + `offsetTop`：Safari 抢在 `resize` 之前上移时让位两次，竖屏中文输入法下键盘约占可视高度一半，输入框正好被推到顶上；上移一部分或所用值偏大时出现大空隙；`resize` 丢失、值仍为 0 且没有上移时被挡住。上游 issue #1456 / PR #1457 只处理了事件丢失这一半。

修复：`subpath-shim.js` 用 `!important` 覆盖外壳的内联样式，`top`/`height` 跟随 `visualViewport.offsetTop`/`height`（PWA 模式另加 `--header-total-padding`，双指缩放时不跟随）；监听 `visualViewport` 的 `resize`/`scroll`、`window` 的 `resize`，并在 `focusin`/`focusout` 后 300ms、700ms 补读。上移时标题栏也留在屏幕内。开关：`/code/?kbfix=0` 恢复上游行为，`?kbdebug=1` 在顶部显示 L/V/O/K'、外壳位置、输入框到键盘的空隙 `gap` 和最近 8 次事件；两者存在浏览器本地，用 `=1`/`=0` 再切换（PWA 与 Safari 的存储互相独立）。提交 `261f19a`。

发布：与上一节相同，只复制 shim 并重新执行 `patch-subpath.mjs`，未重启 `cloudcli.service`。

验证：WebKit 没有软键盘，测试在隔离实例（数据库副本、3011 端口，3012 端口代理成 `/code/`）中用 iPhone 13 模拟，替换 `visualViewport` 的 `height`/`offsetTop`/`scale` 并按 iOS 的方式派发事件。修复前 9 项中 7 项失败（上移时外壳顶部仍为 0、关键盘丢事件后外壳底部停在 328 而非 664、开键盘丢事件后停在 664 而非 328 等），修复后全部通过，包括 PWA、缩放、`kbfix=0`、`kbdebug`。不弹键盘时，修复前后外壳都是 0..664（iPhone）和 0..800（桌面 Chromium）。上线后本机 3001 返回的 shim 与提交一致，`index.html` 只有 shim 哈希变化，Caddy `/code/` 未登录仍 303。真机（2026-10-26）：竖屏正常；横屏输入框仍会被输入法挡住，用户认为可以接受，暂不处理。以后要查，先用 `?kbdebug=1` 在横屏下截图看各项数值。

回滚：把 `/var/backups/cloudcli-shim-20261026T031032Z/subpath-shim.js` 复制回 `/srv/cloudcli/subpath-shim.js`，再执行 `node /srv/cloudcli/patch-subpath.mjs /srv/cloudcli/node_modules/@cloudcli-ai/cloudcli`；只想临时关闭可在页面上用 `?kbfix=0`。

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

### 已学单元可查看（2026-10-18）

发布目录为 `/srv/jlpt/releases/20261018-review-learned-view/static`，仅切换 `/srv/jlpt/static`，后台代码不变、服务未重启（app 仍为 `20261018-review-node-style`）。

- 今日安排的全程目录里，状态为“已学”的单元多一个「查看」按钮，打开原有的单元页（锁定的回忆核对、对比页、原卡核心、已交的造句与备注），与点“提前学”走同一接口，服务端无改动。单元页的交卷小节标题按是否在待判分列表显示“已交卷，待判分”或“已交卷”。
- 只覆盖本轮已学的单元；新一轮开始后，上一轮学过的单元没有本轮交卷文件，只会显示回忆部分。

- 修正：进入单元页或复习卷时隐藏上方的进度区（含展开的全程目录），返回「今日安排」时恢复；此前单元页接在展开的目录下面，点「查看」只像回到页面顶部。发布目录为 `20261018-review-learned-view2`。

验证：13 项 Chromium/WebKit 浏览器测试通过，新增“点「查看」→ 单元页取代概览 → 返回恢复”的检查；浏览器测试读取 `server-public`，跑测试前必须先 `node scripts/build-server.mjs` 重新构建，否则测的是旧页面。以真实学习仓库只读读取 B-05-1，返回对比页、4 张原卡与已交造句。回滚：按 `previous-release.txt` 把 `/srv/jlpt/static` 切回上一个发布（`20261018-review-learned-view/static` 为第一版，`20261018-review-node-style/static` 为功能前）。

### 已交卷试题回顾（2026-10-18）

发布目录为 `/srv/jlpt/releases/20261018-review-answer-view`，app 与 static 均已切换并重启 `jlpt.service`（接口新增字段）。

- 单元页（和已交卷的复习卷）新增“试题回顾”：用原试卷渲染题目，正确选项标「正确答案」，学习者选的标「我的选择」（答错时红框，不确定在题号旁注明），每题题号旁显示答对／答错／未作答，下方折叠「解析」（翻译、正确接续、四个选项逐项解释）。排序题只显示“我的语序”和 ★ 处正确项，不自动判对错。
- `GET /api/review/units/<id>` 与 `GET /api/review/reviews/<id>` 在已交卷后多返回 `key`（`[{number, correct, correct_text, explanation}]`），由 `jlpt-notes/quizzes/answers/<试卷>-answers.md` 解析；未交卷时不返回该字段，答案文件缺失时为空列表。解释里去掉题目、考点、来源、证据行。

验证：后端测试与 13 项浏览器测试通过（含 `key` 交卷前不出现、交卷后 5 题、答案文件缺失不报错）；以真实学习仓库读取 B-05-1 的 5 题答案和作答，与成绩记录一致（第 4 题选 3、正确 1）。回滚：按 `previous-release.txt` 切回并重启。

### 回忆核对改为直接显示用法（2026-10-18）

发布目录为 `/srv/jlpt/releases/20261018-recall-plain`，仅切换 `/srv/jlpt/static`，后台代码不变、服务未重启。

- 取消回忆核对的“想到／没想到”：单元第 1 步直接按语法形式分组显示各行用法，不再遮挡、不再有「没想到」按钮和浏览器草稿；「进入对比页」仍锁定这一步。前端固定提交 `missed: []`，交卷文件里的 `recall.marks` 因此恒为全部 `recalled: true`（仅为数据结构兼容保留，不含信息）。已学单元以前标过的「没想到」不再在页面显示，记录仍在学习仓库的学习记录里。
- 以后分析薄弱语法点不参考“是否想到”，只看答题对错与错因。

验证：13 项浏览器测试通过（新增“直接显示用法、无按钮、锁定后用法仍在”）。回滚：按 `previous-release.txt` 把 `/srv/jlpt/static` 切回 `20261018-review-answer-view/static`。

补充（同日，发布目录 `/srv/jlpt/releases/20261018-recall-server`，app 与 static 均已切换并重启 `jlpt.service`）：服务端同步清理。`POST /api/review/units/<id>/recall` 不再读取请求体里的 `missed`（手机缓存的旧页面仍发也会被忽略），交卷文件的 `recall.marks` 一律生成为全部 `recalled: true`；`GET /api/review/units/<id>` 的 `recall` 只含 `items`，不再返回 `missed`。验证：57 项后端测试（1 项按环境条件跳过）与 13 项浏览器测试通过，新增“旧页面发来的 `missed` 被忽略”。回滚：按 `previous-release.txt` 切回并重启。

### 回忆核对改名“用法总览”，不再记录此步（2026-10-18）

发布目录为 `/srv/jlpt/releases/20261018-usage-overview`，app 与 static 均已切换并重启 `jlpt.service`；须与学习仓库 `groups.py` 的同日修改一起上线（`start_unit` 不再收 `missed` 参数）。

- 单元第 1 步标题由「一、回忆核对」改为「一、用法总览」；进入对比页后不再显示「已锁定 · 时间」行。
- 点「进入对比页」创建的交卷文件只含 `schema_version`、`unit_id`、`round`、`paper`，不再写 `recall`（无“想到”标记、无锁定时间）；文件存在即表示该单元已开始。旧交卷文件里的 `recall` 原样保留。
- `GET /api/review/units/<id>` 的 `session` 去掉 `locked_at`；未进入对比页就交卷的提示改为「尚未进入对比页」。`POST .../recall` 接口名不变，仍忽略请求体。

验证：57 项后端测试（1 项按环境条件跳过）与 13 项浏览器测试通过（新增标题为「一、用法总览」、交卷文件无 `recall`、页面无「已锁定」）。回滚：按 `previous-release.txt` 切回并重启，同时须把学习仓库 `groups.py` 一并回退。

## 已完成复习可查看（2026-10-19）

发布目录为 `/srv/jlpt/releases/20261019-review-done-view`，app 与 static 均已切换并重启 `jlpt.service`；仅前端改动，后端源码未变。目录中状态为“已完成 ✓”的复习节点新增“查看”按钮，打开只读试题回顾；回顾页仅在该复习仍待判分时显示“已交卷，待判分”，判分后只显示“已交卷”。

验证：57 项后端测试（1 项按环境条件跳过）与 13 项浏览器测试通过。回滚：按 `previous-release.txt` 切回并重启。

## 排序题显示完整正确语序（2026-10-19）

发布目录为 `/srv/jlpt/releases/20261019-order-answer`，app 与 static 均已切换并重启 `jlpt.service`。试题回顾中的排序题除“★处正确项”外，新增“正确语序”与完整句；语序取自答案文件的“推荐语序”字段，缺字段时从解析句的“(编号)”推出，旧卷没有答案文件则不显示。

验证：58 项后端测试（1 项按环境条件跳过）与 13 项浏览器测试通过。回滚：按 `previous-release.txt` 切回并重启。

## 用法总览下的对比表（2026-10-19）

发布目录为 `/srv/jlpt/releases/20261019-compare-table`，app 与 static 均已切换并重启 `jlpt.service`。单元材料带可选的 `compare` 字段时，“用法总览”的用法列表下显示对比表：手机默认“按项目比”，可切换“按语法看”，宽度 ≥720px 为表格。`/api/review/units/<单元>` 在单元开始前就返回 `compare`；没有该字段的单元显示不变。格式规则见 jlpt-study 设计文档 5.4.2。相对上一版本仅 `review/review.css`、`review/review.mjs`、`server/review.py` 变化。

验证：59 项后端测试（1 项按环境条件跳过）与 15 项浏览器测试通过（含手机与宽屏对比表）；发布后以发布目录的 app 代码读取真实 G-001，返回 4 个语法的对比表，公网未登录访问仍被登录门禁拦截。回滚：按 `previous-release.txt` 切回并重启。

## 对比表改为 5 项（2026-10-19）

发布目录为 `/srv/jlpt/releases/20261019-compare-table5`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启（仍为 `20261019-compare-table/app`）。对比表删除易混点，固定 5 项，顺序为接续、一句话记忆、核心含义、语气与感情色彩、代表例句；一句话记忆移到接续下方。学习仓库 `groups.py` 同步取消 `confusion` 校验并重写 G-003 核心含义（提交 `511abe3`），网页发布提交 `a6339ae`。

验证：学习仓库 279 项测试（1 项跳过）与 `validate-groups`、`validate-links`、`validate-doc-links` 通过；jlpt-web 59 项后端测试（1 项跳过）与 2 项对比表浏览器测试通过。发布后 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 运行中；以发布目录的 app 代码读取真实 G-001、G-003，均返回 5 项且无 `confusion`。回滚：按 `previous-release.txt` 把 `/srv/jlpt/static` 切回 `20261019-compare-table/static`；学习仓库如需回退，回退提交 `511abe3`。

## 目录定位、上下页与对比核心含义（2026-10-20）

发布目录为 `/srv/jlpt/releases/20261020-review-pager`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启（仍为 `20261019-compare-table/app`）。展开“全程目录”自动滚到当前单元；单元页与复习页顶部、底部各有“上一页／下一页”，按目录顺序（单元后接其收尾的复习），只向已准备好的一步显示；对比页中入表的成员，其“原卡核心”下方再显示该成员的对比核心含义。网页发布提交 `d26834b`，仅前端改动。

验证：59 项后端测试（1 项跳过）与 17 项浏览器测试通过；发布后 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中，发布目录的 `review.mjs` 与源码一致。回滚：按 `previous-release.txt` 把 `/srv/jlpt/static` 切回 `20261019-compare-table5/static`。

## 对比核心含义改为原样复制（2026-10-20）

发布目录为 `/srv/jlpt/releases/20261020-review-pager2`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。对比页中入表的成员，其“原卡核心”下方改为原样复制对比表“按项目比”的“核心含义”行（标题、语法颜色标签、文字与样式一致），取代上一版的简化单行。网页发布提交 `fc74b7e`，仅前端改动。

验证：17 项浏览器测试通过；发布后 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中，发布目录 `review.mjs` 与源码一致。回滚：把 `/srv/jlpt/static` 切回 `20261020-review-pager/static`。

## 目录与上下页补上“当前”单元（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-pager-current`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。此前“下一个要学的单元”状态为 `current`，目录按钮与上下页都不认它，导致大类最后一个语法没有“下一页”、下一大类第一个语法没有按钮；现在 `current`（今日安排正是它时）显示“开始”，`in_progress` 显示“继续”，翻页与目录共用同一判断。网页发布提交 `a5af823`，仅前端改动。

验证：18 项浏览器测试与 59 项后端测试（1 项跳过）通过；发布后 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中，`/srv/jlpt/static` 的 `review.mjs` 与源码一致。回滚：把 `/srv/jlpt/static` 切回 `20261020-review-pager2/static`。

## 单元不再有造句（2026-10-21）

新准备的单元不再出造句题：单元材料没有 `sentence` 时，`unit_view` 不返回 `sentence`，页面最后一步改为「四、备注」，只显示备注框，交卷体不带 `sentence`，交卷文件只写 `note` 与 `submitted_at`。单元材料仍含 `sentence` 的旧单元（含已准备的 G-012～G-014）照旧显示造句框并要求填写；校验与提交规则在学习仓库（`jlpt_notes.groups.submit_unit` 按单元材料决定是否要求造句）。仅改 `server/review.py` 与 `web/review/review.mjs`，`server/app.py` 无需改动。

验证：19 项浏览器测试（新增「无造句单元只有备注框并可直接交卷」）与 61 项后端测试（1 项跳过）通过；浏览器测试读取 `server-public`，跑前须先 `node scripts/build-server.mjs`。已发布：发布目录 `/srv/jlpt/releases/20261021-no-sentence`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 均已切换并重启 `jlpt.service`；与上一版本逐文件比对，只有 `server/review.py` 与 `static/review/review.mjs` 不同，二者与源码一致。发布后公网 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中。网页提交 `3857bae`。回滚：把 `/srv/jlpt/app` 切回 `20261019-compare-table/app`、`/srv/jlpt/static` 切回 `20261021-pager-current/static` 后重启服务。

## 核心功能标题显示个数与分数（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-core-function-count`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。卡片“核心”里的功能标题与导航按钮改为：只有一个功能时显示“功能”，有多个功能时显示“功能一 1/3”“功能二 2/3”等；由 `mobile/core-content.mjs` 的 `labelCoreFunctions` 在渲染前按功能总数计算，资料原文与 `catalog.json` 不改，仍写“功能一”。`/grammar/` 的核心与 `/review/` 的“原卡核心”共用这一函数；`public/` 旧镜像未同步。`/grammar/` 页的 `catalog.json` 仍钉在旧版本 `7e762bb`，N5 的 118 张卡与 N4 的 20 张卡里没有“功能”标题，所以这些卡在 `/grammar/` 看不到变化，需另行刷新 catalog。

验证：移动端 19 项浏览器测试（需设 `JLPT_STUDY_ROOT` 指向学习仓库，并用 `mobile/` 覆盖后的站点目录，默认的 `public/` 是旧镜像）、19 项服务端浏览器测试与 61 项后端测试（1 项跳过）通过；`tests/mobile/cache.test.mjs` 有 4 项因缺少测试图片失败，改动前同样如此。发布后与上一版本逐文件比对，只有 `grammar/app.mjs`、`grammar/core-content.mjs`、`review/review.mjs` 不同，三者与构建产物一致；本机 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中。回滚：把 `/srv/jlpt/static` 切回 `20261021-no-sentence/static`。

## 刷新目录到当前学习仓库（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-catalog-refresh`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。`data/catalog.json` 由旧提交 `7e762bb` 刷新为 `0d93492`（学习仓库最后一次改动卡片与图片的提交，与当时 HEAD 的卡片内容相同）：共 599 张卡，新增 N5-G-0072，133 张卡的标题与 138 张卡的核心更新；N5 此前在目录里没有图片，选 N5 区间会提示缺图片，现在 119 张全部可读；N4-G-0061～0080 的例句图指向新文件名 `-example.png`。刷新用新增的 `scripts/refresh_catalog.py --study <学习仓库> --revision <提交>`（复用 `extract_core`，卡片缺少接续图或例句图时中止），测试见 `tests/server/test_refresh_catalog.py`。

新版本图片由 `scripts/setup_study.py` 的 `materialize_images` 导出到 `static/grammar/images/0d93492…/`，没有调用其 `prepare()`（它会新建 `.worktrees/web-study` 并改学习仓库的 push 地址）；导出后把与旧版内容相同的 940 张图片改为指向旧目录的硬链接，只新增 258 张（N5 238 张加 N4 改名 20 张）。旧目录 `images/7e762bb…` 与旧 catalog 保留用于回滚。`/grammar/` 与 `/review/` 的功能标题显示不再因目录过旧而缺失。`public/` 旧镜像里的 `catalog.json` 未同步。

验证：63 项后端测试（1 项跳过）、19 项服务端浏览器测试（整套并发运行时曾有 1 项偶发失败，单独与整套再跑两次均通过）、20 项移动端浏览器测试通过（需设 `JLPT_STUDY_ROOT`，并在临时副本里运行 `node scripts/build.mjs` 生成含新 catalog 的站点目录，不改仓库的 `public/`）。移动端旧测试“缺少 N5 图片提示”依赖旧目录缺图，已改为用路由置空某张卡图片触发提示，并新增“N5 卡片可打开阅读”。发布前核对：目录引用的 1198 张图片全部存在；发布目录与构建产物只有 `grammar/catalog.json` 不同；发布后本机 `/review/` 未登录 303、`/api/review/today` 401，线上 `catalog.json` 与源码一致，`jlpt.service` 与 caddy 运行中。回滚：把 `/srv/jlpt/static` 切回 `20261021-core-function-count/static`。

## 今日复习（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-spaced-review`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 均已切换并重启 `jlpt.service`。`/review/` 顶部（“第 N 轮 · 已学”上方）新增“今日复习”：服务端 `server/review.py` 按路径加载学习仓库的 `src/jlpt_notes/spaced_review.py`（与 `groups.py` 同样的加载方式），新增 `GET /api/review/spaced`（到期清单，按学习日期分组，附单元标题）与 `POST /api/review/spaced/submit`（`{"units": [...]}`，只接受当前到期的单元，全部通过才写入，重复提交返回 409）。记录写入学习仓库 `jlpt-notes/groups/spaced-reviews.json`，网站不提交 Git；学习仓库缺少该模块时接口返回 500 并指出路径。

验证：69 项后端测试（1 项跳过）与 20 项浏览器测试通过（新增“今日复习按学习日期分组并记录勾选”）；手机宽度截图核对布局。发布后与上一版本逐文件比对，static 只有 `review/index.html`、`review/review.css`、`review/review.mjs` 不同，app 源码与仓库一致；公网 `/review/` 未登录 303、`/api/review/today` 与 `/api/review/spaced` 401，`jlpt.service` 与 caddy 运行中。未登录状态下无法核对接口内容，登录后的行为以浏览器测试为准。网页提交 `d7b1631`，学习仓库提交 `843ab5f`。回滚：把 `/srv/jlpt/app` 切回 `20261021-no-sentence/app`、`/srv/jlpt/static` 切回 `20261021-catalog-refresh/static` 后重启服务。

## 关闭旧复习周期（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-cycle-off`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 均已切换并重启 `jlpt.service`。学习仓库的 `groups/plan.json` 新增可选 `review_cycle`，当前为 `"off"`：规则模块 `groups.py` 不再触发“复习已到期”，`start_unit` 不再因旧复习而拒绝新单元，`progress.days_to_review` 为 `null`（规则在学习仓库，网站按路径加载，`server/` 代码无变化）。本次网站只改 `web/review/review.mjs`：`days_to_review` 为 `null` 时隐藏“距下次复习还差…/复习已到期”那一行。

验证：70 项后端测试（1 项跳过）、21 项浏览器测试通过（新增“周期开启时显示该行，关闭后隐藏”）。发布后与上一版本逐文件比对，static 只有 `review/review.mjs` 不同，server 代码一致；用线上 app 代码读取线上学习仓库得到：状态 `not_prepared`、下一单元 G-015、复习为空、`days_to_review` 为 `null`；公网 `/review/` 未登录 303、两个 `/api/review/*` 接口 401，`jlpt.service` 与 caddy 运行中。网页提交 `53b4d9c`，学习仓库提交 `0b57095`。回滚：把 `/srv/jlpt/app` 与 `/srv/jlpt/static` 切回 `20261021-spaced-review` 下对应目录后重启服务（旧页面在 `review_cycle` 为 `off` 时会多显示一行“复习已到期”，不影响使用；要恢复旧周期，把 `plan.json` 的该字段改为 `"on"`）。

## 用法总览可隐藏用法（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-usage-toggle`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。`/review/` 单元页的“一、用法总览”里，每个语法形式标题旁有“隐藏用法／显示用法”按钮，列表上方有“全部隐藏／全部显示”（全部已隐藏时显示“全部显示”，否则显示“全部隐藏”）。默认状态：单元还没点“进入对比页”时（第一次学）用法全部显示；进入对比页之后（包括进行中、已交卷以及第 1／3／8／21 天复习时再打开）默认全部隐藏，只留形式名和“用法已隐藏，先回忆，再点‘显示用法’核对”的提示，方便先回忆再核对。开关只存在于当前页面，不写 localStorage，也不写服务器记录，与“用法总览不记录是否想到”的规则一致；对比表与原卡核心不受影响。仅改 `web/review/review.mjs`（`recallList` 与 `renderUnit`）和 `web/review/review.css`。

验证：22 项浏览器测试（新增“用法首次显示、进入后默认隐藏，可按单项或全部切换”；原两处“用法总览无按钮”的断言随之改为不检查按钮）与 70 项后端测试（1 项跳过）通过。发布后与上一版本逐文件比对，static 只有 `review/review.css`、`review/review.mjs` 不同，二者与源码一致；本机 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中。网页提交 `49087c4`。回滚：把 `/srv/jlpt/static` 切回 `20261021-cycle-off/static`。

## 用法总览改为滑动开关与遮罩条（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-usage-switch`，仅切换 `/srv/jlpt/static`，app 保持不变、服务未重启。上一版的“显示／隐藏用法”文字按钮改为滑动开关（`role="switch"`，`aria-checked` 为 `true`／`false`，触摸高度 ≥44px）：每个语法形式标题旁一个“用法”开关，列表上方一个“全部”开关；各形式状态不一致时“全部”的 `aria-checked` 为 `mixed`，滑块停在轨道中间。点“全部”：有隐藏的就全部显示，全部已显示就全部隐藏。隐藏时页面里不再渲染用法文字，每条用法换成一条圆角遮罩条（宽度按 86%／58%／72% 轮换，与真实文字长度无关，带缓慢微光，`prefers-reduced-motion` 下不动），序号与条数保留；点遮罩区域可揭开该形式，揭开时文字淡入。去掉了“用法已隐藏…”文字提示。默认规则不变：新单元未进入对比页时显示，进入之后默认隐藏；状态不存储。仅改 `web/review/review.mjs`（`usageSwitch`、`recallList`）与 `web/review/review.css`。

验证：22 项浏览器测试（重写“用法显示／遮罩／开关”一项：开关状态、半开、点遮罩揭开、隐藏时页面不含用法文字、开关高度）与 70 项后端测试（1 项跳过）通过；手机宽度截图核对显示、半开与全隐藏三种状态。发布后与上一版本逐文件比对，static 只有 `review/review.css`、`review/review.mjs` 不同，二者与源码一致；本机 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中。网页提交 `d9e7851`。回滚：把 `/srv/jlpt/static` 切回 `20261021-usage-toggle/static`。

## 用法遮罩条改为静态（2026-10-21）

发布目录为 `/srv/jlpt/releases/20261021-usage-mask-static`，仅切换 `/srv/jlpt/static`，app 与服务不变。上一版隐藏用法时的遮罩条带缓慢微光，现改为静态纯色（`--control-line`，不透明度 .7），去掉 `recall-shimmer` 动画；开关滑动与揭开时文字淡入保持不变，`prefers-reduced-motion` 下淡入也不动。仅改 `web/review/review.css`。验证：22 项浏览器测试通过，手机宽度截图核对；发布后与上一版本比对只有 `review/review.css` 不同，且与源码一致；本机 `/review/` 未登录 303、`/api/review/today` 401，`jlpt.service` 与 caddy 运行中。网页提交 `27debfe`。回滚：把 `/srv/jlpt/static` 切回 `20261021-usage-switch/static`。

## 今日学习与复习只认已交卷单元（2026-10-25）

发布目录为 `/srv/jlpt/releases/20261025-daily-new`，仅切换 `/srv/jlpt/static`，app 与服务不变、未重启。`/review/` 在“今日复习”下面新增“今日学习”面板：读取 `/api/review/today` 里 `plan_state` 新增的 `daily`（规则在学习仓库 `groups.py`，网站按路径加载，学习仓库工作区改动即时生效），显示今天的新单元、已交卷的标“今天已完成 ✓”、未准备的标“尚未准备”。每天个数为学习仓库 `groups/plan.json` 的 `daily_new`（目前 2），今日名额只看实际交卷进度，不按日历推断；不写 `daily_new` 则面板隐藏。同时，学习仓库的 `spaced_review.py` 改为只列本轮已交卷的单元，复习分组的“X 月 X 日学的”用真实交卷日。

验证：72 项后端测试（1 项跳过）、23 项浏览器测试通过（新增“今日学习按 daily_new 与实际交卷显示”，复习测试改为先写交卷再写复习起点）。发布后与上一版本逐文件比对，static 只有 `review/index.html`、`review/review.css`、`review/review.mjs` 不同，三者与源码一致；公网 `/review/` 未登录 303、`/api/review/today` 与 `/api/review/spaced` 401，`jlpt.service` 与 caddy 运行中；用线上规则读取线上学习仓库得到今日学习 G-015、G-016。网页提交 `03cf997`，学习仓库提交 `831cb84`。回滚：把 `/srv/jlpt/static` 切回 `20261021-usage-mask-static/static`。

## 用法总览“忘了”按钮（2026-10-26）

发布目录为 `/srv/jlpt/releases/20261026-forget`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 均已切换并重启 `jlpt.service`。进入对比页后，用法总览每个语法形式旁有“忘了”按钮（首次查看新单元时不显示）：每点一次，`POST /api/review/units/<单元>/forget`（`{"form": ...}`，只接受已进入对比页的单元、用法总览里有的形式）向学习仓库 `jlpt-notes/groups/forgets.json` 追加一条 `{id, unit, form, cards, at}`，`cards` 为该形式在 `recall_items` 里对应的全部卡号（形式与卡不是一一对应），`at` 为东八区时间；该文件只由网站写入，网站不提交 Git，以后统计常忘语法时读取它。`unit_view` 在已进入的单元上返回 `forgets`（形式 → 累计次数）。误点可在约 5 秒内点“撤销”，`POST .../forget/undo`（`{"event": id}`）只删除该条，服务端只认两分钟内的记录（过期 409、不存在 404）。动画参照 codex-resets.com 的 thanks：按钮压扁回弹、变化的数字滚入、随机飘出“+1／忘了／💭／😵”；系统开启减少动画时只改数字。

验证：77 项后端测试（含真实 Caddy 与资料校验器）、24 项浏览器测试通过（新增“忘了”按钮的计数、撤销、写入与重新打开后保留）。发布后 static 与构建产物一致（只有 `review/review.css`、`review/review.mjs` 变化），app 只有 `server/app.py`、`server/review.py` 与文档、测试变化；本机与公网 `/review/` 未登录 303、`/api/review/today` 与新的 forget 接口 401，`jlpt.service` 与 caddy 运行中；用线上代码读取线上学习仓库，G-014 已进入对比页、`forgets` 为空。未在线上真实点按（不往学习记录里写测试数据）。网页提交 `87f11f6`。回滚：把 `/srv/jlpt/app` 切回 `20261021-cycle-off/app`、`/srv/jlpt/static` 切回 `20261025-daily-new/static` 后重启服务（`forgets.json` 留着不影响旧版本）。

## “想不起来”按钮改为贴纸风（2026-10-26）

发布目录为 `/srv/jlpt/releases/20261026-forget-sticker`，仅切换 `/srv/jlpt/static`，app 与服务不变、未重启。按用户选择改为参考站的贴纸风：金底、深色描边、深金色硬投影的方块按钮，按下沉进投影并微歪；按钮不写文字，只放从 💭🤯🫠😵‍💫 中随机的表情，每次点击换一个并晃动；按钮左侧始终显示当前次数（0 也显示），变化的数位滚入；飞出的小贴纸显示点击后的次数；撤销改为 ↩ 小贴纸（读屏名“撤销”）。按钮的读屏名为“<形式> 想不起来，已记 N 次”。接口与 `forgets.json` 不变。

验证：77 项后端测试（含真实 Caddy 与资料校验器）、24 项浏览器测试通过（按钮测试改为检查无文字、0 也显示、换表情、贴纸显示当前次数）。发布后 static 与构建产物一致，与上一版本只有 `review/review.css`、`review/review.mjs` 不同；本机与公网 `/review/` 未登录 303，`jlpt.service` 与 caddy 运行中。网页提交 `1e7ef40`。回滚：把 `/srv/jlpt/static` 切回 `20261026-forget/static`。

## CloudCLI 升至 1.37.6（2026-10-28）

用 `deploy/cloudcli/upgrade.sh 1.37.6` 暂存、`--swap` 切换。升级前先清掉 `/root/.npm` 的 npm 下载缓存（约 880 MB，可重新生成），空闲空间才够脚本要求的 2.5 GB。

对照 1.37.5 的包：依赖不变，数据库没有表结构改动；前端键盘外壳（`fixed inset-0` + `bottom: var(--keyboard-height, 0px)`，只在 `visualViewport` 的 `resize` 里更新）与 `.chat-composer-shell` 都没变，所以 2026-10-26 的键盘错位修复仍然适用，横屏仍被挡住的问题照旧。补丁的各处替换在新包上都恰好匹配 1 次，连续两遍通过。新版增加了输入框里的权限模式提示、排队追加消息、CLI 版本显示，以及文件查看器可读工作区根（`/root/projects`）下任意文件（写入范围不变）。

验证：`/health` 返回 1.37.6，服务端 3001 的 shim 与仓库文件一致，`index.html` 和 bundle 带新哈希，`/root` 放行与模型名称标签生效，Caddy `/code/` 未登录返回 303，日志无报错。按用户要求，上线后删除了 `/srv/cloudcli.prev` 和本次的数据库备份，因此没有现成的回滚副本；要回退需重新 `upgrade.sh 1.37.5` 并 `--swap`（数据库未做结构迁移，不影响）。真机上的输入框表现尚未确认。

## 雅虎新闻阅读器部署（2026-11-08）

新闻功能是一个 Safari 用户脚本（Userscripts 扩展）：脚本在 `news.yahoo.co.jp` 的文章页上直接标出词、点词查词、长按选句、拖选、分析和追问，本站只提供加载器、主脚本、分词、查词和模型接口，不再抓取、保存文章或图片（2026-11-09 起；设计见 `docs/superpowers/specs/2026-11-09-news-userscript-design.md`）。本站的 `/news/` 阅读页已经移除。2026-11-09 又取消了令牌与设备管理，也去掉了 `/news-script/` 管理页：加载器改为在本机生成、手动放置一次，之后在线更新（见「安装到设备」）。

分词用 fugashi + unidic-lite，其余服务端代码仍只用标准库，所以只有 `jlpt.service` 换到独立 venv，Caddy 和其他进程不受影响。

### 创建 venv

依赖固定在仓库的 `requirements-news.txt`（`fugashi==1.5.2`、`unidic-lite==1.0.8`）。实测占用：unidic-lite 词典约 249 MB 磁盘，加载后常驻内存约 +5 MB，处理 1000 个句子后约 +25 MB（词典按内存映射读取）；换成体积更小的 ipadic 约 51 MB 磁盘、+15 MB，但读音与原形更差，所以选 unidic-lite。部署前确认 `/srv` 所在磁盘有 300 MB 以上空闲。

首选标准做法：

```bash
cd /srv/jlpt/app
python3 -m venv /srv/jlpt/venv
/srv/jlpt/venv/bin/pip install -r requirements-news.txt
```

Ubuntu 24.04 上若报 `ensurepip is not available`（本服务器就是这样，未装 `python3.12-venv`），二选一：

```bash
# 方案 A：补装 venv 包后重新执行上面三行（先 rm -rf /srv/jlpt/venv 清掉失败的残留）
apt install python3.12-venv

# 方案 B：用已安装的 uv（venv 里没有 pip，用 uv pip 安装）
uv venv --python /usr/bin/python3 /srv/jlpt/venv
uv pip install --python /srv/jlpt/venv/bin/python -r requirements-news.txt
```

`deploy/install.sh` 采用方案 B，venv 不存在时才创建，每次都按 `requirements-news.txt` 同步。验证：`/srv/jlpt/venv/bin/python -c "import fugashi, unidic_lite; fugashi.Tagger()"` 无报错。

### 服务单元

`deploy/jlpt.service` 的启动命令改为 `ExecStart=/srv/jlpt/venv/bin/python -m server --config /srv/jlpt/state/config.json`，工作目录仍是 `/srv/jlpt/app`。venv 必须先建好再安装单元并重启，否则服务会因找不到解释器反复重启。

### 配置模型网关

新闻的查词、分析和追问经 qoder2api-hub 的 OpenAI 兼容接口。这次改版**不需要改 `llm`**：线上已有的 `llm` 配置原样沿用；`news_sites` 也是可选项，缺省就是雅虎新闻（见下文「新闻网站表」）。首次配置时，把地址和密钥写进 `config.json` 的 `llm`：

```bash
cd /srv/jlpt/app
read -rs JLPT_LLM_API_KEY && export JLPT_LLM_API_KEY      # 输入密钥，不回显、不进 shell 历史
python3 scripts/configure_server.py --origin https://你的云平台HTTP代理域名 \
  --llm-base-url http://127.0.0.1:8790
unset JLPT_LLM_API_KEY
systemctl restart jlpt.service
```

- 密钥也可用 `--llm-api-key` 传，但会留在 shell 历史和进程列表里，优先用环境变量 `JLPT_LLM_API_KEY`。
- 脚本不打印密钥，参数写错时的报错也只显示参数名；`config.json` 权限保持 600。
- 只给 `--llm-base-url` 时保留已有密钥；只给密钥而没有地址（且 `config.json` 里也没有）会报错。不带任何 `--llm-*` 参数重跑，已有 `llm` 配置原样保留。
- 重复运行脚本不会重置网站密码。

### Caddy 与流式响应

`/api/news/analyze`、`/api/news/ask` 以 SSE 逐段返回（旧版的 `/api/news/open` 已删除），Caddy 不能攒包。`deploy/Caddyfile` 的 `@api` 反向代理已加 `flush_interval -1`（每个数据块立即转发），站点级 `encode zstd gzip` 对 `text/event-stream` 不压缩，应用另发 `X-Accel-Buffering: no`。`tests/server/test_caddy.py` 用真实 `deploy/Caddyfile`（仅换端口）起 Caddy，后端先发一个事件、0.5 秒后发第二个，断言第一个事件 0.4 秒内到达且未被压缩。

云平台的 HTTP 代理在 Caddy 之前，如果它自己缓冲响应，页面会表现为分析结果一次性出现；这不在仓库控制范围内，需要在云平台侧关闭对该域名的响应缓冲。

更新 Caddyfile 后：

```bash
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy.service
```

### 可续传的流（2026-11-09 起）

限制来自云平台放在服务器前面的 HTTPS 代理（`Caddyfile` 注释里的 "cloud HTTP proxy"）：它把任何单次响应在约 16 秒处切断，本机与本机 Caddy 都没有这个限制。句子分析常要 10–30 秒，所以 `/api/news/analyze` 与 `/api/news/ask` 不再把模型输出绑在一个连接上（`server/news_jobs.py`）：

- 每次请求启动一个后台任务（线程），事件按 1、2、3… 编号记录；响应头 `X-News-Job` 是任务编号（跨域时由 `Access-Control-Expose-Headers` 暴露），每个事件带 SSE `id:` 行。
- 一个连接最多跟随任务 12 秒（`SEGMENT`），到点发 `event: resume` 并结束；浏览器用 `POST /api/news/resume {job, next}` 从最后收到的事件号接着读，`streamSSE`（`news-client/api.mjs`）自动完成，面板代码不变。连接中途断开时也会按同样方式重试最多 3 次。
- `POST /api/news/cancel {job}` 立即停止任务并放弃上游模型请求（用户换了句子或关闭面板时由脚本发出）。没有任何连接跟随超过 5 秒（`GRACE`）的任务也会自动放弃；已结束的任务保留 5 分钟（`KEEP`）供 `/resume` 取尾部；同时未结束的任务最多 30 个（`MAX_LIVE`），超过返回「服务器忙」。任务只在内存里，服务重启后 `/resume` 会得到「这次回答已过期，请重试」，脚本显示为可重试的错误。
- 模型仍然只调用一次；`ClientGone`、模型并发上限（3）与排队提示都不变。

### 真实模型测试与雅虎抽查

这两项会访问外部服务，不在 `npm run test:server` 里，按需手动运行。

**真实模型测试**（`tests/llm/`，6 项）：经本机 qoder2api-hub 调用模型，检查查词释义（最多两个义项、每个不超过 15 字，助词「で」也有功能说明）、分析回复能完整解析且标签外没有多余内容、只选整句时没有 `<selection>` 而选中部分时有、相关语法排在最前、必需标签齐全且 `<level>` 在 N5–N1 之内、各段逐个到达（第一段比最后一段早至少 0.3 秒）、追问第二轮「那换成に呢」能接上第一轮。每次约 7 次模型调用，会消耗额度；在修改 `server/news_prompts.py` 之后、上线前、更换常用模型时运行。需要三个环境变量，缺任何一个整组跳过并说明原因：

```bash
cd /srv/jlpt/app
read -rs JLPT_LLM_API_KEY && export JLPT_LLM_API_KEY      # qoder2api-hub 的密钥，不回显、不进 shell 历史
JLPT_LLM_BASE_URL=http://127.0.0.1:8790 JLPT_LLM_MODEL=DeepSeek-Flash npm run test:llm
unset JLPT_LLM_API_KEY
```

- 思考档位与服务器一致，取该模型 `reasoning_efforts` 中最低的一档；模型不在 qoder2api-hub 的列表里时整组报错，不换用其他模型。
- 测试句子全部自写；失败信息只含模型回复，不含密钥和请求头。
- 格式类失败时，只调整 `news_prompts.py` 里模板周围的规则措辞（模板本身照抄设计文档第 5 节），重跑通过后在 `tests/server/test_news_xml.py` 补对应的回归用例。
- 2026-11-08 用 DeepSeek-Flash（`low`）连跑两次均 6/6 通过，每次 40–60 秒。句子分析要先思考再输出：第二次首段输出在 10–13 秒，第一次单次分析总耗时 20–28 秒（首段约在 20 秒以后），离 30 秒无输出超时余量不大。

**雅虎抽查**（`scripts/news_check.mjs`，取代已删除的 `scripts/news_probe.py`）：在本机起一个 HTTPS 的本站实例（`scripts/news_check_server.py`，自签证书、真实分词、不配置 qoder2api-hub、`news_sites` 用缺省值），再用 Playwright WebKit（`iPhone 15`）装上同一份加载器，打开真实雅虎文章，检查脚本能否找到正文并标出词。要在仓库的开发检出里运行（本机是 `/root/projects/jlpt-web`），不能在 `/srv/jlpt/app` 的发布目录里运行：发布目录没有 `mobile/node_modules`（Playwright 就在那里），也没有 `server-public`。前提：本机有新闻 venv `/srv/jlpt/venv`（脚本自己调用 `/srv/jlpt/venv/bin/python -I`，不需要手动指定）；Playwright 与 WebKit 浏览器已安装（`~/.cache/ms-playwright` 里的浏览器不要删）；每次运行前先 `npm run build` 生成 `server-public/news-script/client.js`。缺 Playwright 或 WebKit 时脚本以退出码 2 退出并提示对应命令。证书与状态目录是临时的，结束或 Ctrl-C 时服务、浏览器和临时目录都会清理。上线前、以及怀疑雅虎改版（脚本找不到正文或标不出词）时运行：

```bash
cd /root/projects/jlpt-web                                  # 仓库的开发检出
npm ci && npm ci --prefix mobile                            # 首次或依赖变化时
npm exec --prefix mobile -- playwright install webkit       # 首次
npm run build
node scripts/news_check.mjs --per-feed 1            # 8 个分类各 1 篇，约 2 分钟
node scripts/news_check.mjs --feed it --per-feed 2  # 只查某个分类，--feed 可重复
```

- 分类取自雅虎 RSS（`top-picks domestic world business entertainment sports it science`）：RSS 条目是话题页时，再取话题页里的第一个 `/articles/<hex>` 地址；某个话题没有文章链接（如指向别的站点）就换下一个话题。
- 每篇文章打开后等 `load` 再等 10 秒，输出一行（制表符分隔）：分类、地址、找到正文（是/否：`h1` 与 `.article_body` 都在）、词数（`html[data-jlpt-words]`）、重包次数（`html[data-jlpt-rewraps]`，页面重新渲染后重新标词的次数）、右下角状态（就绪 / 分词中… / 出错）、错误摘要（右下角列出的错误，以及页面与控制台错误的个数和前两条）。
- 抽查只给顶层的雅虎文章页装加载器（与用户脚本的 `@match`、`@noframes` 一致）；不测试查词卡、分析与追问，这些要人工检查（见下）。
- 一行算失败的条件：找不到正文、词数为 0、状态不是「就绪」、或右下角列出了错误。页面错误只作为信息显示、不算失败，因为雅虎页面自己就会抛 React #418/#423（水合不一致，不装脚本也一样）。
- 末行「成功 x / 共 y」。有文章失败、或一篇都没取到时退出码为 1；参数错误、没有构建产物或没有新闻 venv 时退出码为 2，并说明原因。
- 2026-11-09 实测（`--per-feed 1`）：成功 8 / 共 8，每篇都找到正文、词数 201–726、状态「就绪」；无脚本加载失败。business 与 it 两篇文章带有雅虎自己的 React #418 页面错误（不装脚本时同样出现）。

### 安装到设备

没有令牌、没有设备列表，也没有管理页；所有设备用同一个加载器。每台要用的 iPad / iPhone 手动放置**一次**，之后加载器和主脚本都通过网络更新：

1. 在 App Store 安装 Userscripts，在 Safari 设置里启用扩展，并允许它在 `news.yahoo.co.jp` 上运行。
2. 在服务器的仓库检出里生成加载器：`python3 scripts/make_news_loader.py`。它只读 `/srv/jlpt/state/config.json` 里的 `origin`、`news_sites`、`news_debug`（可用 `--config` 指定别的配置，`--out` 指定输出），写出 `build/jlpt-news-v<版本>.user.js`（如 `jlpt-news-v3.user.js`，`build/` 已被 git 忽略；文件名带加载器版本号，`build/` 里更老的版本文件会被删除）。内容与 `GET /api/news/loader.user.js` 完全相同。
3. 把这个文件放进设备上 Userscripts 的脚本文件夹，只此一次。以后换了新版本文件（文件名里的版本号变了），**先删掉脚本文件夹里旧版本的文件**再放新的，否则两个版本的加载器会同时运行；不要另存成带 `(1)` 的副本。
4. 以后加载器升版本（`LOADER_VERSION` 提高）后，在 Userscripts 里点「检查更新」：它按头部的 `@updateURL` / `@downloadURL`（都是 `/api/news/loader.user.js`，**不需要登录**）原地替换，不会产生重复文件。主脚本每次打开文章页都由加载器从 `/api/news/client.js` 取最新版，不用任何操作。

> 「检查更新原地替换、不产生重复」依赖 Userscripts 对 `@downloadURL` 的处理，上线后要在真机上实测一次；若不行，退路是删掉旧版本文件、放置新版本文件。

已按旧流程（带令牌的加载器）装过的设备不必立刻处理：旧加载器仍会发 `Authorization` 头，服务器忽略它，照常工作；只是没有自更新能力，想要时按上面第 2、3 步放置一次 v3 即可。

**没有鉴权（开发期的有意选择）：** `/api/news/*` 接受「登录 Cookie」或「`Origin` 在 `news_sites` 里」的请求，后者不需要任何凭证。服务器有公网入口，所以 `tokenize`、`analyze`、`ask` 对公网开放并消耗模型额度；`Origin` 只能挡浏览器，挡不住自己伪造请求头的脚本。现有的「模型请求最多同时 3 个」仍然生效，但它不是鉴权。开发完成后要关闭在线更新（见 `news_online_update`），并重新决定是否恢复鉴权。

### 新闻网站表（`news_sites`）

`config.json` 的 `news_sites` 是可选项，缺省值就是雅虎新闻，不写也能用：

```json
"news_sites": [
  {
    "name": "雅虎新闻",
    "origin": "https://news.yahoo.co.jp",
    "match": "https://news.yahoo.co.jp/articles/*",
    "path": "^/articles/[0-9a-f]+$",
    "parts": ["h1", ".article_body"]
  }
]
```

- `origin`：网站来源，形如 `https://主机[:端口]`，同时是接口允许的跨域来源；`match`：写进加载器 `@match` 的网址模式；`path`：主脚本用来判断当前页是不是文章页的正则（匹配路径部分）；`parts`：文章里要标词的部分，按选择器列出（标题、正文）。
- 写错的表会让服务在启动时报错并停止，不会悄悄回到缺省值。
- `news_debug`（可选，缺省 `true`）：加载器在页面左上角显示调试信息（加载到哪一步、主脚本与分词状态），点「JLPT 调试」收起，点「×」本页隐藏。设为 `false` 不显示；只接受 `true` 或 `false`，写成别的值（如 `"false"`、`0`、`null`）服务在启动时报错并停止。开关写在加载器里：改后需要让设备拿到新加载器才生效（重新放置，或提高 `LOADER_VERSION` 后在 Userscripts 里检查更新）。
- 加载器版本：脚本名称带加载器版本号（如 `JLPT 新闻查词 v2`），在 Userscripts 的脚本列表里就能看出手机上装的是哪一版。改动加载器文本时必须提高 `server/news_sites.py` 的 `LOADER_VERSION`（`test_loader_version_is_bumped_when_the_loader_changes` 会强制检查），设备在 Userscripts 里点「检查更新」才会换成新版（只有服务器给出的 `@version` 比已装的高才会更新）；主脚本不用任何操作，会自动更新。
- `news_online_update`（可选，缺省 `true`）：设为 `false` 时 `/api/news/loader.user.js` 和 `/api/news/client.js` 返回 404，设备上已装的版本保持不变，用来在开发完成后关闭在线更新；只接受 `true` 或 `false`，别的值服务在启动时报错并停止。
- **新增或修改网站后，重启服务，提高 `LOADER_VERSION`，再让设备检查更新（或重新放置加载器）**：`@match` 和整张网站表（含 `path`、`parts`）都写在已安装的加载器里，旧加载器不会在新网站上运行，也不知道新的选择器。

### 音调数字

查词卡显示音调数字，直接贴在读音后面（如「たいふう[3]」；读音不显示的假名词贴在词后面），来自分词词典 unidic-lite 的 `aType` 字段，经 `/api/news/tokenize` 的每个词的 `a` 字段返回（有两种时是 `"2,0"` 这样的文本，没有数据的词不带 `a`）。要点：数字是**词典形**的音调，屈折形（如「よびかけ[4]」）显示的也是原形「呼びかける」的数字；助词、符号、部分专有名词和外来词没有数据，卡片里就不显示；unidic-lite 是较老的 UniDic 2.1.2，个别词的数字可能与现行词典不同，需要精确时以词典为准。查词卡没有朗读按钮（`speechSynthesis` 在用户设备上点了没有声音，2026-11-09 取消）。

### 上线前人工检查

自动化测试与抽查测不到触屏手势和真实模型，上线前在真机上过一遍：

- 在 iPad 与 iPhone 上，分别在一篇雅虎文章里试：点词（查词卡）、查词卡显示读音和音调数字（没有朗读按钮）、长按选句（松手后才分析整句）、长按不松手直接拖出一个连续范围（如 AB、DE，松手后只分析这一部分）（拖动时选区上方应出现放大气泡，跟着手指的位置显示对应的词）、拖离句子（约 100px 以外）后气泡变红、页面高亮变灰，此时松手应取消且不发分析、打开面板（分析）、追问各一次。
- 打开一篇多页文章，翻到第 2 页后确认词仍被标出。
- 点右下角按钮，在菜单里选择模型（建议 DeepSeek-Flash）后再试分析与追问；`tests/llm/` 的真实模型测试见上。

### 状态目录

新闻在 `state/news/` 里现在只有两个文件：`glossary.sqlite`（查词释义，30 天过期）和 `settings.json`（所选模型）。取消令牌之前留下的 `devices.json`（和可能有的 `devices.json.corrupt-*`）不再被读取，可以手动删除，也可以留着。旧版留下的文章与图片目录由服务启动时的清理自动删除，不需要手动处理。

### 回滚

- 只回退服务进程：把 `/etc/systemd/system/jlpt.service` 的 `ExecStart` 改回 `/usr/bin/python3 -m server --config /srv/jlpt/state/config.json`，然后 `systemctl daemon-reload && systemctl restart jlpt.service`。旧版本代码不读 `llm`，多出的配置项无害。
- 连同代码回退：先把 `/srv/jlpt/app`、`/srv/jlpt/static` 切回上一个发布目录，再改回上面的 `ExecStart`。`/srv/jlpt/venv` 可以保留，也可删除回收约 250 MB。
- Caddy 的 `flush_interval -1` 不需要回滚；如需恢复，删掉该 `reverse_proxy` 的花括号块后 `caddy validate` 再 reload。
- `state/news/` 里的 `glossary.sqlite`、`settings.json`、`devices.json` 对旧版本无影响，回滚不需要处理。回退到 2026-11-09 之前的版本时，旧版需要的文章缓存会重新抓取。

### 上线记录（2026-11-08）

发布目录为 `/srv/jlpt/releases/20261108-news`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 都切到该目录，服务已重启。网页提交 `2714d50`（合并 `feat/news-reader`）。

- venv：用 `uv` 创建 `/srv/jlpt/venv`（本机没有 `python3.12-venv`），按 `requirements-news.txt` 安装，占用 251 MB；`fugashi.Tagger()` 可正常分词。
- 配置：`config.json` 新增 `llm`（`http://127.0.0.1:8790`，密钥为 qoder2api-hub 中的「JLPT新闻」，经环境变量传入，未在终端或日志中出现），权限仍为 600。备份在 `state/config.json.bak-20261108-news`。
- 服务单元：只把线上 `/etc/systemd/system/jlpt.service` 的 `ExecStart` 改为 `/srv/jlpt/venv/bin/python …`，线上原有的 `Restart=on-failure` 保留。备份在 `jlpt.service.bak-20261108-news`。
- Caddy：线上 `/etc/caddy/Caddyfile` 含仓库版没有的本地内容（VPN 管理、CloudCLI 的 `import` 和 `@existingSite` 匹配），因此没有用 `deploy/Caddyfile` 覆盖，只在 `@api` 的 `reverse_proxy` 中加入 `flush_interval -1`，`caddy validate` 通过后 reload。备份在 `Caddyfile.bak-20261108-news`。
- 模型：页头尚未选择模型，首次使用时在页头选择（建议 DeepSeek-Flash）。

验证：合并后的 main 上，276 项后端测试（含真实 Caddy，news venv）、89 项浏览器测试通过；上线前真实模型测试 6/6（DeepSeek-Flash）。上线后：本机与公网的 `/news/`、`/news/read.html`、`/review/`、`/grammar/`、`/papers.html`、`/code/` 未登录均为 303，`/api/news/feeds`、`/api/review/today` 为 401，与上线前一致；`news_probe.py --per-feed 1`（venv）成功 8 / 共 8，非雅虎图片 0；本机登录后模型列表 13 个、国内列表 8 条，打开一篇文章依次收到进度事件和文章（`text/event-stream`、`X-Accel-Buffering: no`，不含服务器内部缓存字段），图片 200（image/jpeg）。重启后 `jlpt.service` 内存约 22 MB。

注意：

- `scripts/configure_server.py` 会把 `study` 改写为 `~/projects/jlpt-study/.worktrees/web-study`，而线上实际使用 `/root/projects/jlpt-study`（该 worktree 不存在）。本次运行后已把 `study` 改回原值，只保留新增的 `llm`。以后重跑该脚本（包括 `deploy/install.sh`）后，必须核对 `study`。
- `deploy/install.sh` 会用仓库版覆盖 `/etc/caddy/Caddyfile` 和 `jlpt.service`，会丢掉上述线上本地内容；在仓库版合并这些内容之前，不要在本机直接运行 `install.sh`。
- 用户的 iPad 与 iPhone 实机检查（长按、拖选、面板）待进行。

回滚：把 `/srv/jlpt/app` 切回 `20261026-forget/app`、`/srv/jlpt/static` 切回 `20261026-forget-sticker/static`；把 `jlpt.service.bak-20261108-news` 复制回 `/etc/systemd/system/jlpt.service`，执行 `systemctl daemon-reload && systemctl restart jlpt.service`。Caddyfile 可保留，也可用 `Caddyfile.bak-20261108-news` 恢复后执行 `caddy validate` 并 reload。`config.json` 中的 `llm`、`/srv/jlpt/venv`、`state/news/` 对旧版本无影响。

### 上线记录（2026-11-09，新闻用户脚本）

发布目录为 `/srv/jlpt/releases/20261109-news-userscript`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 都切到该目录，`jlpt.service` 已重启（切换前确认没有子进程）。网页提交 `a263051`（合并 `feat/news-userscript`）。上一版本路径在发布目录的 `previous-release.txt`；发布前的 SQLite 一致性备份与 `config.json` 副本在私有的 `backup/`。

- 静态文件必须在源码检出目录里构建：`cd /root/projects/jlpt-web && node scripts/build-server.mjs /srv/jlpt/releases/<名称>/static`。在发布目录的 `app/` 里构建会失败（esbuild 找不到平台二进制，因为共享依赖目录不叫 `node_modules`）。构建会覆盖拷贝来的静态目录，但不会删除旧文件，所以构建后手工删除了 `static/news/`（旧阅读页）。
- 配置不变：`config.json` 没有 `news_sites`（用缺省的雅虎新闻），`llm`、`study` 保持原值；服务单元与 Caddyfile 未改动。启动时的清理删除了 `state/news/` 下两个旧文章目录，`glossary.sqlite`、`settings.json` 保留（`devices.json` 在首次安装设备时生成）。
- 所选模型为 DeepSeek-Flash（`settings.json`）。

验证：合并后的 `main` 上，`test:server` 240 项（系统 python，14 项因缺 fugashi 跳过）、`test:browser` 88 项、`test:client` 9 项通过；真实模型测试（`tests/llm`，经网关调用 DeepSeek-Flash）6/6；真实雅虎抽查 8/8。上线后，本机与公网未登录时 `/news-script/`、`/news/`、`/news/read.html`、`/review/`、`/grammar/`、`/papers.html`、`/code/` 均为 303，`/api/news/devices`、`/api/news/client.js`、`/api/news/feeds` 为 401。公网登录后：管理页 200；安装得到带令牌的加载器；带令牌取主脚本 200（66652 字节）；来自 `https://news.yahoo.co.jp` 的预检 204 且带正确的 CORS 头，来自其他来源 403；带令牌的分词 200；只带 Cookie 的雅虎来源 POST 403；模型列表 13 个；令牌不能列设备（403）；作废后令牌返回 401 并附重装地址。验证用的临时设备都已作废，设备列表为空。

**公网入口限制单次响应约 16 秒（已在 2026-11-09 的 `20261109-news-resumable-jobs` 解决，见该上线记录与「可续传的流」）：** 经公网地址（HTTP/2 入口）时，单次流式响应在 16.0 秒被切断（读到 `IncompleteRead`），已收到的数据不受影响，但之后的事件都丢失；同一请求直连服务（127.0.0.1:8765）和经本机 Caddy（127.0.0.1:8080）都完整完成。测试方法：用令牌调用 `/api/news/analyze` 与 `/api/news/ask`，分别直连、经 Caddy、经公网。结果：第一个数据事件在 16 秒内到达、总时长不到 16 秒的分析正常完成（单句约 8–10 秒）；两句段落、模型首次输出晚于约 12 秒的分析，在 16 秒被切断，服务器日志里没有记录。把心跳从注释行 `: ping` 改成数据事件 `event: ping` 没有用：心跳到达了，连接仍在 16.0 秒被切断，有数据流动时也一样（16.4 秒被切）。所以这不是心跳形式的问题，也不是本次代码的问题（上一版 20261108-news 用同样的流式方式，当时只做了本机验证）。影响：在 iPad / iPhone 上经公网使用时，较慢的分析和较长的追问可能中途失败。查词（`/api/news/gloss`）通常很短，不受影响。可选的处理方式见交接说明；决定前不要把它当作已验证。

回滚：把 `/srv/jlpt/app` 与 `/srv/jlpt/static` 切回 `/srv/jlpt/releases/20261108-news/` 下对应目录，`systemctl restart jlpt.service`。`config.json`、`/srv/jlpt/venv`、`state/news/` 对旧版本无影响；`state/news/devices.json` 旧版本不读取。

### 上线记录（2026-11-09，调试面板）

发布目录为 `/srv/jlpt/releases/20261109-news-debug`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 已切换，`jlpt.service` 已重启（切换前确认无子进程）。网页提交 `b9be795`（合并 `feat/news-debug-overlay`）。上一版本为 `20261109-news-userscript`，路径在发布目录的 `previous-release.txt`，发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。

内容：加载器与主脚本在屏幕左上角显示调试面板（加载器是否运行、网站匹配、取到主脚本的字节数、执行方式、主脚本状态、分词词数），不含令牌；配置项 `news_debug`（缺省开启，非布尔值会使服务启动失败）。加载器由服务器生成，所以已安装的设备必须重新安装才有面板。

验证：`test:server` 256 项（14 项因缺 fugashi 跳过）、`test:client` 13 项、`test:browser` 91 项通过；上线后公网端到端检查全部通过（登录、安装、主脚本、预检、分词、模型列表、流式分析、作废后 401），新生成的加载器含调试面板且 `debug` 为 true，临时设备已作废。

回滚：把 `/srv/jlpt/app`、`/srv/jlpt/static` 切回 `20261109-news-userscript` 下对应目录并重启服务；`news_debug` 配置项对旧版本无影响。

### 上线记录（2026-11-09，加载器版本号）

发布目录为 `/srv/jlpt/releases/20261109-news-loader-v2`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 已切换，`jlpt.service` 已重启（切换前确认无子进程）。网页提交 `faeabf8`（合并 `feat/news-loader-version`）。上一版本为 `20261109-news-debug`，路径在发布目录的 `previous-release.txt`，发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。

内容：新生成的加载器名称为 `JLPT 新闻查词 v2`（`@name`、`@version` 与调试面板第一行同一个常量 `LOADER_VERSION`），之后改动加载器文本必须升版本，否则 `test_loader_version_is_bumped_when_the_loader_changes` 失败。同时修了头部占位符按顺序替换、可能被网址或站点名里的占位符样文字干扰的问题。设备必须重装才会换成 v2。

验证：`test:server` 258 项（14 项因缺 fugashi 跳过）、`test:client` 13 项、`news-userscript` 浏览器测试 66 项通过；上线后公网端到端检查全部通过，新加载器头部 `@name` 为 `JLPT 新闻查词 v2`，临时设备已作废。

回滚：把 `/srv/jlpt/app`、`/srv/jlpt/static` 切回 `20261109-news-debug` 下对应目录并重启服务。

### 上线记录（2026-11-09，取消令牌）

发布目录为 `/srv/jlpt/releases/20261109-news-no-token`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 已切换，`jlpt.service` 已重启（切换前确认无子进程）。网页提交 `69ee85c`（合并 `feat/news-no-token`）及其后的文件名带版本号提交。上一版本为 `20261109-news-loader-v2`，路径在发布目录的 `previous-release.txt`，发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态文件在源码检出里构建，`grammar/images` 用硬链接复用上一版，相对上一版静态目录只少了 `news-script/index.html` 和 `manage.mjs`。

内容：取消令牌与设备管理，删除 `/news-script/` 管理页和各页导航里的入口；新增公开的 `GET /api/news/loader.user.js`（加载器 v3，头部带 `@updateURL` / `@downloadURL`）；`/api/news/*` 接受登录 Cookie 或站点表内的 `Origin`；新增配置项 `news_online_update`（线上 `config.json` 未设置，缺省开启）；`scripts/make_news_loader.py` 在本机生成 `build/jlpt-news-v3.user.js`，文件名带版本号。配置、服务单元、Caddyfile 均未改动。

验证：`test:server` 246 项（news venv，含 fugashi）、`test:client` 13 项、`test:browser`（`browser.test.mjs` 与 `news-userscript.test.mjs`）87 项通过；上线前真实雅虎抽查（`--feed it --per-feed 1`）成功。上线后公网检查：`loader.user.js` 不登录 200，且与本机生成的文件逐字节一致；`client.js` 带雅虎来源 200（67702 字节），无来源或来自其他网站 401；雅虎来源的预检 204（允许 `Authorization, Content-Type`），其他来源 403；雅虎来源的分词 200，其他来源 POST 403；`/api/news/devices`、旧安装地址未登录 401（登录后为 404）；`/news-script/`、`/review/`、`/grammar/`、`/papers.html`、`/code/` 未登录 303。雅虎来源的单句分析走公网 5 次，约 5–8 秒完成，事件以 `done` 结束。

未验证：Userscripts 的「检查更新」是否按 `@downloadURL` 原地替换（需真机）；公网 16 秒限制照旧（见上一条记录）。

回滚：把 `/srv/jlpt/app`、`/srv/jlpt/static` 切回 `20261109-news-loader-v2` 下对应目录并重启服务；旧版需要令牌，回滚后设备上的 v3 加载器（不发令牌）会得到 401，需要重新生成旧版加载器的设备安装一次。`state/news/devices.json` 没有被改动，回滚后旧令牌仍然有效。

### 上线记录（2026-11-09，长按后拖选）

发布目录为 `/srv/jlpt/releases/20261109-news-longpress-drag`，只切换了 `/srv/jlpt/static`（`/srv/jlpt/app` 仍是 `20261109-news-no-token/app`，服务未重启，加载器仍是 v3，设备上不用操作）。网页提交 `6c1a50e`（合并 `feat/news-longpress-drag`）。上一版本静态目录在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态目录相对上一版只有 `news-script/client.js` 不同。

内容：长按句子只高亮、松手后才分析；长按后手指不抬继续拖，选出从按下的词到手指下的词的连续范围，松手后只分析这一部分；长按触发后到松手前页面不随手指滚动，触摸取消时撤回高亮。

验证：`test:browser` 93 项、`test:client` 13 项、`test:server` 248 项（news venv）通过，新增的 3 组长按用例在旧代码上失败。上线后公网 `client.js`（带雅虎来源）200，与发布目录逐字节一致，含新逻辑；加载器 200；无来源取 `client.js` 401；各页面未登录 303；服务仍在运行。**未验证：真机上长按后拖动是否被 iOS 抢走手势，需要在 iPad / iPhone 上试。**

回滚：把 `/srv/jlpt/static` 切回 `20261109-news-no-token/static`，不需要重启。

### 上线记录（2026-11-09，放大气泡）

发布目录为 `/srv/jlpt/releases/20261109-news-loupe`，只切换了 `/srv/jlpt/static`（`/srv/jlpt/app` 仍是 `20261109-news-no-token/app`，服务未重启，加载器仍是 v3，设备上不用操作）。网页提交 `79b2aa3`（合并 `feat/news-loupe`）。上一版本静态目录是 `20261109-news-longpress-drag/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态目录相对上一版只有 `news-script/client.js` 不同。

内容：长按拖选时，选区第一行上方显示放大气泡（`news-client/loupe.mjs`）：用句子自己的词重新排一行约 24px 的大字，以手指下的词为中心，选区深黄、整句浅黄、手指下的词加粗加下划线，词间留细缝；随手指横向移动，不接收触摸，松手或取消即消失；第一行不在屏幕内或离手指超过 200px 时放在手指行上方，上方没有空间时放到选区下方。放大的是重新排版的文字，不是页面原样。

验证：`test:browser` 97 项（含新增 4 条）、`test:client` 13 项、`test:server` 248 项（news venv）通过，并截图核对了样式与位置。上线后公网 `client.js`（带雅虎来源）200，与发布目录逐字节一致且含新逻辑；加载器 200；无来源取 `client.js` 401；各页面未登录 303；服务仍在运行。

已知：加载器的调试面板（`news_debug` 默认开，层级高于主脚本的浮层）出现在左上角时会盖住放大气泡的一部分；关掉需要把 `news_debug` 设为 `false` 并升加载器版本。未验证：真机上的长按拖动手感与气泡位置。

回滚：把 `/srv/jlpt/static` 切回 `20261109-news-longpress-drag/static`，不需要重启。

### 上线记录（2026-11-09，拖选取消）

发布目录为 `/srv/jlpt/releases/20261109-news-cancel-drag`，只切换了 `/srv/jlpt/static`（`/srv/jlpt/app` 仍是 `20261109-news-no-token/app`，服务未重启，加载器仍是 v3，设备上不用操作）。网页提交 `c2c08fb`（合并 `feat/news-cancel-drag`）。上一版本静态目录是 `20261109-news-loupe/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态目录相对上一版只有 `news-script/client.js` 不同。

内容：长按拖选时，手指离句子里最近的词超过 100px（`CANCEL_DISTANCE_PX`，`news-client/reader.mjs`）就进入“将取消”状态：页面高亮变灰，放大气泡变红并显示“松手取消”；此时松手不选择、不分析，选区回到长按之前的状态；回到句子附近则恢复。气泡里多一行提示“拖离句子后松手可取消”。长按后不拖、直接滑远再松手也是取消。原来“拖到页面最下方、标题上方仍吸附”的用例改成了取消；句尾下方 30px、句首上方 30px 等 100px 以内仍吸附到最近的词。

验证：`test:browser` 99 项（含新增的取消用例，iPad 与 iPhone 各一）、`test:client` 13 项、`test:server` 248 项（news venv）通过。上线后公网 `client.js`（带雅虎来源）200，与发布目录逐字节一致且含新逻辑（`jlpt-cancel` 与“松手取消”的转义串都在，esbuild 会把中文写成 `\u` 转义，所以不能直接 grep 中文）；加载器 200；无来源取 `client.js` 401；各页面未登录 303；服务仍在运行。未验证：真机上 100px 这个阈值的手感（误触或不够灵敏时改 `CANCEL_DISTANCE_PX` 即可，只需重新构建并切换静态目录）。

回滚：把 `/srv/jlpt/static` 切回 `20261109-news-loupe/static`，不需要重启。

### 上线记录（2026-11-09，音调数字）

发布目录为 `/srv/jlpt/releases/20261109-news-pitch-accent`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 都已切换，`jlpt.service` 已重启（切换前确认无子进程）。这次改了服务端，所以与前几次只切静态目录的发布不同。网页提交 `b8a1d5c`（合并 `feat/news-pitch-accent`）。上一版本为 app `20261109-news-no-token/app`、static `20261109-news-cancel-drag/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。`/srv/jlpt/venv`、配置、服务单元、Caddyfile 均未改动；加载器仍是 v3，设备上不用操作。

内容：查词卡取消朗读按钮（🔊 与 `speechSynthesis` 代码），改为显示音调数字；`/api/news/tokenize` 给有数据的词多返回 `a`（unidic-lite 的 `aType`，文本，如 `"3"`、`"2,0"`），说明见上文「音调数字」。

验证：`test:server` 249 项（news venv，含真实词典的音调用例）、`test:browser` 101 项、`test:client` 13 项通过。上线后公网：分词返回的音调与词典一致（台風[3] 強い[2] 勢力[1] 島[2] 接近[0] 準備[1] 呼びかけ[4]），助词、符号不带 `a`；`client.js`（带雅虎来源）200 且与发布目录逐字节一致、含新卡片代码；预检 204；其他来源 POST 403；无来源取 `client.js` 401；加载器 200；模型列表 200；单句分析约 5 秒以 `done` 结束；查词 200；各页面未登录 303；重启后服务正常。

回滚：把 `/srv/jlpt/app` 切回 `20261109-news-no-token/app`、`/srv/jlpt/static` 切回 `20261109-news-cancel-drag/static`，`systemctl restart jlpt.service`。多出的 `a` 字段对旧主脚本无影响。

### 上线记录（2026-11-09，音调数字贴在读音后面）

发布目录为 `/srv/jlpt/releases/20261109-news-accent-inline`，只切换了 `/srv/jlpt/static`（`/srv/jlpt/app` 仍是 `20261109-news-pitch-accent/app`，服务未重启，加载器仍是 v3，设备上不用操作）。网页提交见 `main` 上合并 `feat/news-accent-inline` 的提交。上一版本静态目录是 `20261109-news-pitch-accent/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态目录相对上一版只有 `news-script/client.js` 不同。

内容：查词卡的音调数字与读音写在同一元素、中间无间隔（`せいりょく[1]`），不再写“音调”二字（悬停提示仍是“音调 [1]”）；读音不显示的假名词贴在词形后面（`する[0]`）；两种音调写成 `[1]/[2]`；“原形”那一行不再带数字。屈折形读音后面的数字仍是原形的音调。

验证：`test:browser` 101 项、`test:client` 13 项、`test:server` 249 项（news venv）通过。上线后公网 `client.js`（带雅虎来源）200，与发布目录逐字节一致且含新卡片代码；加载器 200；无来源取 `client.js` 401；各页面未登录 303；服务仍在运行。

回滚：把 `/srv/jlpt/static` 切回 `20261109-news-pitch-accent/static`，不需要重启。

### 上线记录（2026-11-09，可续传的流）

发布目录为 `/srv/jlpt/releases/20261109-news-resumable-jobs`，`/srv/jlpt/app` 与 `/srv/jlpt/static` 都已切换，`jlpt.service` 已重启（切换前确认无子进程）。网页提交 `51b6f6d`（合并 `feat/news-resumable-jobs`）。上一版本为 app `20261109-news-pitch-accent/app`、static `20261109-news-accent-inline/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。`/srv/jlpt/venv`、配置、服务单元、Caddyfile 均未改动；加载器仍是 v3，设备上不用操作（主脚本自动更新）。

内容：根因是云平台 HTTPS 代理把单次响应在约 16 秒切断，而分析常超过 16 秒（本机实测 10–29 秒），详见上文「可续传的流」。

验证：`test:server` 263 项（news venv）、`test:browser` 101 项、`test:client` 23 项通过。上线后公网（用与脚本相同的续接逻辑）连续 6 次分析全部以 `done` 结束，总耗时 10.1–21.2 秒，其中 4 次超过 16 秒（旧版会被切断），每个连接都在约 12 秒结束（最长 12.4 秒）；追问 4.3 秒完成；`analyze` 响应带 `X-News-Job` 与 `Access-Control-Expose-Headers`；`resume`、`cancel` 的预检 204 且来源正确；未知任务的 `resume` 返回可重试的「这次回答已过期」；`client.js` 与发布目录逐字节一致；各页面未登录 303，无来源 `models` 401，其他来源 POST 403。

回滚：把 `/srv/jlpt/app` 切回 `20261109-news-pitch-accent/app`、`/srv/jlpt/static` 切回 `20261109-news-accent-inline/static`，`systemctl restart jlpt.service`。回滚后 16 秒问题回来；已打开页面里的新主脚本遇到旧服务端（响应没有 `X-News-Job`）会按旧方式处理，不会出错。

### 上线记录（2026-11-09，现代界面与主题）

发布目录为 `/srv/jlpt/releases/20261109-news-modern-ui`，只切换了 `/srv/jlpt/static`（`/srv/jlpt/app` 仍是 `20261109-news-resumable-jobs/app`，服务未重启，加载器仍是 v3，设备上不用操作）。网页提交 `37c23ee`（合并 `feat/news-modern-ui`）。上一版本静态目录是 `20261109-news-resumable-jobs/static`，路径在发布目录的 `previous-release.txt`；发布前 SQLite 备份与 `config.json` 副本在私有 `backup/`。静态目录相对上一版只有 `news-script/client.js` 不同。

内容：脚本自带界面换成磨砂圆角风格。右下角状态钮改为带状态点的胶囊（就绪绿、分词中琥珀并呼吸、出错红）；放大镜的气泡改为磨砂圆角，手指下的词是强调色胶囊；点词卡片、分析面板、提问栏统一圆角与阴影。新增 `news-client/theme.mjs`：界面主题默认跟随页面（按 `<body>` / `<html>` 的背景色判断深浅，页面改类名或样式、系统外观变化时重新判断），菜单里可手动选「跟随页面 / 浅色 / 深色」，选择记在新闻站域名下的 `localStorage`（`jlpt-news-theme`）。文章页上的黄色选中高亮写在页面里，不随主题变化。只改外观，布局与手势不变。

验证：`test:client` 27 项、`test:browser` 里 `news-userscript` 77 项、`test:server` 263 项（news venv）通过。上线后公网带雅虎来源取 `client.js` 200，与发布目录逐字节一致且含新界面代码；无来源取 `client.js` 401；加载器 200；各页面未登录 303；无来源 `models` 401；服务仍在运行。

构建提示：浏览器测试读的是构建出来的 `server-public/news-script/client.js`，改了 `news-client/` 后要先运行 `node scripts/build-server.mjs`，否则测的是旧代码。

回滚：把 `/srv/jlpt/static` 切回 `20261109-news-resumable-jobs/static`，不需要重启。

### 上线记录（2026-11-09，turmony.site 导航页）

内容：用域名 `turmony.site` 和 `www.turmony.site` 访问服务器上的多个网页。根路径显示一张导航页，四个卡片：JLPT 学习站（`/review/`）、Claude Code 网页端（`/code/`）、VPN 管理（`/vpn-admin/`）、Qoder 管理（`https://api.turmony.site/`，即 qoder2api-hub 的管理页，原本就由 tunnel 对外）。导航页只有链接，没有数据和脚本，浅色深色跟随系统。各网页仍使用各自的登录方式。

链路：域名的 DNS 在 Cloudflare，经服务器上已有的 Cloudflare Tunnel（`cloudflared.service`，隧道 `426b9d62-…`）到本机 Caddy `:8080`，不经过云平台那个 16 秒的 HTTPS 代理。云平台原有域名的行为不变。

文件与配置（仓库里的 `deploy/portal/` 是源，服务器上是拷贝）：

- `deploy/portal/index.html` → `/srv/portal/index.html`。
- `deploy/portal/portal.caddy` → `/etc/caddy/portal.caddy`：只在 Host 为 `turmony.site` / `www.turmony.site` 且路径为 `/` 或 `/index.html` 时返回导航页；其他路径、其他域名走原有规则。在 `/etc/caddy/Caddyfile` 的 `route {` 里第一行 `import /etc/caddy/portal.caddy`。
- 应用只接受 `Origin` 等于 `config.json` 里 `origin` 的 POST，所以从 turmony.site 登录会被 403。没有改应用代码，而是在 Caddyfile 的 `/api/*` 反向代理里加一行，把恰好是 `https://turmony.site` 或 `https://www.turmony.site` 的 Origin 改成配置里的 origin：`header_up Origin "^https://(www\.)?turmony\.site$" "<config.json 里的 origin>"`。其他来源（例如 `https://evil.example`）仍是 403。
- `/etc/cloudflared/config.yml` 的 `ingress` 在 `api.turmony.site` 之后、兜底 404 之前加两条：`turmony.site` 和 `www.turmony.site`，都指向 `http://127.0.0.1:8080`。
- DNS：`cloudflared tunnel route dns 426b9d62-c26d-492b-b204-61b72d1ee965 turmony.site`，`www.turmony.site` 同理。

验证：本机用两个 Host 请求 `/` 200、`/vpn-admin/` 200、`/review/` 与 `/code/` 303 到登录页，云平台域名行为不变；登录 POST 带 turmony.site 来源时错误密码得 401（不是 403），带陌生来源仍 403。公网 `https://` 与 `http://` 的两个域名首页都是 200，WebKit iPhone 手机宽度浅色/深色无横向滚动。Cloudflare 会往页面注入统计脚本，被页面的 CSP 拦下，控制台有一条无害报错。

备份：`/etc/caddy/Caddyfile.before-portal`、`/etc/cloudflared/config.yml.before-portal`。

回滚：把这两个备份拷回原位，`systemctl reload caddy`、`systemctl restart cloudflared`；DNS 里删掉 turmony.site 和 www 两条 CNAME。
