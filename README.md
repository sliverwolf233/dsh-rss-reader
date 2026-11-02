# RSS Reader (`@local/rss-reader`)

`@local/rss-reader` is an RSS/Atom feed reader plugin for DeepSeek Harness (DSH). It adds an "RSS 阅读器 / RSS Reader" panel to the Web GUI — click the sidebar icon to open the main panel — where you subscribe to RSS 2.0, Atom, RDF, and JSON Feed sources and browse their entries. It also registers four agent tools, so a chat agent can list feeds, refresh them, read entries, and manage subscriptions.

## Features

- **Panel browsing** — open the panel from the sidebar icon. Browse entries for one source, or all sources merged, newest first.
- **Search and read** — search entries, expand a summary, open the item link.
- **Subscription management** — add, rename, and remove subscriptions, and refresh feeds, from the panel.
- **Auto refresh** — feeds are fetched every `autoRefreshMinutes` minutes (`0` disables the timer), and once at startup when `fetchOnStart` is on.
- **Persistence and seeding** — subscriptions and item history persist across restarts in `.rss-reader-data.json`. An empty store is seeded once from `sources` / `initialFeeds`.
- **Agent tools** — one line each:

| Tool | What it does |
|---|---|
| `rss_status` | List feeds and their latest items. |
| `rss_refresh` | Re-fetch feeds. |
| `rss_read` | Read one item, optionally its linked page. |
| `rss_manage` | List, add, update, or remove subscriptions. |

Examples: see [Agent tools](#agent-tools).

## Install

1. Get the package: `git clone https://github.com/sliverwolf233/dsh-rss-reader.git` (or use this checkout directly).
2. In DSH, install the plugin through the plugin manager: action `install_bundle`, target = the absolute path of this package directory (the folder that contains `package.json`).
3. The plugin manager inserts the `rss-reader` patch row with the default configuration below. `initialFeeds` comes pre-filled with the two DeepSeek status feeds: `https://status.deepseek.com/feed.rss` and `https://status.deepseek.com/feed.atom`.
4. Note: replacing an installed package requires a restart.

## Configuration

The patch row carries the plugin config. Defaults:

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

Adding or removing subscriptions in the panel writes to the data store (`.rss-reader-data.json`), not to this patch row. The config only seeds the store, and only when the store is empty.

## Agent tools

Four tools are registered by default (`registerTools` is the master switch; each tool has its own switch and name key). Use them in chat:

| Tool | What it does | Example invocation |
|---|---|---|
| `rss_status` | List every feed and its latest items. | `use rss_status to list feeds` |
| `rss_refresh` | Fetch feeds again. | `rss_refresh` |
| `rss_read` | Read one item; optionally fetch its linked page. | `rss_read url=<item link>` |
| `rss_manage` | List, add, update, or remove subscriptions. | `use rss_manage to add https://example.com/feed.xml` |

## Data & privacy

- Feeds are fetched host-side with a plain HTTP user-agent, `dsh-rss-reader`.
- Item summaries come from external sites and are untrusted content; the panel renders them as plain text.
- The data store `.rss-reader-data.json` is created next to the package directory. Delete it to reset subscriptions and history.

## Development

| File | Role |
|---|---|
| `index.js` | Host service: fetching, scheduling, tools. |
| `lib/parse.js` | Feed parsers (RSS 2.0, Atom, RDF, JSON Feed). |
| `lib/hub.js` | Subscription store and refresh hub. |
| `client.js` | Web GUI panel. |

- Syntax-check each file: `node --check index.js`, `node --check lib/parse.js`, `node --check lib/hub.js`, `node --check client.js`.
- Tests live under `test/` and run on Node, for example `node test/run.mjs`.

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
