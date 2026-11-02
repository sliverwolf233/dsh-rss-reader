# 02-client.md — task-2「Client：Apple 风格全文弹窗」判定/自查报告

- 作者：rss-ui（Agensh worker，board revision 2 → complete）
- 交付物：`rss-reader/client.js`（唯一改动文件；1516 → 1775 行）
- 验证命令：`node --check "D:\Codes\Deepseek Harness Custom\rss-reader\client.js"` → **exit 0**（无输出）

## 改动摘要

1. **Remote 契约**：描述符表新增 `methodDescriptor('entry', ['request'])`（client.js:56），共 **11 个描述符**（10 个 direct + follow stream，见 client.js:47-69）；api 包装新增 `entry: (request) => unwrap(ctx.remote.rss.entry(request))`（client.js:1737）。
2. **标题点击 → 弹窗**：列表条目标题由 `<a>`/`<span>` 改为 `<button class="dsh-rss-itemTitle dsh-rss-itemTitleBtn">`（client.js:667-688）——点击打开弹窗、Enter 原生触发 click；keydown 对 Enter/Space `stopPropagation()` 防止冒泡到行（行的 Enter/Space 仍是展开摘要）。行其他区域点击仍展开摘要（原交互不变）。无 link 条目保留 NoLink 图标弱提示。
3. **弹窗组件 `EntryModal`**（client.js:701-830）：
   - 结构：`.dsh-rss-modal`（面板根内 absolute，z-index 40）+ 遮罩 + `role="dialog" aria-modal` 浮层（max-width 720px、max-height 85vh、内部滚动）。全部内容为纯文本节点（title/feedTitle/段落/译文均为 React text children），零 HTML 注入。
   - 材质：`backdrop-filter: blur(24px) saturate(1.6)` + `color-mix(bg-base 86%)` 半透明底、亮色顶缘（inset 顶部高光）、大投影（client.js:405-407）。
   - 动效：入场 scale .96→1 + opacity，220ms ease-out；遮罩淡入；关闭沿同一路径反向（data-closing → modalOut 180ms forwards，client.js:410-415）；`prefers-reduced-motion` 时面板/遮罩改为纯淡入淡出（media query 覆盖 animation-name，且全局 `transform:none!important` 消除位移，client.js:436）。
   - 焦点管理：打开即聚焦右上 ×（useEffect, client.js:707-711）；Tab 圈定在弹窗内首/末可聚焦元素循环（client.js:713-731）；关闭后焦点归还触发标题按钮（`el.isConnected` 校验后 focus，client.js:1219-1224）。
   - 数据：打开即 `api.entry({id})`，token 防旧响应（client.js:1228-1243）；loading spinner + t('list.loading')；错误显示 t('modal.error',{message}) + 重试按钮（modalRetry 递增重拉，client.js:1666）。
   - 排版：标题 20px/700/`letter-spacing:-0.02em`；元信息行 = 源名 · 完整时间 · 「打开原文」外链（target=_blank rel=noreferrer noopener）；正文按 `\n` 分段 `<p>`（14px、line-height 1.6、段距 14px）。
   - 底部操作：「打开原文」（anchor 样式化为按钮）+「翻译全文」；翻译把 content 按段切块（每段 trim ≤900、每批 ≤50 段且合计 ≤6000 字符，顺序多批调用后拼接，client.js:1245-1311），渲染为逐段原文/译文对照（复用 dsh-rss-parallel/pair/mtChip 样式，弹窗内放大到 14px/1.6）；进行中 spinner + 禁用；失败内联错误；缓存 key `${item.id}|full|${to}`（fullTransCacheRef，上限 60 条）；显示译文后按钮切换为 t('translate.showOriginal') 可切回原文。
4. **互斥**：全文弹窗打开时禁用划词翻译弹层（processSelection 顶部 guard，client.js:1132-1133）；弹窗内 Esc `stopPropagation`，不误触划词弹层的 document Esc 监听。
5. **locale**：新增 5 键 × zh/en（modal.open/translate/error/retry/close，client.js:120-124、176-180）；全部 t() 调用点（773、798-799、808、815、822、1238）均双语齐备。

## 自查清单（逐条确认）

| # | 项 | 结论 | 证据 |
|---|----|------|------|
| 1 | node --check 通过 | ✅ | exit 0，无输出 |
| 2 | 描述符表 11 个方法 | ✅ | client.js:47-69（10 direct + 1 stream） |
| 3 | 所有 t() 键 zh/en 齐备 | ✅ | dict 全量比对（modal.* 5+5；复用键 translate.showOriginal/chip/error、list.loading、item.untitled 均已存在） |
| 4 | Esc 关闭弹窗 | ✅ | EntryModal onKeyDown Escape 分支（client.js:714-715），stopPropagation |
| 5 | 点遮罩 / 右上 × 关闭 | ✅ | mask onClick=onClose（client.js:789）、close 按钮（client.js:795-800） |
| 6 | 关闭后焦点归还触发标题 | ✅ | closeEntryModal 定时器尾部 el.isConnected + focus（client.js:1219-1224） |
| 7 | Tab 圈定弹窗内 | ✅ | focus trap keydown（client.js:713-731），仅圈 visible 可聚焦元素 |
| 8 | reduced-motion 纯淡入淡出无位移 | ✅ | media query animation-name 覆盖 + 全局 transform:none!important（client.js:436） |
| 9 | 无 DOM 外写 | ✅ | 弹窗渲染在面板根内（modalNode 为根 div 子节点，client.js:1697-1701）；无 document.write/append；仅读 window.getSelection、el.focus |
| 10 | 外站内容零 HTML 注入 | ✅ | title/feedTitle/段落/译文全部 React text children；无 dangerouslySetInnerHTML |
| 11 | 卸载清理 | ✅ | modalTimerRef 在卸载 effect 清理（client.js:1313-1314） |

## 已知边界（非缺陷）

- content 为 ''（旧存储条目）时正文回退显示 summary，两者皆空则仅显示标题+元信息，「翻译全文」禁用。
- 触发标题在弹窗打开期间被列表重渲染移除时（如快照刷新删除该条目），关闭后 focus 因 `isConnected=false` 跳过——焦点留在面板内，属安全降级。
- 集成验证（task-4）由 rss-engine 执行；本报告仅覆盖 client 侧静态自查 + node --check。
