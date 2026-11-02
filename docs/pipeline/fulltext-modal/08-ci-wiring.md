# 08 · CI：接入 markdown 测试（task-8, rss-release）

日期：2026-11-02 · 前置：task-6/7 新增 `test/markdown.mjs`（17 断言）· 未做任何 git 操作（发布由 lead 收尾）

## 改动

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/ci.yml:35-36` | 新增步骤 `Run markdown tests (test/markdown.mjs)` → `node test/markdown.mjs`（顺序 run → hub → markdown） |
| `.github/workflows/release.yml:36-37` | 同上（两工作流检查保持一致） |
| `package.json:8` | `scripts.test` = `node test/run.mjs && node test/hub.mjs && node test/markdown.mjs` |

**说明——语法检查清单无需改动**：两工作流的 per-file 检查步骤本就用 glob `for f in index.js client.js lib/*.js test/*.mjs`（ci.yml:24、release.yml 同构），`test/markdown.mjs` 被自动纳入：文件数 12 → **13**（下方本地复现实测 13 个，含 markdown.mjs）。这满足规格"清单补 test/markdown.mjs（12→13）"的意图，且未来新增 .mjs 测试文件同样自动覆盖。

## 验证（全部在仓库根实际执行）

### 1. ci.yml 每步复现

```
per-file node --check（glob 展开）: Files (13) → syntax-check: PASS (13 files)
  （index.js client.js lib×5 test×6，test×6 = descriptions/hub/load-check/markdown/run/smoke-real）
> node test/run.mjs       → parse tests: 70 passed, 0 failed.   (exit=0)
> node test/hub.mjs       → hub tests: 48 passed, 0 failed.     (exit=0)
> node test/markdown.mjs  → markdown tests: 17 passed, 0 failed.(exit=0)
> npm test                → 70/0 + 48/0 + 17/0                   (exit=0)
```

与验收口径完全一致（13× check、70/48/17 全绿）。

### 2. YAML 校验

actionlint 1.7.12（task-3 时经 gh 下载，缓存于 `%TEMP%\dsh-actionlint\actionlint.exe`，本次直接复用）：

```
> actionlint.exe .github/workflows/ci.yml .github/workflows/release.yml
actionlint exit=0
```

两工作流 YAML + Actions schema + 表达式校验零告警。

## 结论

PASS：markdown 测试已同时接入 ci.yml、release.yml（语法 glob + 测试步骤）与 `npm test`；全部步骤本地复现通过，工作流校验干净。工作树改动仅限本任务三文件 + 本报告，等待 lead 统一提交发布。
