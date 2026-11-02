# 01-host — 条目全文存储与 entry 接口（task-1）

判定：**PASS**（全部验收命令通过）。worker：rss-engine，2026-11-02。

## 改动清单

### rss-reader/lib/hub.js
- `CONTENT_CHARS = 20000`（lib/hub.js:32）+ `clipContent()`（lib/hub.js:163-167）：全文截断，保留换行分段（不做 summary 那种压平）。
- `mapItems()`（lib/hub.js:332-344）每条 item 新增 `content: clipContent(item.text ?? item.summary ?? "")`（lib/hub.js:341）——优先 parser 的全文 `text`，回退 `summary`。
- `loadStore()`（lib/hub.js:294-297）：读取时容忍缺失 `content`，缺失规范化为 `''`（旧存储免迁移，下次刷新回填）。
- **线上载荷保持不变**：新增 `itemWireView()`（lib/hub.js:424-441），`snapshot()`（lib/hub.js:454）与 `itemsFor()`（lib/hub.js:470）由整对象展开改为显式字段投影——`content` 只经 `entry` 单条出站，面板列表体积不变。
- 新增 `hub.entryItem(id)`（lib/hub.js:472-487，暴露于 lib/hub.js:921）：跨 `itemsByFeed` 按 id 精确查找，返回浅拷贝（含 `content`），找不到返回 `null`。

### rss-reader/index.js
- Remote 方法 `async entry(request)`（index.js:102-120）：`request { id }` → 返回 `{ id, feedId, feedTitle, title, link, publishedAt, summary, content }`；未找到抛 `RemoteError('rss/not-found', 'no entry with id "..."')`；`content` 非 string（不可能路径）兜底为 `''`。
- 标记表 `REMOTE_METHODS_KEY` 加入 `remoteMarker("entry")`（index.js:279）——**必须**，否则 Gateway 404；表内现 11 个方法（index.js:277-287）。

### rss-reader/test/hub.mjs（32 → 48 断言）
- **存储往返**（test/hub.mjs:167-239）：手写含 `content` 的 store 文件 → `hub.entryItem()` 取到全文与全部字段；无 `content` 的旧条目读为 `''`；未知/空 id 返回 `null`；`snapshot()`/`itemsFor()` 载荷不含 `content` 键；`dispose()` 持久化后文件中 `content` 保留；重新加载 store 后 `content` 仍在。
- **fetch 管线**（test/hub.mjs:241-310）：stub `globalThis.fetch`（临时清空 `*_PROXY` 环境变量并恢复，强制直连路径）→ `refresh()` 真实走 discover→parseFeed→mapItems→mergeItems→persist：`content:encoded` 进入 `content`（`"Para one.\n\nPara two."`）；无全文条目回退 description 文本；25000 字符剪到 20000；持久化→重载后全文仍在。

## 验证命令与输出（2026-11-02，工作目录 rss-reader/）

```
> node --check index.js            → OK（无输出，exit 0）
> node --check lib/hub.js          → OK（无输出，exit 0）
> node test/run.mjs                → parse tests: 57 passed, 0 failed.
> node test/hub.mjs                → hub tests: 48 passed, 0 failed.
```

## 下游契约确认（task-2 rss-ui 依赖）

- `entry` 请求 `{ id: string }`，响应八字段如上；`content` 为完整纯文本（含 `\n` 分段，可直接按 `\n` 分段渲染），旧条目为 `''`。
- 失败模式仅 `rss/not-found`（id 不存在）。
- `items()`/`follow` 流的条目字段与之前完全一致（无 `content`），client.js 无需防御性改动。
