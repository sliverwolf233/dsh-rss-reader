# 07-markdown — 弹窗 Markdown 安全渲染（task-7）

判定：**完成**。worker：rss-engine，2026-11-02 12:4x–13:0x (HKT)。

## 交付物

- `rss-reader/client.js`（唯一源码改动）：+2 纯函数、+1 渲染组件、+1 行内解析器、+22 条 CSS、EntryModal 两处接入。
- `rss-reader/test/markdown.mjs`（新增，17 断言）。

## 实现与证据（file:line）

### 纯函数（零闭包依赖，置于 `[md-pure-start]/[md-pure-end]` 标记内供测试提取）
- `safeUrl(raw)`（client.js:36）：`new URL` 解析后按协议白名单判定——http/https 绝对 URL 返回规范化 href，其余（javascript:/data:/ftp:/相对路径/无 scheme/非字符串/超长）一律 `null`。
- `looksLikeMarkdown(text)`（client.js:48）：行级特征分类计数——标题 `#{1,4}+空格`、``` 围栏、`[-*+] `/`\d+. ` 列表、`> ` 引用、`---`/`***` 分隔线、行内链接 ≥2、`**粗**`+`` `码` `` ≥3；**≥2 类才判真**，文本 <16 字符直接否——保守取向，宁可纯文本。

### 渲染（手写解析器直产 React 元素，零 HTML 字符串）
- `mdInline`（client.js:808）：单趟扫描产 span/strong/em/code/a/img 数组；`**粗**`、`*斜*`、`` `行内码` ``、`[文](url)`、`![alt](url)`；裸 URL 不自动链接；不合法链接/图片**降级为原文字面文本**。
- `MarkdownView`（client.js:893）：按行状态机——代码围栏（截断文本无收尾围栏时安全结束）、h1-h4、hr、blockquote、一层 ul/ol（含缩进续行并入上一项）、段落（`white-space:pre-wrap` 保留换行）。
- 接入：正文 `looksLikeMarkdown(bodyText) ? MarkdownView : 原 \n 分段`（client.js:1017-1018，summary 回退路径不动）；翻译对照原文侧逐块同样判定（client.js:1011），**译文侧保持纯文本**（取舍：译文来自 MT API 无 Markdown 语义，纯文本最忠实）。
- 图片：仅 `https://` 的 `<img src>`（在 safeUrl 之上再判 `startsWith('https://')`），`loading=lazy`、`referrerpolicy=no-referrer`、`alt` 缺省用弹窗标题（`altFallback`）、`onError` 隐藏（client.js:826-833）；http/其它协议 → 原文字面占位文本。
- CSS：`dsh-rss-md*` 前缀 22 条（client.js:479-500），全部 `--dsw-alias-*` token（bg-layer-2/border-l2/brand-primary/label-*），无动画（reduced-motion 不涉及）。

## 安全自查

- `dangerouslySetInnerHTML` / `innerHTML` / `insertAdjacentHTML` / `document.write` 在 client.js **0 处实际使用**（grep 唯一命中是本组件注释里"绝不使用"的字样，client.js:891）。
- Markdown → **React 元素树**（`h(...)`），无任何 Markdown→HTML 字符串转换或拼接；源文本中的 HTML 标签经 React 文本节点天然按字面转义。
- 链接强制 `target=_blank rel=noreferrer noopener` + 协议白名单；图片 https-only + no-referrer + onError 隐藏。

## 验证（2026-11-02，rss-reader/）

```
> node --check client.js            → OK（exit 0）
> node test/markdown.mjs            → markdown tests: 17 passed, 0 failed.
> node test/run.mjs                 → parse tests: 70 passed, 0 failed.
> node test/hub.mjs                 → hub tests: 48 passed, 0 failed.
```

test/markdown.mjs 覆盖：markdown 判定正例 ×4 / 负例 ×4（含单特征、低于阈值、过短）；safeUrl https/http 通过（含 trim 归一化）、`javascript:`/`data:`/`ftp:`/相对路径/无 scheme/非字符串拒绝。提取法：client.js 是浏览器模块不可 import，按标记切片 `new Function` 求值——测试的就是出厂实现而非复制品（文件头注明方法与原因）。

## 备注 / 建议

- test/markdown.mjs 未纳入 ci.yml 与 package.json `scripts.test`（两者属 rss-release 的 task-3/task-5 范围）——建议 lead 让其补一行 `node test/markdown.mjs`（本地已验证可直跑）。
- 面板视觉仍待用户手测（07 与 02/04 同理）：打开一篇含 Markdown 的全文（如 GitHub Releases 源）应见标题/列表/代码块样式；含 `![图](http://…)` 的条目应见占位文本而非图片。
