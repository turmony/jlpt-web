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
2. 选择 CLI，输入自由文本，预览实际完整任务提示词，再执行。改变输入或对话后需重新预览。
3. 智能体要求补充信息或运行失败时，选择原任务，输入后续提示并重新预览。会话保持原 CLI。
4. 出卷检查通过后打开试卷，草稿自动保存；答案与解析可随时查看。多标签页冲突时，本页答案保留，可选择服务器版本或保存本页作答。
5. 正式交卷只发生一次并锁定答案。网页填入判卷提示词，预览后执行。判卷检查通过后保存成绩并产生一次本地 Git 提交。
6. Git 提交失败时使用“重试本地提交”；不会重新调用 CLI 或重复追加历史作答。

当前服务器 Codex 已安装并确认登录，真实调用与恢复同一会话已验证。Antigravity 已安装，真实调用能够启动并返回会话 ID，但 API 返回 `FAILED_PRECONDITION: User location is not supported for the API use`，目前无法执行模型任务；页面显示上次实际错误。Qoder 未安装，选项禁用。不会自动切换 CLI。CLI 的用户认证和会话文件沿用服务器当前账户的本地配置。

## 目录与边界

| 目录 | 内容 |
| --- | --- |
| `/srv/jlpt/app` | 网站与后台代码 |
| `/srv/jlpt/static` | 网站和固定资料版本的 960 张本地图片 |
| `/srv/jlpt/state` | 密码配置、SQLite、登录和任务状态 |
| `/srv/jlpt/repos/jlpt-study` | 资料克隆和 worktree 管理 |
| `/srv/jlpt/worktrees/study` | 长期 `web-study` 分支、练习资料和 CLI 工作目录 |

目录与图片固定到 `data/catalog.json` 的提交，不从原仓库自动更新。初次同步用 `git archive` 读取该提交的真实图片，不受当前工作区未提交图片影响。安装脚本重复运行不会重置学习分支或替换已有密码。

单一后台进程持有持久状态锁，单一 worker 串行运行 CLI 与提交。重启后中断任务显示可继续；已验证的判卷显示提交待重试。systemd 终止整个进程组，避免旧 CLI 在重启后继续写入。

模型通过每轮 `jlpt-notes/quizzes/web/<task-id>/turn-<n>.json` 返回 `generate`、`grade` 或 `clarify`。后台复用资料库 `quiz_pipeline.py` 的 final 校验及渲染器，核对试卷、答案和题卡，验证考点、题量、题型及证据路径，再实际运行试卷、图片链接和阅读器链接校验。旧资料中人工修改、与 manifest 不一致的试卷不能直接作为新网页试卷交付，需要模型按当前流程处理。

判卷需交接正确的 submission ID、逐题记录、分数和完整报告。后台检查锁定答案、题号、评分、报告六要素及判定标记；正式作答以 JSON 和原技能 `N-答案` / `*N-语序` 格式导出。后台为 `attempts.jsonl` 追加带 `web_submission_id` 的原 schema 记录，保留历史字节，重复操作不会再次追加。

提交使用独立 Git index 和提交记录中的稳定交卷 ID，仅包含关联试卷、答案、题卡、manifest、采用证据、正式作答、成绩、交接记录和 attempts。提交后同步这些路径的普通 index，保留其他已暂存修改。不提交临时 draft、日志、未采用证据或无关改动；共享题源缓存的索引保留在工作区，采用证据及来源元数据已保存在对应 manifest 中。原资料仓库的 push URL 设置为不可用的本地路径；后台没有任何推送操作。

机械检查验证结构与可核实记录。题源真实性、日语正确性、唯一解及排序题自然程度仍由资料库流程与独立审题负责，后台不宣称能用结构校验证明这些语言判断。

## 部署与维护

需要 Ubuntu 24.04、Python 3.12+、Node 22+、Git、uv，以及已安装和登录的所选 CLI。将仓库代码复制到 `/srv/jlpt/app` 后执行：

```bash
cd /srv/jlpt/app
bash deploy/install.sh https://你的云平台HTTP代理域名
systemctl status jlpt caddy
```

查看运行记录：`journalctl -u jlpt -u caddy`。重新部署前后保留 `/srv/jlpt/state`、`repos`、`worktrees`，不要删除长期学习 worktree。备份时一并保存这些目录；SQLite 可使用 `.backup` 或停服务复制，避免只复制活动数据库而漏掉 WAL。

开发验证：

```bash
node scripts/build.mjs
node scripts/build-server.mjs
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

CLI 调用依据已核对的 [Codex 非交互模式](https://developers.openai.com/codex/noninteractive)、[Qoder 脚本模式](https://docs.qoder.com/cli/run-in-scripts) 与 [Antigravity 非交互模式](https://antigravity.google/docs/cli/headless/)。没有云平台 HTTPS 代理且直接使用公网 IP 时，需要另行配置公网验证及可信 IP 证书；[Certbot 的 IP 证书支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot) 不适用于当前只有 SSH 端口映射的入口。
