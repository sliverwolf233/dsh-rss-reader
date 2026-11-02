# 06-translate-fix — 翻译 RPC "connection: invalid server-response failure" 修复（task-6）

判定：**已修复（根因 B + 加固 A + 反馈 C）**。worker：rss-engine，2026-11-02 12:19–12:4x (HKT)。

## 现象复现路径

弹窗点「翻译全文」→ `api.translate` → Host `RssReaderService.translate()`（index.js）→ `translateTexts`（lib/translate.js）三 provider 全败 → 抛 `RemoteError("rss/translate-failed", ...)` → **客户端显示 "client api: rss/translate failed: connection: invalid server-response failure"** 而非业务文案。

## 诊断（按板上路径逐步）

### 1. 错误来源定位（app.asar 内，asar 头手解包后按 offset 抽取）

- 报错文案来源：`dsh-client-connection/lib/client.browser.js:1301` `parseConnectionResponse()`：`result.ok===false` 时要求 `error.code` 为 string、`error.message` 为 string、**`error.details` 为 record**，否则抛 `TypeError("connection: invalid server-response failure")`。
- 前缀来源：`dsh-api-gateway/lib/client.browser.js:2122` `internalFailure(\`client api: ${endpoint} failed: ${error.message}\`)`。
- **根因**：Host 侧网关 `dsh-api-gateway/lib/index.js:1673-1691` `rpcFailure()`：捕获 `RemoteError` 时按原样编码 `details: remote.details`——而 `RemoteError`（dsh-typert-protocol `lib/types/remote-error.js:20-25`）**不默认 details**，我们全插件 12 处 `new RemoteError(code, message)` 均两参构造 → `details: undefined` → `Response.json` 序列化时键被丢弃 → 客户端校验失败。非 RemoteError 抛出走 `details: {}` 分支不受影响——所以只有"业务失败"会触发此 bug，成功路径与网关自身错误都正常。
- **超时假设排除**：全链（两个 client 包）无任何 per-RPC deadline/timeout（`AbortSignal.timeout|setTimeout.*abort|timeoutMs` 在两包 0 命中）——连接层错误不是超时引起。

### 2. 实测现状（node 直调 `translateTexts`，本机 Clash 7897 不可达 → 直连）

| Provider | 结果 | 耗时 |
|---|---|---|
| Bing（edge.microsoft.com token） | HTTP 404 | 604ms |
| Google（translate.googleapis.com） | 连接被重置 fetch failed | 10680ms |
| MyMemory | HTTP 429（配额） | 941ms |
| **单次调用合计（修复前）** | 三链全败 | **12227ms** |

### 3. 结论

**响应体异常（B）**：所有 provider 当前全败 → 服务端必然抛 `RemoteError` → 两参构造缺 `details` → 信封非法。超时不是本错误的原因（无客户端截止时间），但 8–12s/次的失败耗时是真实的体验放大器，故同时按 A 加固。

## 修复

### B（根因）index.js — 12 处 `RemoteError` 全部补第三参 `{}`
index.js:87-90 加注释说明该契约；entry not-found（index.js:110）、refresh/add/remove/rename/translate×4/import×3 全部修复。修复后网关编码 `{code, message, details:{}}`，客户端校验通过，用户重新看到真实失败原因（如 "all translation providers failed — bing: HTTP 404 …"）。

### A（加固）lib/translate.js
- 每请求超时 15000→**8000ms**（translate.js:24）；
- **总预算 20s**：`translateTexts` 增加 `budgetMs`（默认 20000），deadline 贯穿三个 provider 的批间检查（`checkBudget`，translate.js:71-73），超预算放弃后续 provider 并计入失败信息；
- **provider 熔断冷却**：连续失败 2 次后 10 分钟内跳过（内存 Map，`recordOutcome`/`isCoolingDown`，translate.js:44-66），成功即清零；
- `timeoutMs`/`budgetMs` 可由调用方覆盖（供测试缩小定时器）；导出 `resetTranslationState()` 测试钩子。
- 实测（修复后真实网络，同一环境）：call-1 **9265ms**（Google 8s 截断）、call-2 **8498ms**、call-3（冷却生效）**0ms** 且消息为 "skipped — cooling down after repeated failures" ×3。

### C（反馈）client.js
- 弹窗「翻译全文」按钮翻译期间显示进度 `翻译中 {done}/{total} 批`（client.js:824-826；locale 键 `modal.translating` zh/en 双语，client.js:122/179）；每批完成即更新（client.js:1273、1284）。

## 回归验证（2026-11-02，rss-reader/）

```
node --check index.js lib/translate.js client.js test/run.mjs test/hub.mjs → 5/5 OK
node test/run.mjs → parse tests: 70 passed, 0 failed.   （57 → 70：新增 13 条 translate 断言）
node test/hub.mjs → hub tests: 48 passed, 0 failed.
```

新增测试（test/run.mjs:236-312，stub `globalThis.fetch`）：全链失败聚合文案含三 provider 名；连续两败后第三次调用三 provider 全部 `cooling down` 且 **fetch 调用数为 0**（熔断不走网络）；Bing 成功路径返回对齐结果并清零计数；预算耗尽（60ms 慢失败 + budgetMs=100）消息含 `budget exceeded` 且 <2s 收敛；每请求超时（60ms）消息含 `aborted` 且 <2s 收敛。
（坑：Node 的 `AbortSignal.timeout` 定时器是 unref 的，纯等待 abort 的 fetch stub 会抽干事件循环——stub 需带 ref'd 兜底定时器，test/run.mjs:289-296。）

## 遗留与建议

- **建议 lead toggle 插件一次**以加载新代码（本会话无 plugin_manager 权限）；重载后用户点「翻译全文」：失败会显示真实原因（Bing 404 / Google 超时 / MyMemory 429），约 9s 出结果，重复点击即时失败并提示冷却；当前网络下三家均不可用属环境事实，代理恢复后自动可用。
- 上游框架缺陷（超出本仓范围，建议反馈给 DSH）：`rpcFailure` 对 `details: undefined` 的 RemoteError 不做归一化，插件侧两参构造即触发客户端信封校验失败；框架侧可在编码时 `details ?? {}` 兜底。
- 影响面：修复覆盖 entry/refresh/add/remove/rename/translate/importOpml 全部失败路径（此前全部存在同一隐性 bug）。
