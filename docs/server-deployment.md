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

1. 登录后选择语法记忆或智能体练习。
2. 在聊天输入框底部选择 CLI、模型和推理强度，输入自由文本后直接发送。发送给智能体的提示词就是输入原文，保留空格、换行和斜杠文本；模型及强度作为独立参数传入。根据提示词处理普通问答、出卷或判卷。
3. 智能体要求补充信息或运行失败时，选择原任务，输入后续提示后直接发送。会话保持原 CLI；新建对话后可选择其他 CLI。
4. 桌面页面左侧管理对话，中间聊天，右侧管理试卷与产物，各区域独立滚动。出卷检查通过后在右侧打开试卷，草稿自动保存；答案与解析可随时查看。手机通过“对话列表”和“试卷与产物”切换面板。多标签页冲突时，本页答案保留，可选择服务器版本或保存本页作答。
5. 正式交卷只发生一次并锁定答案。网页自动选择判卷操作并填入可编辑的目标试卷提示词，直接发送。判卷检查通过后保存成绩并产生一次本地 Git 提交。
6. Git 提交失败时使用“重试本地提交”；不会重新调用 CLI 或重复追加历史作答。

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

每轮启动 CLI 前，后台将网页交接规则作为标记区块写入工作区根 `AGENTS.md`，保留原有规则，重复执行不会重复追加。当前任务编号、轮次、交接路径和正式作答上下文单独写入 `jlpt-notes/quizzes/web/current-turn.json`，模型按工作区规则每轮读取。这两个工作区文件不加入学习成果提交，后台继续独立校验所有实际产物。

普通问答有可显示的回复且未修改练习产物时直接完成，无需创建交接文件。模型出卷、判卷或修改练习产物时，通过每轮 `jlpt-notes/quizzes/web/<task-id>/turn-<n>.json` 返回 `generate`、`grade` 或 `clarify`。后台复用资料库 `quiz_pipeline.py` 的 final 校验及渲染器，核对试卷、答案和题卡，验证考点、题量、题型及证据路径，再实际运行试卷、图片链接和阅读器链接校验。旧资料中人工修改、与 manifest 不一致的试卷不能直接作为新网页试卷交付，需要模型按当前流程处理。

判卷需交接正确的 submission ID、逐题记录、分数和完整报告。后台检查锁定答案、题号、评分、报告六要素及判定标记；正式作答以 JSON 和原技能 `N-答案` / `*N-语序` 格式导出。后台为 `attempts.jsonl` 追加带 `web_submission_id` 的原 schema 记录，保留历史字节，重复操作不会再次追加。

提交使用独立 Git index 和提交记录中的稳定交卷 ID，仅包含关联试卷、答案、题卡、manifest、采用证据、正式作答、成绩、交接记录和 attempts。提交后同步这些路径的普通 index，保留其他已暂存修改。不提交临时 draft、日志、未采用证据或无关改动；共享题源缓存的索引保留在工作区，采用证据及来源元数据已保存在对应 manifest 中。原资料仓库的 push URL 设置为不可用的本地路径；后台没有任何推送操作。

机械检查验证结构与可核实记录。题源真实性、日语正确性、唯一解及排序题自然程度仍由资料库流程与独立审题负责，后台不宣称能用结构校验证明这些语言判断。

## 部署与维护

智能体对话复用 [AionUi v1.9.25 源码](../vendor/aionui/README.md)，而非仅模仿外观。`agent/` 将上游 `AcpConnection` 接到 Python worker，`chat/` 将持久事件映射到上游消息组件。原有出卷、交卷、判卷与本地提交仍由后台校验。工具调用、思考、错误和回复分别显示，原始日志收在“运行诊断”。手机通过“对话列表”切换历史。

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
