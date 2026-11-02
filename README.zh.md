# RSS 阅读器（`@local/rss-reader`）

`@local/rss-reader` 是 DeepSeek Harness（DSH）的 RSS/Atom 订阅阅读插件。它在 Web GUI 中新增"RSS 阅读器 / RSS Reader"面板——点击侧边栏图标即可打开主面板——你可以订阅 RSS 2.0、Atom、RDF、JSON Feed 源并浏览条目。它同时注册四个 Agent 工具，让对话中的助手能够列出订阅、刷新、阅读条目和管理订阅。

## 功能

- **面板浏览**——从侧边栏图标打开面板；可按单个源浏览条目，也可以把全部源合并浏览，按时间从新到旧排序。
- **搜索与阅读**——搜索条目、展开摘要、打开条目链接。
- **订阅管理**——在面板中添加、重命名、删除订阅，并手动刷新。
- **自动刷新**——按 `autoRefreshMinutes` 分钟定时刷新（`0` 关闭），`fetchOnStart` 开启时启动即抓取一次。
- **持久化与种子导入**——订阅与条目历史保存在 `.rss-reader-data.json`，重启后保留；数据文件为空时从 `sources` / `initialFeeds` 一次性导入。
- **Agent 工具**——每个一行：

| 工具 | 作用 |
|---|---|
| `rss_status` | 列出订阅源及最新条目。 |
| `rss_refresh` | 重新抓取订阅源。 |
| `rss_read` | 阅读一条条目，可选抓取其链接的网页。 |
| `rss_manage` | 列出、添加、更新或删除订阅。 |

示例见下文「Agent 工具」。

## 安装

1. 获取代码：`git clone https://github.com/sliverwolf233/dsh-rss-reader.git`（或直接使用本目录）。
2. 在 DSH 中通过插件管理器安装：action 为 `install_bundle`，target 为本包目录（包含 `package.json` 的文件夹）的绝对路径。
3. 管理器会插入 `rss-reader` 补丁行并写入下述默认配置；`initialFeeds` 预填两个 DeepSeek 状态源：`https://status.deepseek.com/feed.rss` 与 `https://status.deepseek.com/feed.atom`。
4. 注意：替换已安装的包需要重启。

## 配置

补丁行携带插件配置，默认值如下：

```yaml
sources: []            # seed subscriptions: [{ name?: string, url: string, headers?: {name: value} }]; imported once when the data store is empty
initialFeeds: []       # simpler seed: [url, ...]; same one-time import rule
fetch:
  timeoutMs: 15000     # per-fetch timeout
  maxBytes: 4194304    # byte cap per fetched document (oversized feeds are truncated and the complete prefix is salvaged for parsing)
  maxItemsPerFeed: 50  # items kept per fetch (1-200)
historyPerFeed: 200    # items retained per feed in the persistent store
autoRefreshMinutes: 10 # 0 disables auto refresh
fetchOnStart: true     # fetch every feed once at startup
proxyUrl: 'http://127.0.0.1:7897' # route feed fetches and translation through this HTTP proxy; falls back to direct when unreachable; '' disables (HTTPS_PROXY env is honored when unset)
llmFallback: false    # optional paid LLM fallback via DeepSeek account, off by default
registerTools: true    # master switch for the four tools
statusTool: true       # statusToolName: rss_status
refreshTool: true      # refreshToolName: rss_refresh
readTool: true         # readToolName: rss_read
manageTool: true       # manageToolName: rss_manage
```

在面板中添加或删除订阅，写入的是数据文件 `.rss-reader-data.json`，而不是这条补丁配置；补丁配置只在数据文件为空时做一次性种子导入。

## Agent 工具

四个工具默认注册（`registerTools` 为总开关，每个工具另有独立开关与名称键）。均可在对话中使用：

| 工具 | 作用 | 对话示例 |
|---|---|---|
| `rss_status` | 列出全部订阅源及最新条目。 | `use rss_status to list feeds` |
| `rss_refresh` | 重新抓取订阅源。 | `rss_refresh` |
| `rss_read` | 阅读一条条目；可选抓取其链接的网页。 | `rss_read url=<item link>` |
| `rss_manage` | 列出、添加、更新或删除订阅。 | `用 rss_manage 添加 https://example.com/feed.xml` |

## 数据与隐私

- 订阅源由宿主侧抓取，使用普通 HTTP User-Agent：`dsh-rss-reader`。
- 条目摘要来自外部站点，属于不可信内容；面板仅以纯文本渲染。
- 数据文件 `.rss-reader-data.json` 位于包目录旁边；删除它即可重置订阅与历史。

## 开发

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主服务：抓取、调度、工具。 |
| `lib/parse.js` | 订阅源解析器（RSS 2.0、Atom、RDF、JSON Feed）。 |
| `lib/hub.js` | 订阅存储与刷新调度。 |
| `client.js` | Web GUI 面板。 |

- 语法检查每个文件：`node --check index.js`、`node --check lib/parse.js`、`node --check lib/hub.js`、`node --check client.js`。
- 测试位于 `test/` 目录，用 Node 运行，例如 `node test/run.mjs`。

## 许可证

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
