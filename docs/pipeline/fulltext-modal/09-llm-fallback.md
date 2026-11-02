# 09-llm-fallback — 翻译 LLM 本地兜底提供方（task-9）

判定：**完成（运行时 LLM 路径待 toggle 实测）**。worker：rss-engine，2026-11-02 13:0x (HKT)。

## 1. translator 服务契约结论（源码逐行读取，非猜测）

来源：`E:\Deepseek-Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-translator\lib\index.js`（解包至 %TEMP%/工作区临时目录后读取；包版本 0.2.1-rc.3，`main: lib/index.js`）。

- **服务名**：`super(ctx, "translator")` → `ctx.get('translator')`（tr_index.js:805；types 版 tr_types_index.js:35）。
- **`availableProviders(signal?) → Promise<string[]>`**（tr_index.js:822-829 / availablePaidProviders tr_index.js:645-670）：恒返回 `["bing","google"]`（该服务的匿名路由=同一批外部端点，对我们无兜底价值），其后追加**通过资格检查的 LLM 路由** `"deepseek-account"` / `"deepseek-official"`（本机 DeepSeek 账号或 API key + Flash 模型目录，纯本地检查无推理调用）。
- **`resolve(request)`**（tr_index.js:835-862）：request = `{ text, targetLanguage, sourceLanguage?, provider?, sessionId? }`（注意字段名是 **targetLanguage**，不是 target；默认 sourceLanguage 'auto'）。返回 spec。provider 为 deepseek-* 时**必须携带 `sessionId`，否则抛 `TRANSLATION_SESSION_REQUIRED`**（tr_index.js:853）；bing/google 无需 session。
- **`translate(spec, signal?) → Promise<string>`**（tr_index.js:871-919）：单文本、返回纯文本。deepseek 路由 = "Native Flash translation"（LLM，`reasoningEffort: off`，tr_index.js:706-711），经 `storage.run(sessionId, …)` 走持久会话存储（tr_types_storage.js:104-173）：**未缓存调用要求该 session 在 `sessionPersistence.stat` 存在且在 `sessions.get(id)` 为活跃会话**，否则 `TRANSLATION_SESSION_REQUIRED` / `TRANSLATION_SESSION_INACTIVE`；已缓存结果只需持久层存在（无需活跃会话）。文本上限 `maxTextChars`（默认 4000 UTF-16，我们每段 ≤900 安全）。
- **sessions 服务**（dsh-session，sess-index.js:1739-1778）：`ctx.get('sessions')` → `.get(id)` 活跃会话、`.create(id?)` 创建**fiber 持有的活跃会话**（插件卸载即移除出 store，持久记录留盘）、`.flush(session)` 落盘。

**结论**：无 session 的 LLM 路由不存在；lead 规格中的 `resolve({source, target, text})` 按真实契约修正为 `{text, targetLanguage, sourceLanguage:'auto', provider:<deepseek-*>, sessionId}`。采用**专用插件会话** `rss-reader-translations`（隔离于用户聊天；会出现在会话列表中——有意为之的透明取舍，见 §4）。

## 2. 实现

### rss-reader/lib/translate.js
- `translateTexts(texts, to, { proxyUrl, timeoutMs, budgetMs, llmTranslate })`：注入的 `llmTranslate(texts, to)` 成为第 4 提供方 **`harness`**（缺失即跳过，链不变）；与外部三家同样纳入熔断冷却与 20s 预算（translate.js:206-233，chain 组装 :212）。

### rss-reader/index.js
- 构造器保存 `this.ctx`（index.js:54）。
- `buildLlmTranslate(ctx)`（index.js:237-268）：`ctx.get('translator')` 缺失/无方法 → undefined（不加 static inject，可选依赖）；每次翻译现取（服务热插拔友好）。注入函数：`availableProviders()` → 取第一个 `deepseek-*` 路由（无则抛 "no eligible LLM route"）→ `ensureLlmTranslationSession` → 逐条 `resolve({text, targetLanguage, sourceLanguage:'auto', provider, sessionId})` + `translate(spec)`，**并发 ≤4 分批**，`detected` 规格化为 null，结果非 string 抛错；任何失败成为链式失败一行（进 task-6 的聚合文案）。
- `ensureLlmTranslationSession(ctx)`（index.js:210-235）：get-or-create 专用会话（create 冲突时回退 get；create 后尽力 `flush` 促成持久层 stat 可见）。

## 3. 验证（2026-11-02，rss-reader/）

```
> node --check index.js lib\translate.js test\run.mjs → 3/3 OK
> node test/run.mjs     → parse tests: 78 passed, 0 failed.   （+8：LLM 兜底组）
> node test/hub.mjs     → hub tests: 48 passed, 0 failed.
> node test/markdown.mjs → markdown tests: 17 passed, 0 failed.
```

新增测试（test/run.mjs:310-348）：① 外部三家 stub 500 全败 → 注入 stub llm 成功，`provider==='harness'`、items 对齐、detected null；② 不注入时聚合文案仅含三家、无 "harness"；③ 熔断覆盖 harness：连败 2 次后第 3 次调用 "harness: skipped — cooling down" 且注入函数调用数恰为 2（熔断完全跳过）。

## 4. 取舍与运行时待验证项（toggle 实测）

1. **专用会话可见性**：`rss-reader-translations` 会话会出现在 DSH 会话列表（sessions.create 会 announce）。隔离、可审计；若 Lead 认为干扰，可改为不落会话（放弃 LLM 路由）或探讨框架侧匿名持久层。
2. **首调用持久化时序**：storage.run 在翻译前要求 `persistence.stat(sessionId)` 存在；新会话已在 create 后尽力 flush，若仍有竞态，首次调用会以 `TRANSLATION_SESSION_REQUIRED` 文案失败并进入熔断（10 分钟）——错误如实可见，不会崩溃；toggle 实测确认。
3. LLM 路由资格取决于本机 DeepSeek 账号/API key 与 Flash 模型目录（availableProviders 本地检查）；无资格时文案为 "no eligible LLM route (available: bing, google)"。
4. 深度不确定项已隔离在 index.js 注入层；lib/translate.js 对注入函数零假设（签名固定 `(texts, to)`）。
