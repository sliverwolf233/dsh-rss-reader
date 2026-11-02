# 10-llm-gate — LLM 兜底配置门禁（task-10）

判定：**完成**。worker：rss-engine，2026-11-02 13:3x-13:4x (HKT)。目标：task-9 的 LLM 兜底默认关闭、严格 opt-in，绝不无意消耗付费额度。

## 改动（file:line）

1. **index.js:40-41** — `static Config` 增加 `llmFallback: z.boolean().default(false)`（注释：使用本机 DeepSeek 账号 LLM 翻译，消耗 API 额度，默认关闭）。
2. **index.js:261-275** — 门禁判定抽为命名导出 `export function shouldInjectLlm(config)`（`// [llm-gate-start]/[llm-gate-end]` 标记包裹，供测试提取）：**仅 `config?.llmFallback === true` 返回 true**——缺省、false、truthy 非布尔一律 false。
3. **index.js:175** — translate() 唯一注入点改为 `llmTranslate: shouldInjectLlm(this.config) ? buildLlmTranslate(this.ctx) : undefined`。grep 证明 `buildLlmTranslate` 全文件仅两处：定义（index.js:314）与此门禁调用点（index.js:175）——**门禁为假时永不求值**，`ensureLlmTranslationSession` 保持惰性，`rss-reader-translations` 会话绝不会在关闭时创建。
4. **cordis.patch.yml:19-21** — 配置块显式 `llmFallback: false` + 双行注释（说明额度消耗与专用会话）。
5. **README.md:45 / README.zh.md:45** — 配置表各加一行 `llmFallback: false    # optional paid LLM fallback via DeepSeek account, off by default`。

## 验证（2026-11-02，rss-reader/）

```
> node --check index.js test\run.mjs → OK
> node test/run.mjs      → parse tests: 85 passed, 0 failed.   （78 → 85：门禁组 +7）
> node test/hub.mjs      → hub tests: 48 passed, 0 failed.
> node test/markdown.mjs → markdown tests: 17 passed, 0 failed.
```

新增测试（test/run.mjs:335-369，标记切片 + `new Function` 提取 shouldInjectLlm——index.js 的 peer deps 仅在 Harness profile 内可解析，无法直接 import；提取前剥离 `export ` 关键字，代码本体逐字一致）：
- 显式 true → true；显式 false / 缺省 / config 缺失 / truthy 非布尔 → false（5 条）；
- 镜像服务层组装：off 配置传入 `undefined` → 聚合失败文案不含 "harness"（第 4 提供方完全未接线，2 条）。

## 门禁保证链

`llmFallback !== true`（缺省/patch 显式 false）→ `shouldInjectLlm` false → `buildLlmTranslate` 不求值 → `translateTexts` 收到 `llmTranslate: undefined` → 链只有外部三家；`ensureLlmTranslationSession` / `sessions.create` 在 `buildLlmTranslate` 返回的闭包内部，永不触达。付费路径仅在用户显式 `llmFallback: true` 后存在。

**提醒 lead toggle**：当前运行实例是 task-9 的未门禁版本；重载后即为本版（patch 显式 false，安全默认）。
