# JLPT 语法记忆页面

现已加入个人服务器版本：密码登录、语法记忆及智能体练习。部署入口、使用流程、CLI 状态和维护方法见 [服务器部署说明](docs/server-deployment.md)。原 Cloudflare 构建继续保留。

智能体练习直接复用 AionUi v1.9.25 的输入框、消息列表、Markdown、工具过程视图与 ACP 连接代码。源码、许可证与逐文件校验记录见 [复用说明](vendor/aionui/README.md)。构建服务器版本使用 Node 22–24：`npm ci && npm run build`。Codex 新对话使用 ACP，同一会话可继续；升级前的 Codex 对话继续使用原 exec 通道。

适用于 iPhone Safari 的独立在线页面。当前网站：https://jlpt-image-cards.pages.dev/

支持 N5–N1 等级和编号区间选择、双击切换接续／例句图片、固定图片框与两行标题、阅读位置恢复，以及两个长期保存的相邻快捷区间。当天图片缓存上限 100 MiB，次日打开或回到前台时清理过期图片。

## 文件

- `mobile/`：页面与图片代理源码。
- `data/catalog.json`：当前线上版本的轻量卡片目录。
- `scripts/build.mjs`：从源码和目录构建发布文件，不下载原图。
- `public/`：已构建的 Cloudflare Pages 发布文件。
- `tests/mobile/`：范围、手势、图片代理、WebKit 界面与缓存测试。
- `docs/reference/`：原项目的 Python 目录构建器、测试、工作流和部署记录，作为来源存档。

原图继续保存在 `turmony/jlpt-study`；本仓库没有原图全集、作答记录、学习卡正文或登录密钥。Cloudflare 仅在手机请求时从原资料仓库获取图片。目录固定到资料提交 `ebab880de725e47bf138e457b705eede494292d4`，不自动跟随原仓库最新版。

## 构建与测试

需要 Node.js 22 或更新版本。

```bash
node scripts/build.mjs
npm --prefix mobile test
```

构建无需 Python、无需下载学习资料。修改 `mobile/` 后重新构建即可生成新的 `public/`。

浏览器测试使用真实课程图片作为测试数据，因此需要本机另有原资料仓库。这里只读取它，不将图片加入本仓库：

```bash
npm ci --prefix mobile
npm exec --prefix mobile -- playwright install --with-deps webkit
JLPT_STUDY_ROOT=/absolute/path/to/jlpt-study npm --prefix mobile run test:browser
```

## 本地预览与 Cloudflare 发布

```bash
npx wrangler pages dev public --ip 127.0.0.1 --port 8788
npx wrangler pages deploy public --project-name jlpt-image-cards --branch main
```

本地预览需要能够连接 GitHub。部署到 Cloudflare 后，电脑可以关闭。此版本包含服务端图片代理，不能原样部署到只提供静态文件的 GitHub Pages。

当前 Cloudflare 站点保持手动发布。本仓库不启用自动部署；`docs/reference/mobile-pages.yml` 是原资料仓库的工作流参考，不能直接用于此独立仓库。后续新增出题／做题页面可在本仓库继续开发。

## 更新资料版本

资料仍由原仓库维护。需要更新卡片目录时，在原项目中使用其 Python 构建器读取已经推送的资料提交，再将生成的 `catalog.json` 更新到本仓库的 `data/catalog.json`，执行 `node scripts/build.mjs`。构建器来源保存在 `docs/reference/mobile_site.py`，依赖和资料校验流程属于原项目。

API Token、账户登录配置和未来的大模型密钥均应使用 Cloudflare Secrets 或本地忽略文件保存。
