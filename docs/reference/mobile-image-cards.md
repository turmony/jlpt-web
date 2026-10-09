# iPhone 在线图片卡

页面部署到 Cloudflare Pages。手机只连接页面自己的域名，Cloudflare 收到图片请求后从 GitHub 拉取原图。发布包只有界面、卡片目录和 `_worker.js`，不包含原图；部署后电脑可以关机。界面保留 Anthropic 风格的暖深灰、米白、陶土色与全非衬线字体。

已上线：[https://jlpt-image-cards.pages.dev/](https://jlpt-image-cards.pages.dev/)。2026-10-09 已在用户 Cloudflare 账号创建独立 Direct Upload 项目并发布，生产分支 `main`，当前部署 `32b039d0`（仅保留两个动态快捷区间）。手机可直接打开；按用户选择，暂不启用自动更新。

## 使用

1. 选择 N5–N1 和起止编号，例如 N1 31–40，包含两端。
   起止编号下方只显示前一区间／后一区间两个快捷链接，长度与当前区间一致，已移除原有四个固定区间。例如输入 41–50，会生成 31–40 和 51–60；点击直接替换起止数字并更新相邻区间。当前输入、等级及这两组的四个数字即时保存在浏览器本地，未开始阅读也能保存，刷新后恢复，不设置日期过期，也不随图片缓存清理。临时输入无效时不覆盖上次有效记录；超出 1–9999 的相邻区间不可用。
2. 点击「开始看图」。相同范围会继续上次看的卡片。
3. 点击缩略图打开大图。左侧 18% 单击上一张，其余区域单击下一张；双击切换接续／例句。首尾不循环，换卡回到接续图。
4. 底部按钮也能翻卡、切图。支持双指缩放，缩放后点按不翻卡；关闭按钮或浏览器返回退出大图。
5. 编号跳转限当前范围。「更换范围」返回选择页。

缩略图使用固定高度的显示框（随屏幕宽度取 200–280px，同一屏幕换卡时不变），图片等比完整显示。进度与上一张／下一张按钮紧接图片框，标题使用独立外层容器固定占用两行高度，超过两行省略显示，短标题也预留两行，不依赖文字本身撑开空间。失败重试放在图片框内；图片大小、标题长度、加载及失败状态均不推动翻页按钮或跳转输入框、前往按钮。大图控制仍固定在视图底部。

缺卡或未配双图时说明具体卡号。N1–N4 当前每级 120 张双图卡，N5 当前 118 张卡尚未配课程图片。图片失败或 20 秒超时可重试，Cloudflare 上游下载最多等待 15 秒。阅读位置仅保存在当前浏览器，不写入学习资料或复习事件。

## 按需图片与当天缓存

```text
打开页面 → 下载轻量卡片目录
选择 N1 31–40 → 请求这一区间的 20 张图片（最多两路后台预取）
手机已有当天、同版本缓存 → 直接读取
没有缓存 → 本站 /images/完整SHA/… → Cloudflare → GitHub 固定提交原图
成功下载且解码 → 保存手机当天缓存 → 显示
本地午夜 / 次日打开 / 回到前台 / 读取图片 → 清理非当天缓存
```

上限 100 MiB，超限时淘汰最久未使用的图片。单图超过上限、下载失败、超时或无法解码都不入缓存。同日同时请求同一图片共用一次下载；资料版本不同不会读错旧图。转发响应和浏览器网络请求都禁用普通 HTTP 缓存，避免浏览器额外长期保留一份图片。

浏览器关闭或手机休眠时不能执行清理，次日清理在下一次打开或回到前台完成。阅读位置独立保存。存储不可用时继续在线加载；存储操作超过 1.5 秒中止，本次访问绕过缓存。页面和目录仍需网络，整站不承诺离线可用。

转发程序只接受当前目录实际引用的图片路径，固定 GitHub 仓库和完整提交 SHA，不接受任意远程 URL。未知路径不请求 GitHub，失败响应不缓存。`_routes.json` 仅让 `/images/*` 调用函数，其余文件由 Pages 静态托管。实现依据：[Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)、[Functions routing](https://developers.cloudflare.com/pages/functions/routing/)。

## 资料更新与自动构建

构建从同一个 Git 提交读取卡片元数据和正文图片地址，按 Markdown 所在目录解析并通过 `AssetIndex` 校验；不修改原资料。无标签的双图按 `source.screenshot` 精确路径区分接续图。发布包不复制图片，构建时仅在临时 Git 快照中校验已有原图。

只有下列目录变化才自动触发 `.github/workflows/mobile-pages.yml`：

```text
jlpt-notes/grammar/n1/**
jlpt-notes/grammar/n2/**
jlpt-notes/grammar/n3/**
jlpt-notes/grammar/n4/**
jlpt-notes/grammar/n5/**
```

推送到 `main` 会构建、测试、发布到 Cloudflare；目标为 `main` 的 PR 只构建校验。其他路径变化不触发，包括单独修改图片。仅更新图片时，应同时修改对应语法文档，或手动运行 Actions 工作流。页面代码修改也需要手动触发。保留 `workflow_dispatch` 用于首次发布与手动更新。

使用 GitHub Actions 管理发布；创建 Cloudflare Direct Upload 项目，避免另开全仓库自动构建。若已有 Git 集成项目，先关闭其生产及预览自动构建，再由 Actions 发布。[Wrangler Action](https://github.com/cloudflare/wrangler-action) 支持 Pages 部署。

所有图片固定到发布版本的 SHA。最新提交中改图不会改变旧版本图片；自动或手动重新部署后，目录和图片地址一起更新。未提交或未推送资料不会出现在网站上。

## 首次发布：直接上传轻量 ZIP

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **Workers & Pages → Create application → Pages → Upload assets / Drag and drop**。
2. 填项目名，例如 `jlpt-image-cards`，上传新包 **`jlpt-mobile-proxy.zip`** 并部署。ZIP 根目录直接包含 `index.html`、`catalog.json`、`_worker.js`、`_routes.json`，没有原图目录。
3. 手机 Safari 打开控制台给出的 `https://项目名.pages.dev`，可添加到主屏幕；移动网络或其他 Wi-Fi 均可访问，仍需实际验证所在网络到 Cloudflare 的连通性。
4. 后续在同一项目上传更新，保持正式网址；需要自动更新时按下一节配置。

Cloudflare 控制台拖放支持已经生成的 `_worker.js`，无需另外上传 `functions/` 文件夹。参考 [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。本次生成的包使用已推送的 `origin/main`，因此引用的 GitHub 图片在线可用。

2026-10-09 轻量包：`jlpt-mobile-proxy.zip` 为 45,011 字节（约 44 KiB），解压约 448 KiB，共 12 个文件、0 张原图。目录包含 598 张卡片和 960 个按需图片地址，资料提交 `ebab880de725e47bf138e457b705eede494292d4`。

## 配置自动发布

先创建 Pages 项目（可按上节首次上传），将生产分支设置为 `main`。在 GitHub 仓库 **Settings → Secrets and variables → Actions** 设置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 具有对应账号 **Account → Cloudflare Pages → Edit** 权限的 API Token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | Pages 项目名；不填默认 `jlpt-image-cards` |

提交并推送网站代码与工作流后，在 **Actions → iPhone image cards (Cloudflare) → Run workflow** 首次运行。之后仅上述语法目录变动触发自动构建。Token 只存 GitHub Secrets，不放进代码或 ZIP。没有配置账号时工作流仍先测试并保存轻量产物，发布步骤会明确提示缺少配置。

此方案需要 Cloudflare 的函数运行能力，不能把这个代理包原样部署到 GitHub Pages；GitHub Pages 只提供静态文件托管。

## 自行构建与预览

在项目根目录执行。已推送版本使用 `origin/main`；需要刷新远端分支时先 `git fetch origin main`。

```bash
uv run python -m jlpt_notes.mobile_site --revision origin/main --output /tmp/jlpt-mobile-proxy-release
npx wrangler pages dev /tmp/jlpt-mobile-proxy-release --ip 127.0.0.1 --port 8788
```

打开 <http://127.0.0.1:8788>。普通 `http.server` 无法执行图片代理。默认不指定 `--revision` 时读取 HEAD，HEAD 必须已推送，否则 GitHub 图片 404。请使用新的输出目录；构建发现旧版图片目录会拒绝，防止误打包残留原图。

本机连接 GitHub 需要系统 HTTP 代理，当前 workerd 本地出站请求没有使用该代理，会触发 15 秒超时；这不会改变发布包的 GitHub 地址。本次通过系统代理获取真实原图，再以本地测试图片源验证 workerd 的转发响应、HEAD 和路径限制；公网 Cloudflare 到 GitHub 的连接仍需发布后验证。

也可以登录自己的 Cloudflare 账号后用命令发布：

```bash
npx wrangler login
npx wrangler pages deploy /tmp/jlpt-mobile-proxy-release --project-name jlpt-image-cards --branch main
```

已由 Wrangler 使用电脑上现有的 Cloudflare 登录完成发布。后续手动更新可复用同一项目与命令。自动更新所需的长期 API Token 尚未配置；当前 OAuth 登录可以部署，但不具备代建 API Token 权限（API 返回 403），用户选择先使用现有网站。

Wrangler 4.149.0 首次创建项目时会尝试委托给 Workers，当前发布格式需要 Pages 的 `_worker.js` 路由。本次初次创建使用 `wrangler pages project create jlpt-image-cards --production-branch main --force` 创建 Pages 项目；现有项目更新正常使用 `wrangler pages deploy` 即可。

## 验证

```bash
uv run python -m pytest tests/test_mobile_site.py -q
npm ci --prefix mobile
npm --prefix mobile test
npm exec --prefix mobile -- playwright install --with-deps webkit
JLPT_MOBILE_SITE=/tmp/jlpt-mobile-proxy-release npm --prefix mobile run test:browser
```

Python 验证链接解析、提交隔离、不复制图片和旧输出保护。Node 验证范围、单双击与代理路径限制、失败及超时。WebKit 浏览器通过实际生成的代理程序与仓库图片验证 20 图范围、手势、返回、重试、当天缓存、次日清理和容量淘汰；浏览器直连 GitHub 被阻断以验证同源流程。正式上线后还需在实际 iPhone Safari 验证网络和双指缩放。

本次定向验证：Python 12 项、核心与代理 Node 17 项、WebKit 与缓存 19 项通过；Ruff 与 `git diff --check` 通过。Cloudflare workerd 4.149.0 使用真实 GitHub 原图的本地图片源验证成功，响应 `image/png`、`no-store`，未知路径不访问图片源；另验证正式代理的上游超时返回 504。ZIP 完整性、零原图、960 个目录 URL 与代理白名单一致，以及工作流五目录过滤均已检查。

公网发布后已实际请求首页、卡片目录与 N1 31–40 全部 20 张图片：全部 200，图片合计 12,926,613 字节，均为 PNG 且 `Cache-Control: no-store`；未知图片路径返回 404。已验证 Cloudflare 到 GitHub 的真实连通性。

线上 WebKit 手机视口验证通过：手机只向本站请求 20 张图，双击切到例句，刷新后继续阅读时新增图片请求为 0，当天缓存复用，无横向溢出。测试客户端因本机网络限制使用系统代理；实际手机网络仍由用户打开正式地址确认。Cloudflare API 确认生产部署状态 `success`，项目无 Git 自动构建来源。

固定图片框修复后，20 项浏览器与缓存测试通过。新增布局回归覆盖 900×90 横图、90×900 竖图、多行标题、等待下载和图片失败，在 375px 竖屏及 812px 横屏分别校验图片框与翻页按钮的坐标、尺寸不变，并检查大图切图按钮不移动。

固定两行标题后，扩展同一回归测试验证标题始终占用两行高度，以及短标题、长标题、图片加载和失败状态下的跳转输入框、前往按钮位置和尺寸不变；20 项浏览器与缓存测试通过。

独立标题外层与持久快捷区间更新：核心与代理 19 项、浏览器与缓存 23 项通过。新增验证 375×667、320×568 小屏滚动后切换单行／长标题时跳转区的视口坐标不变；快捷区间未开始阅读也可保存并优先于旧阅读记录恢复，前后组点击填写、无存储降级、无效输入不覆盖有效保存、次日清理保留快捷数字。独立代码审查未发现 Critical／Important 问题。仅保留两个快捷链接后，定向两项浏览器测试通过。

部署 `b01e0636` 后，线上 WebKit 验证 41–50 生成 31–40／51–60，四个数字已存储，刷新恢复、点击填写通过；滚动状态下 N1 31–33 换卡时跳转区视口坐标不变，独立标题占位高度 75.89px。公网 HTML、CSS、app 和 core 文件均与发布产物一致，UI 资源版本查询确保刷新加载本次更新。
