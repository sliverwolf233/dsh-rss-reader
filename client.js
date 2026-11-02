/**
 * @local/rss-reader —— Client 端实现。
 *
 * 浏览器半：挂载 Host 贡献的 Remote 命名空间 rss，并在 Web GUI 注册
 * 「RSS 阅读器」主面板（侧栏图标 + 左源列表/右文章列表），所有数据
 * 均通过 ctx.remote.rss 与 Host 交互，浏览器端不做任何 fetch。
 * 另含机器翻译：条目展开后的逐行对照翻译 + 面板内划词翻译弹层；
 * 以及 OPML 订阅导入/导出；条目标题点击打开 Apple 风格全文弹窗。
 *
 * 结构照抄 @local/qq-connector 的 panel.js：
 *   apply = $mount(Remote) + ctx.inject(['remote.rss','slots','locale'], registerUi)。
 */
window.__ModuleLoader__.load({
	id: '@local/rss-reader',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		//#region 常量
		const PACKAGE = '@local/rss-reader';
		const NS = 'rss.panel';
		const PANEL_ID = 'rss';
		//#endregion

		//#region Markdown 纯函数（零闭包依赖；test/markdown.mjs 按下方标记提取测试）
		// [md-pure-start]
		/**
		 * 链接协议白名单：仅 http/https 绝对 URL 放行（解析后看 protocol），
		 * 返回规范化 href；其余（javascript:/data:/相对路径/垃圾串）一律 null，
		 * 调用方降级为纯文本。图片在此基础上再要求 https。
		 */
		function safeUrl(raw) {
			if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
			let parsed;
			try { parsed = new URL(raw.trim()); } catch { return null; }
			return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
		}

		/**
		 * 保守判定一段全文是否按 Markdown 渲染：统计行级强特征类别，
		 * 至少命中两类才判真——宁可当纯文本，不要误渲染。
		 * 类别：标题 / ``` 围栏 / 无序或有序列表 / 行内链接≥2 / **粗**或`码`≥3 / 引用 / 分隔线。
		 */
		function looksLikeMarkdown(text) {
			if (typeof text !== 'string' || text.length < 16) return false;
			const classes = new Set();
			let inlineLinks = 0;
			let emphasis = 0;
			for (const rawLine of text.split('\n')) {
				const line = rawLine.trim();
				if (/^#{1,4}\s+\S/.test(line)) classes.add('heading');
				if (line.startsWith('```')) classes.add('fence');
				if (/^[-*+]\s+\S/.test(line) || /^\d{1,3}\.\s+\S/.test(line)) classes.add('list');
				if (/^>\s*\S/.test(line)) classes.add('quote');
				if (/^(-{3,}|\*{3,})$/.test(line)) classes.add('hr');
				inlineLinks += (line.match(/\[[^\]\n]{1,120}\]\([^)\s]{1,400}\)/g) || []).length;
				emphasis += (line.match(/\*\*[^*\n]{1,120}\*\*/g) || []).length;
				emphasis += (line.match(/`[^`\n]{1,120}`/g) || []).length;
			}
			if (inlineLinks >= 2) classes.add('links');
			if (emphasis >= 3) classes.add('emphasis');
			return classes.size >= 2;
		}
		// [md-pure-end]
		//#endregion

		//#region Remote 贡献（结构照抄 qq-connector 的 QQ_REMOTE；codec.create 仅为占位）
		/**宽松 codec：校验只要求 create 是函数，运行时不会调用。 */
		const anyCodec = { mode: 'strict', typeSymbol: 'rss/any', create: () => undefined };
		/**构造一个 direct 调用的方法 descriptor。wire 字段名必须与 Host 方法参数名一致（均为 request）。 */
		function methodDescriptor(method, params) {
			return {
				id: `${PACKAGE}#rss/${method}`,
				service: 'rssReader',
				namespace: 'rss',
				method,
				invocation: { kind: 'direct' },
				parameters: params.map((name) => ({ name, wire: name, source: 'json', codec: anyCodec })),
				result: anyCodec
			};
		}
		const RSS_REMOTE = {
			package: PACKAGE,
			descriptors: [
				methodDescriptor('state', []),
				methodDescriptor('items', ['request']),
				methodDescriptor('refresh', ['request']),
				methodDescriptor('addFeed', ['request']),
				methodDescriptor('removeFeed', ['request']),
				methodDescriptor('renameFeed', ['request']),
				methodDescriptor('translate', ['request']),
				methodDescriptor('exportOpml', []),
				methodDescriptor('importOpml', ['request']),
				methodDescriptor('entry', ['request']),
				{
					// 订阅状态流：yield { kind:'state', state: snapshot }；调用端可传 signal 取消
					id: `${PACKAGE}#rss/follow`,
					service: 'rssReader',
					namespace: 'rss',
					method: 'follow',
					mode: 'stream',
					invocation: { kind: 'direct' },
					parameters: [],
					cancellation: { parameter: 'signal' },
					result: anyCodec
				}
			]
		};
		//#endregion

		//#region locale 词典
		const DICT_ZH = {
			'panel': 'RSS 阅读器',
			'title': 'RSS 阅读器',
			'all.title': '全部源',
			'count.items': '{count} 篇',
			'action.refresh': '刷新',
			'action.add': '添加',
			'action.rename': '重命名',
			'action.remove': '移除',
			'action.confirm': '确认移除？',
			'action.retry': '重试',
			'add.urlLabel': '订阅源 URL',
			'add.titleToggle': '标题',
			'add.titlePlaceholder': '标题（可选）',
			'rename.placeholder': '新标题',
			'search.placeholder': '搜索标题与摘要…',
			'header.site': '访问站点',
			'header.updated': '更新于 {time}',
			'list.loading': '加载中…',
			'empty.feeds': '添加第一个订阅',
			'empty.items': '此源暂无文章',
			'empty.search': '没有匹配的文章',
			'item.noLink': '无链接',
			'item.untitled': '（无标题）',
			'feed.refresh': '刷新此源',
			'feed.errorAria': '此源抓取出错',
			'error.load': '加载失败：{message}',
			'error.action': '操作失败：{message}',
			'error.add': '添加失败：{message}',
			'error.stream': '连接中断，正在重连…',
			'translate.action': '对照翻译',
			'translate.ghost': '翻译',
			'translate.showOriginal': '显示原文',
			'translate.chip': '机译',
			'translate.detecting': '翻译中…',
			'translate.error': '翻译失败：{message}',
			'translate.popoverSource': '原文',
			'translate.langUnknown': '未知语言',
			'translate.close': '关闭',
			'opml.export': '导出 OPML',
			'opml.import': '导入 OPML',
			'opml.importing': '导入中，逐源校验…',
			'opml.importDone': '已导入 {added} 个源，{failed} 个失败',
			'opml.exportFailed': '导出失败：{message}',
			'opml.importFailed': '导入失败：{message}',
			'opml.moreFailed': '还有 {n} 个未展示',
			'modal.open': '打开原文',
			'modal.translate': '翻译全文',
			'modal.translating': '翻译中 {done}/{total} 批',
			'modal.error': '加载失败：{message}',
			'modal.retry': '重试',
			'modal.close': '关闭',
			'time.now': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前'
		};
		const DICT_EN = {
			'panel': 'RSS Reader',
			'title': 'RSS Reader',
			'all.title': 'All sources',
			'count.items': '{count} items',
			'action.refresh': 'Refresh',
			'action.add': 'Add',
			'action.rename': 'Rename',
			'action.remove': 'Remove',
			'action.confirm': 'Remove?',
			'action.retry': 'Retry',
			'add.urlLabel': 'Feed URL',
			'add.titleToggle': 'Title',
			'add.titlePlaceholder': 'Title (optional)',
			'rename.placeholder': 'New title',
			'search.placeholder': 'Search titles & summaries…',
			'header.site': 'Visit site',
			'header.updated': 'Updated {time}',
			'list.loading': 'Loading…',
			'empty.feeds': 'Add your first feed',
			'empty.items': 'No articles yet',
			'empty.search': 'No matching articles',
			'item.noLink': 'No link',
			'item.untitled': '(Untitled)',
			'feed.refresh': 'Refresh this feed',
			'feed.errorAria': 'This feed failed to fetch',
			'error.load': 'Failed to load: {message}',
			'error.action': 'Operation failed: {message}',
			'error.add': 'Could not add feed: {message}',
			'error.stream': 'Reconnecting…',
			'translate.action': 'Translate side-by-side',
			'translate.ghost': 'Translate',
			'translate.showOriginal': 'Show original',
			'translate.chip': 'Machine translation',
			'translate.detecting': 'Translating…',
			'translate.error': 'Translation failed: {message}',
			'translate.popoverSource': 'Original',
			'translate.langUnknown': 'Unknown',
			'translate.close': 'Close',
			'opml.export': 'Export OPML',
			'opml.import': 'Import OPML',
			'opml.importing': 'Importing, validating feeds…',
			'opml.importDone': 'Imported {added} feeds, {failed} failed',
			'opml.exportFailed': 'Export failed: {message}',
			'opml.importFailed': 'Import failed: {message}',
			'opml.moreFailed': '+{n} more',
			'modal.open': 'Open original',
			'modal.translate': 'Translate full text',
			'modal.translating': 'Translating {done}/{total}',
			'modal.error': 'Failed to load: {message}',
			'modal.retry': 'Retry',
			'modal.close': 'Close',
			'time.now': 'now',
			'time.minutes': '{n}m ago',
			'time.hours': '{n}h ago',
			'time.days': '{n}d ago'
		};
		//#endregion

		//#region 小工具
		/**把任意错误压成一行可读文本。 */
		function fmtError(error) {
			if (!error) return 'unknown';
			if (typeof error === 'string') return error;
			if (error.message) return String(error.message);
			if (error.error && error.error.message) return String(error.error.message);
			try { return JSON.stringify(error); } catch (_) { return String(error); }
		}
		/**头像底色轮换：key hash → 0..4。 */
		function colorSeed(key) {
			let sum = 0;
			const text = String(key || '');
			for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i) * (i + 7)) % 9973;
			return sum % 5;
		}
		/**相对时间文案：刚刚/分钟/小时/天；超过 7 天退回本地日期。 */
		function relTime(ms, t) {
			if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
			const diff = Date.now() - ms;
			if (diff < 60000) return t('time.now');
			if (diff < 3600000) return t('time.minutes', { n: Math.floor(diff / 60000) });
			if (diff < 86400000) return t('time.hours', { n: Math.floor(diff / 3600000) });
			if (diff < 7 * 86400000) return t('time.days', { n: Math.floor(diff / 86400000) });
			return new Date(ms).toLocaleDateString();
		}
		/**完整本地日期时间（title 提示用）。 */
		function fullTime(ms) {
			return typeof ms === 'number' && isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '';
		}
		/**取 URL 的主机名（失败返回 null）。 */
		function hostOf(url) {
			try {
				const parsed = new URL(String(url));
				return parsed.hostname || null;
			} catch (_) { return null; }
		}
		/**标题首字符（含代理对安全）。 */
		function firstChar(text) {
			const s = String(text || '').trim();
			if (!s) return '?';
			return Array.from(s)[0].toUpperCase();
		}
		/**CJK 字符检测（中日韩，含注音/假名/谚文区间）。 */
		const CJK_RE = /[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
		function isCJK(text) {
			return CJK_RE.test(String(text || ''));
		}
		/**UI 语言 → Bing 翻译目标码：zh*→zh-CHS，ja/ko 原样，其余取首子标签。 */
		function targetLang(localeId) {
			const id = String(localeId || navigator.language || 'en').toLowerCase();
			if (id.startsWith('zh')) return 'zh-CHS';
			if (id.startsWith('ja')) return 'ja';
			if (id.startsWith('ko')) return 'ko';
			return id.split('-')[0] || 'en';
		}
		/**目标语言是否为 CJK（用于「文本语言 ≠ 界面语言」的对照翻译提示启发）。 */
		function targetIsCJK(to) {
			return to.startsWith('zh') || to === 'ja' || to === 'ko';
		}
		/**从 state 对象中删一个 key（浅拷贝）。 */
		function omitKey(map, id) {
			const next = { ...map };
			delete next[id];
			return next;
		}
		/**条目排序：新→旧，无日期者垫底（Host 已排好，合并时再统一一次）。 */
		function sortItems(list) {
			const timeOf = (item) => (item && typeof item.publishedAt === 'number' && item.publishedAt > 0 ? item.publishedAt : null);
			return list.slice().sort((a, b) => {
				const at = timeOf(a);
				const bt = timeOf(b);
				if (at === null && bt === null) return 0;
				if (at === null) return 1;
				if (bt === null) return -1;
				return bt - at;
			});
		}
		/**按 id 去重合并两组条目（快照全量 + 按源查询结果）。 */
		function mergeItems(prev, incoming) {
			const map = new Map();
			for (const item of prev) if (item && item.id) map.set(item.id, item);
			for (const item of incoming) if (item && item.id) map.set(item.id, item);
			return sortItems([...map.values()]);
		}
		//#endregion

		//#region 样式（主题 token + fallback；布局用 px 直量）
		const CSS = `
.dsh-rss-root{box-sizing:border-box;position:relative;width:100%;height:100%;min-height:0;display:flex;color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-bg-base,#fff);font-size:14px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.2));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.35))}
.dsh-rss-root *,.dsh-rss-root *::before,.dsh-rss-root *::after{box-sizing:border-box}
.dsh-rss-side{flex:none;width:260px;min-width:0;min-height:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
@media (max-width:720px){.dsh-rss-side{width:200px}}
.dsh-rss-sidePad{flex:none;padding:8px 8px 4px}
.dsh-rss-allRow{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;padding:7px 10px;border:0;border-radius:12px;background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit;transition:background-color .12s ease-out,transform .1s ease-out}
.dsh-rss-allRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-allRow:active{transform:scale(.98)}
.dsh-rss-allRow[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6)) 12%,transparent)}
.dsh-rss-allIcon{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6)) 15%,transparent);color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6))}
.dsh-rss-allName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:18px}
.dsh-rss-allCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-feeds{flex:1;min-height:0;overflow-y:auto;padding:0 6px 8px;display:flex;flex-direction:column;gap:2px}
.dsh-rss-feed{display:flex;align-items:center;gap:9px;width:100%;min-height:50px;padding:7px 8px;border-radius:12px;cursor:pointer;transition:background-color .12s ease-out,transform .1s ease-out}
.dsh-rss-feed:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-feed:active{transform:scale(.98)}
.dsh-rss-feed[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6)) 12%,transparent)}
.dsh-rss-avatar{flex:none;width:32px;height:32px;display:grid;place-items:center;border-radius:10px;font-size:14px;font-weight:600;user-select:none}
.dsh-rss-avatar[data-c="0"]{background:color-mix(in srgb,var(--dsw-static-blue-500,#3b82f6) 22%,transparent);color:var(--dsw-static-blue-500,#3b82f6)}
.dsh-rss-avatar[data-c="1"]{background:color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 22%,transparent);color:var(--dsw-static-green-500,#22c55e)}
.dsh-rss-avatar[data-c="2"]{background:color-mix(in srgb,var(--dsw-static-amber-500,#f59e0b) 24%,transparent);color:var(--dsw-static-amber-500,#f59e0b)}
.dsh-rss-avatar[data-c="3"]{background:color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 20%,transparent);color:var(--dsw-static-deepseek-500,#4176e6)}
.dsh-rss-avatar[data-c="4"]{background:color-mix(in srgb,var(--dsw-static-neutral-500,#7f8287) 24%,transparent);color:var(--dsw-static-neutral-500,#7f8287)}
.dsh-rss-feedMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rss-feedTop{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}
.dsh-rss-feedName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:18px}
.dsh-rss-feed[data-warn=true] .dsh-rss-feedName{color:var(--dsw-alias-state-warn-label,#b8860b)}
.dsh-rss-feedTime{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-feedBottom{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-rss-feedWarn{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-state-warn-label,#b8860b)}
.dsh-rss-feedCount{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-feedTools{flex:none;margin-left:auto;display:flex;align-items:center;gap:4px}
.dsh-rss-feedRefresh{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#545557);cursor:pointer;opacity:0;transition:opacity .12s ease-out,background-color .12s ease-out,transform .1s ease-out}
.dsh-rss-feed:hover .dsh-rss-feedRefresh,.dsh-rss-feed:focus-within .dsh-rss-feedRefresh,.dsh-rss-feedRefresh:focus-visible{opacity:1}
.dsh-rss-feedRefresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-feedRefresh:active:not(:disabled){transform:scale(.9)}
.dsh-rss-feedRefresh:disabled{cursor:default}
.dsh-rss-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.dsh-rss-head{flex:none;display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.dsh-rss-headTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600;line-height:20px}
.dsh-rss-headCount{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-headMeta{flex:1;min-width:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-headActions{flex:none;margin-left:auto;display:flex;align-items:center;gap:6px;min-width:0}
.dsh-rss-site{flex:none;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-secondary,#545557);font-size:11px;line-height:14px;text-decoration:none;max-width:170px;transition:transform .1s ease-out,background-color .12s ease-out,color .12s ease-out}
.dsh-rss-site:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-site:active{transform:scale(.97)}
.dsh-rss-siteText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rss-notice{flex:none;display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:12px;line-height:16px;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 7%,transparent);color:var(--dsw-alias-state-error-primary,#d54941)}
.dsh-rss-noticeWarn{border-bottom-color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b8860b) 25%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b8860b) 7%,transparent);color:var(--dsw-alias-state-warn-label,#b8860b)}
.dsh-rss-noticeText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rss-add{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.dsh-rss-addRow{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-rss-addInput{height:30px;font-size:13px}
.dsh-rss-addTitle{flex:1;min-width:0}
.dsh-rss-addError{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#d54941);overflow-wrap:anywhere}
.dsh-rss-searchWrap{flex:none;display:flex;align-items:center;gap:7px;padding:10px 12px 6px;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-searchInput{flex:1;min-width:0}
.dsh-rss-items{flex:1;min-height:0;overflow-y:auto;padding:2px 8px 12px;display:flex;flex-direction:column;gap:6px}
.dsh-rss-item{padding:8px 10px;border-radius:12px;border:.5px solid transparent;cursor:pointer;animation:dsh-rss-in .16s ease-out;transition:background-color .12s ease-out,border-color .12s ease-out,transform .1s ease-out}
.dsh-rss-item:hover{background:var(--dsw-alias-bg-layer-1,#fafafa)}
.dsh-rss-item[data-open=true]{background:var(--dsw-alias-bg-layer-1,#fafafa);border-color:var(--dsw-alias-border-l2,#e5e5e5)}
.dsh-rss-item:active{transform:scale(.98)}
@keyframes dsh-rss-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dsh-rss-itemTop{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-rss-chip{flex:none;display:inline-flex;align-items:center;max-width:150px;height:20px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-2,#f5f5f5);font:inherit;font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary,#545557);cursor:pointer;transition:transform .1s ease-out,background-color .12s ease-out,color .12s ease-out}
.dsh-rss-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-chip:active{transform:scale(.97)}
.dsh-rss-chipText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rss-itemTitle{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,#1f1f1f);text-decoration:none}
.dsh-rss-itemTitleBtn{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;font:inherit;color:inherit;display:flex;align-items:center;gap:5px;text-align:left}
.dsh-rss-itemTitleBtn:hover .dsh-rss-itemTitleText{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));text-decoration:underline}
.dsh-rss-itemTitleNoLink{color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-itemTitleText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rss-noLinkIcon{flex:none;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-itemTime{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#7f8287);font-variant-numeric:tabular-nums}
.dsh-rss-itemBody{margin-top:3px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#545557);overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;max-height:35px;opacity:.92;transition:max-height .18s ease-out,opacity .18s ease-out}
.dsh-rss-item[data-open=true] .dsh-rss-itemBody{-webkit-line-clamp:99;max-height:280px;opacity:1}
.dsh-rss-center{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;color:var(--dsw-alias-label-tertiary,#7f8287);text-align:center}
.dsh-rss-centerTitle{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-btn{appearance:none;font:inherit;font-size:12px;line-height:16px;height:28px;padding:0 12px;border-radius:var(--dsw-radius-md,10px);border:.5px solid var(--dsw-alias-border-l3,#d4d4d4);background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;transition:transform .1s ease-out,background-color .12s ease-out,filter .12s ease-out,border-color .12s ease-out,color .12s ease-out}
.dsh-rss-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-btn:active:not(:disabled){transform:scale(.97)}
.dsh-rss-btn:disabled{opacity:.45;cursor:default}
.dsh-rss-btn-accent{background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.dsh-rss-btn-accent:hover:not(:disabled){background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));filter:brightness(1.07)}
.dsh-rss-btn-danger{color:var(--dsw-alias-state-error-primary,#d54941);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 45%,transparent)}
.dsh-rss-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 10%,transparent)}
.dsh-rss-btn[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-iconBtn{width:28px;padding:0}
.dsh-rss-input{width:100%;height:28px;padding:0 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-bg-layer-1,#fafafa);border:.5px solid var(--dsw-alias-border-l3,#d4d4d4);border-radius:10px;outline:none;transition:border-color .15s ease-out}
.dsh-rss-input::placeholder{color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-input:focus-visible{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6))}
.dsh-rss-renameInput{flex:1;min-width:0;height:28px;font-size:13px;font-weight:500}
.dsh-rss-spinner{flex:none;display:inline-block;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dsh-rss-spin .8s linear infinite}
@keyframes dsh-rss-spin{to{transform:rotate(360deg)}}
.dsh-rss-allRow:focus-visible,.dsh-rss-feed:focus-visible,.dsh-rss-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.dsh-rss-btn:focus-visible,.dsh-rss-chip:focus-visible,.dsh-rss-feedRefresh:focus-visible,.dsh-rss-site:focus-visible,.dsh-rss-popClose:focus-visible,.dsh-rss-itemTitleBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.dsh-rss-itemActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:5px;min-width:0}
.dsh-rss-transBtn{height:24px;padding:0 10px;font-size:11px;line-height:14px;border-radius:8px}
.dsh-rss-transGhost{color:var(--dsw-alias-label-tertiary,#7f8287);border-color:transparent}
.dsh-rss-transGhost:hover:not(:disabled){color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-transError{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:14px;color:var(--dsw-alias-state-error-primary,#d54941)}
.dsh-rss-parallel{margin-top:5px;display:flex;flex-direction:column;gap:7px;min-width:0}
.dsh-rss-mtChip{align-self:flex-start;display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-2,#f5f5f5);color:var(--dsw-alias-label-tertiary,#7f8287);font-size:10px;line-height:12px;user-select:none}
.dsh-rss-pair{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rss-pairOriginal{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary,#1f1f1f);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-rss-pairTrans{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#545557);border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6)) 45%,transparent);padding-left:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-rss-pop{position:absolute;z-index:20;width:min(360px,calc(100% - 16px));padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,#f5f5f5));box-shadow:0 8px 24px rgba(0,0,0,.14);animation:dsh-rss-popIn .14s ease-out}
@keyframes dsh-rss-popIn{from{opacity:0}to{opacity:1}}
.dsh-rss-popHead{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsh-rss-popLang{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:12px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-popClose{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#7f8287);font:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background-color .12s ease-out,color .12s ease-out,transform .1s ease-out}
.dsh-rss-popClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-popClose:active{transform:scale(.9)}
.dsh-rss-popMain{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary,#1f1f1f);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-rss-popMainLoading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-popMainError{color:var(--dsw-alias-state-error-primary,#d54941)}
.dsh-rss-popSrc{display:flex;flex-direction:column;gap:2px;margin-top:8px;min-width:0}
.dsh-rss-popSrcLabel{font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-popSrcText{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#7f8287);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.dsh-rss-hiddenInput{display:none}
.dsh-rss-importResult{flex:none;display:flex;align-items:flex-start;gap:8px;padding:7px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-1,#fafafa);font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-importResultBody{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-rss-importResultSummary{font-weight:600;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-importResultList{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rss-importResultLine{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,#d54941)}
.dsh-rss-importResultMore{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-modal{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px}
.dsh-rss-modalMask{position:absolute;inset:0;background:rgba(0,0,0,.42);background:color-mix(in srgb,var(--dsw-static-neutral-1000,#000) 42%,transparent);animation:dsh-rss-modalFadeIn .2s ease-out}
.dsh-rss-modalPanel{position:relative;display:flex;flex-direction:column;width:min(720px,100%);max-height:85vh;border-radius:18px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 86%,transparent);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 45%,transparent),0 24px 64px rgba(0,0,0,.28);overflow:hidden;animation:dsh-rss-modalIn .22s ease-out}
@keyframes dsh-rss-modalIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes dsh-rss-modalOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.96)}}
@keyframes dsh-rss-modalFadeIn{from{opacity:0}to{opacity:1}}
@keyframes dsh-rss-modalFadeOut{from{opacity:1}to{opacity:0}}
.dsh-rss-modal[data-closing=true] .dsh-rss-modalMask{animation:dsh-rss-modalFadeOut .18s ease-out forwards}
.dsh-rss-modal[data-closing=true] .dsh-rss-modalPanel{animation:dsh-rss-modalOut .18s ease-out forwards}
.dsh-rss-modalClose{position:absolute;top:10px;right:10px;z-index:2;display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#545557);font:inherit;font-size:15px;line-height:1;cursor:pointer;transition:transform .1s ease-out,background-color .12s ease-out,color .12s ease-out}
.dsh-rss-modalClose:hover{color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-modalClose:active{transform:scale(.9)}
.dsh-rss-modalClose:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.dsh-rss-modalBody{flex:1;min-height:0;overflow-y:auto;padding:24px 28px 16px}
.dsh-rss-modalTitle{margin:0 40px 10px 0;font-size:20px;font-weight:700;letter-spacing:-0.02em;line-height:1.35;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere}
.dsh-rss-modalMeta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-bottom:18px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#7f8287)}
.dsh-rss-modalFeed{max-width:220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-modalTime{font-variant-numeric:tabular-nums}
.dsh-rss-modalOpen{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));text-decoration:none;font-weight:500}
.dsh-rss-modalOpen:hover{text-decoration:underline}
.dsh-rss-modalText{display:flex;flex-direction:column;gap:14px;padding-bottom:6px}
.dsh-rss-modalPara{margin:0;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-rss-modalParallel{margin-top:0;gap:12px}
.dsh-rss-modal .dsh-rss-pairOriginal,.dsh-rss-modal .dsh-rss-pairTrans{font-size:14px;line-height:1.6}
.dsh-rss-modalTransError{margin-top:12px;font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#d54941);overflow-wrap:anywhere}
.dsh-rss-modalFooter{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.dsh-rss-modalFooterOpen{text-decoration:none}
a.dsh-rss-btn.dsh-rss-modalFooterOpen:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-rss-modalLoading{display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 0;color:var(--dsw-alias-label-tertiary,#7f8287);font-size:13px}
.dsh-rss-modalError{display:flex;flex-direction:column;align-items:center;gap:10px;padding:32px 0;font-size:13px;color:var(--dsw-alias-state-error-primary,#d54941)}
.dsh-rss-modalErrorText{overflow-wrap:anywhere;text-align:center}
.dsh-rss-md{display:flex;flex-direction:column;gap:12px;padding-bottom:6px}
.dsh-rss-mdH1{margin:16px 0 0;font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.3;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere}
.dsh-rss-mdH2{margin:14px 0 0;font-size:19px;font-weight:700;letter-spacing:-.02em;line-height:1.3;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere}
.dsh-rss-mdH3{margin:12px 0 0;font-size:17px;font-weight:600;letter-spacing:-.02em;line-height:1.35;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere}
.dsh-rss-mdH4{margin:10px 0 0;font-size:15px;font-weight:600;letter-spacing:-.02em;line-height:1.4;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere}
.dsh-rss-mdPara{margin:0;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f1f1f);overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-rss-mdPre{margin:0;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-mdPre code{font:inherit;white-space:pre}
.dsh-rss-mdCode{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12.5px;padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f5f5f5);overflow-wrap:anywhere}
.dsh-rss-mdStrong{font-weight:600}
.dsh-rss-mdEm{font-style:italic}
.dsh-rss-mdLink{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6)) 35%,transparent);overflow-wrap:anywhere}
.dsh-rss-mdLink:hover{border-bottom-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6))}
.dsh-rss-mdImg{display:block;max-width:100%;height:auto;border-radius:10px}
.dsh-rss-mdImgFallback{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#7f8287);overflow-wrap:anywhere}
.dsh-rss-mdList{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:6px;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsh-rss-mdList li{overflow-wrap:anywhere}
.dsh-rss-mdListOrdered{list-style:decimal}
.dsh-rss-mdList:not(.dsh-rss-mdListOrdered){list-style:disc}
.dsh-rss-mdQuote{margin:0;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#4176e6));display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary,#545557)}
.dsh-rss-mdQuotePara{margin:0;font-size:14px;line-height:1.6;overflow-wrap:anywhere;white-space:pre-wrap}
.dsh-rss-mdHr{margin:4px 0;border:0;border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
@media (prefers-reduced-motion:reduce){.dsh-rss-root *:not(.dsh-rss-spinner){transition:none!important;transform:none!important}.dsh-rss-item{animation:none}.dsh-rss-pop{animation:none}.dsh-rss-modalPanel{animation-name:dsh-rss-modalFadeIn}.dsh-rss-modal[data-closing=true] .dsh-rss-modalPanel{animation-name:dsh-rss-modalFadeOut}.dsh-rss-spinner{animation-duration:1.6s}}
`;
		//#endregion

		//#region 图标与小组件
		/**侧栏图标：原创 RSS 造型（一点 + 两道同心四分之一弧），currentColor。 */
		function RssPanelIcon() {
			return h('svg', {
				viewBox: '0 0 20 20', width: 20, height: 20, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
				'aria-hidden': 'true'
			},
				h('path', { d: 'M5 8.9a6.1 6.1 0 0 1 6.1 6.1' }),
				h('path', { d: 'M5 4.2a10.8 10.8 0 0 1 10.8 10.8' }),
				h('circle', { cx: 5, cy: 15, r: 1.5, fill: 'currentColor', stroke: 'none' })
			);
		}
		/**「全部源」图标：地球（圆 + 经纬线）。 */
		function GlobeIcon() {
			return h('svg', {
				viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true'
			},
				h('circle', { cx: 8, cy: 8, r: 6.2 }),
				h('path', { d: 'M1.8 8h12.4' }),
				h('ellipse', { cx: 8, cy: 8, rx: 2.8, ry: 6.2 })
			);
		}
		/**刷新图标：弧 + 箭头。 */
		function RefreshIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M12 7a5 5 0 1 1-1.7-3.75' }),
				h('path', { d: 'M12.1 1.6v2.6H9.5' })
			);
		}
		/**外链图标：小窗 + 出口箭头。 */
		function ExternalIcon() {
			return h('svg', {
				viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M5 2.2H3.4A1.4 1.4 0 0 0 2 3.6v5A1.4 1.4 0 0 0 3.4 10h5a1.4 1.4 0 0 0 1.4-1.4V7' }),
				h('path', { d: 'M7 2.2h3v3' }),
				h('path', { d: 'M10 2.2 5.6 6.6' })
			);
		}
		/**重命名图标：铅笔。 */
		function RenameIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M9.9 2.1a1.6 1.6 0 0 1 2.3 2.3l-.8.8-2.3-2.3.8-.8Z' }),
				h('path', { d: 'M8.4 3.6l2.3 2.3-6.2 6.2-2.9.6.6-2.9 6.2-6.2Z' })
			);
		}
		/**移除图标：垃圾桶。 */
		function RemoveIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M2 3.8h10' }),
				h('path', { d: 'M5.6 3.8V2.6a.8.8 0 0 1 .8-.8h1.2a.8.8 0 0 1 .8.8v1.2' }),
				h('path', { d: 'M3.4 3.8l.5 7.1a1.1 1.1 0 0 0 1.1 1h3a1.1 1.1 0 0 0 1.1-1l.5-7.1' }),
				h('path', { d: 'M5.8 6.4v3M8.2 6.4v3' })
			);
		}
		/**导出图标：箭头向下入托盘。 */
		function DownloadIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M7 1.7v6.3' }),
				h('path', { d: 'M4.4 5.6 7 8.2l2.6-2.6' }),
				h('path', { d: 'M1.8 9.6v1.4a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3V9.6' })
			);
		}
		/**导入图标：箭头向上出托盘。 */
		function UploadIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M7 8.3V2' }),
				h('path', { d: 'M4.4 4.6 7 2l2.6 2.6' }),
				h('path', { d: 'M1.8 9.6v1.4a1.3 1.3 0 0 0 1.3 1.3h7.8a1.3 1.3 0 0 0 1.3-1.3V9.6' })
			);
		}
		/**「无链接」图标：链环 + 斜杠。 */
		function NoLinkIcon() {
			return h('svg', {
				viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
				'aria-hidden': 'true'
			},
				h('path', { d: 'M4.6 7.4a2.7 2.7 0 0 1 0-3.8l1.2-1.2a2.7 2.7 0 0 1 3.8 3.8L8.4 7.4' }),
				h('path', { d: 'M7.4 4.6a2.7 2.7 0 0 1 0 3.8L6.2 9.6a2.7 2.7 0 0 1-3.8-3.8l1.2-1.2' }),
				h('path', { d: 'M1.6 1.6l8.8 8.8' })
			);
		}
		/**搜索图标：放大镜。 */
		function SearchIcon() {
			return h('svg', {
				viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
				'aria-hidden': 'true'
			},
				h('circle', { cx: 6.2, cy: 6.2, r: 4.4 }),
				h('path', { d: 'M9.5 9.5l2.9 2.9' })
			);
		}
		/**警告图标：小三角 + 叹号线。 */
		function WarnIcon() {
			return h('svg', {
				viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M6 1.8 11.2 10.4H.8L6 1.8Z' }),
				h('path', { d: 'M6 5v2.6' }),
				h('path', { d: 'M6 9.1v.01' })
			);
		}
		/**加载 spinner。 */
		function Spinner({ size }) {
			const px = String(size || 12) + 'px';
			return h('span', { className: 'dsh-rss-spinner', style: { width: px, height: px }, 'aria-hidden': 'true' });
		}
		/**空态插画：还没有订阅（RSS 弧 + 加号徽章）。 */
		function IllusFeeds() {
			return h('svg', {
				viewBox: '0 0 64 64', width: 56, height: 56, fill: 'none',
				stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('path', { d: 'M16 30a20 20 0 0 1 20 20' }),
				h('path', { d: 'M16 14a36 36 0 0 1 36 36' }),
				h('circle', { cx: 17, cy: 49, r: 4, fill: 'currentColor', stroke: 'none' }),
				h('circle', { cx: 47, cy: 17, r: 9, fill: 'var(--dsw-alias-bg-base,#fff)' }),
				h('path', { d: 'M47 13.5v7M43.5 17h7' })
			);
		}
		/**空态插画：暂无文章（文档 + 文字行）。 */
		function IllusEmpty() {
			return h('svg', {
				viewBox: '0 0 64 64', width: 56, height: 56, fill: 'none',
				stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('rect', { x: 16, y: 10, width: 32, height: 44, rx: 6 }),
				h('path', { d: 'M24 22h16M24 30h16M24 38h10' })
			);
		}
		/**空态插画：搜索无结果（放大镜 + 叉）。 */
		function IllusSearch() {
			return h('svg', {
				viewBox: '0 0 64 64', width: 56, height: 56, fill: 'none',
				stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round',
				strokeLinejoin: 'round', 'aria-hidden': 'true'
			},
				h('circle', { cx: 27, cy: 27, r: 14 }),
				h('path', { d: 'M37.5 37.5 52 52' }),
				h('path', { d: 'M22 22l10 10M32 22l-10 10', opacity: .7 })
			);
		}
		/**空态插画：加载失败（圆 + 叹号）。 */
		function IllusError() {
			return h('svg', {
				viewBox: '0 0 64 64', width: 56, height: 56, fill: 'none',
				stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round',
				'aria-hidden': 'true'
			},
				h('circle', { cx: 32, cy: 32, r: 22 }),
				h('path', { d: 'M32 21v15' }),
				h('path', { d: 'M32 43v.01' })
			);
		}
		/**居中空态。 */
		function EmptyState({ icon, text }) {
			return h('div', { className: 'dsh-rss-center' }, icon, h('div', { className: 'dsh-rss-centerTitle' }, text));
		}
		/**左侧源行：头像（首字符粉彩底）+ 标题 + 计数/最近时间 + 刷新按钮。 */
		function FeedRow({ feed, selected, refreshing, t, onSelect, onRefresh }) {
			const name = feed.title || feed.url || feed.id;
			const errorText = feed.error ? fmtError(feed.error) : '';
			const latest = relTime(feed.latestAt, t);
			const select = (event) => { event.stopPropagation(); onSelect(); };
			return h('div', {
				className: 'dsh-rss-feed',
				'data-selected': selected ? 'true' : undefined,
				'data-warn': feed.error ? 'true' : undefined,
				role: 'button', tabIndex: 0,
				onClick: select,
				onKeyDown: (event) => {
					if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); }
				}
			},
				h('span', { className: 'dsh-rss-avatar', 'data-c': String(colorSeed(feed.id)), 'aria-hidden': 'true' }, firstChar(name)),
				h('span', { className: 'dsh-rss-feedMain' },
					h('span', { className: 'dsh-rss-feedTop', title: errorText ? name + ' · ' + errorText : name },
						h('span', { className: 'dsh-rss-feedName' }, name),
						latest ? h('span', { className: 'dsh-rss-feedTime' }, latest) : null
					),
					h('span', { className: 'dsh-rss-feedBottom' },
						errorText ? h('span', { className: 'dsh-rss-feedWarn', title: errorText, role: 'img', 'aria-label': t('feed.errorAria') }, h(WarnIcon)) : null,
						h('span', { className: 'dsh-rss-feedCount' }, t('count.items', { count: feed.itemCount || 0 })),
						h('span', { className: 'dsh-rss-feedTools' },
							refreshing ? h(Spinner, { size: 11 }) : null,
							h('button', {
								className: 'dsh-rss-feedRefresh',
								onClick: (event) => { event.stopPropagation(); onRefresh(); },
								disabled: refreshing,
								title: t('feed.refresh'),
								'aria-label': t('feed.refresh')
							}, h(RefreshIcon))
						)
					)
				)
			);
		}
		/**右侧文章行：来源 chip（全部视图）+ 标题按钮（点击打开全文弹窗）+ 相对时间 + 2 行摘要（可展开、可对照翻译）。 */
		function ItemView({ item, showSource, open, onToggle, onSelectSource, onOpenEntry, trans, onTranslate, t }) {
			const title = typeof item.title === 'string' && item.title ? item.title : t('item.untitled');
			const hasLink = typeof item.link === 'string' && item.link.length > 0;
			const timeText = relTime(item.publishedAt, t);
			const toggle = () => onToggle(item.id);
			// 标题=打开全文弹窗（仍是可聚焦控件，Enter 原生触发 click）；阻止 keydown 冒泡到行（行 Enter/Space=展开摘要）
			const titleNode = h('button', {
				className: 'dsh-rss-itemTitle dsh-rss-itemTitleBtn' + (hasLink ? '' : ' dsh-rss-itemTitleNoLink'),
				type: 'button',
				title: item.title || t('item.untitled'),
				onClick: (event) => { event.stopPropagation(); onOpenEntry(item, event.currentTarget); },
				onKeyDown: (event) => {
					if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
				}
			},
				hasLink ? null : h('span', { className: 'dsh-rss-noLinkIcon' }, h(NoLinkIcon)),
				h('span', { className: 'dsh-rss-itemTitleText' }, title)
			);
			const transState = trans || { showing: false, loading: false, error: '', prominent: false, pairs: null };
			let bodyNode;
			if (transState.pairs && transState.pairs.length) {
				// 对照视图：机译 chip + 每行「原文 / 译文」相邻排布（纯文本节点渲染）
				bodyNode = h('div', { className: 'dsh-rss-parallel' },
					h('span', { className: 'dsh-rss-mtChip' }, t('translate.chip')),
					transState.pairs.map((pair, index) => h('div', { key: index, className: 'dsh-rss-pair' },
						h('div', { className: 'dsh-rss-pairOriginal' }, pair.original),
						h('div', { className: 'dsh-rss-pairTrans' }, pair.translated)
					))
				);
			} else if (item.summary) {
				bodyNode = h('div', { className: 'dsh-rss-itemBody' }, item.summary);
			} else {
				bodyNode = null;
			}
			const actionsNode = open && (item.summary || item.title)
				? h('div', { className: 'dsh-rss-itemActions' },
					transState.error ? h('span', { className: 'dsh-rss-transError', title: transState.error }, transState.error) : null,
					h('button', {
						className: 'dsh-rss-btn dsh-rss-transBtn' + (transState.prominent || transState.showing ? '' : ' dsh-rss-transGhost'),
						onClick: (event) => { event.stopPropagation(); onTranslate(); },
						disabled: transState.loading
					},
						transState.loading ? h(Spinner, { size: 11 }) : null,
						transState.showing ? t('translate.showOriginal') : (transState.prominent ? t('translate.action') : t('translate.ghost'))
					)
				)
				: null;
			return h('div', {
				className: 'dsh-rss-item',
				'data-open': open ? 'true' : undefined,
				role: 'button', tabIndex: 0,
				onClick: toggle,
				onKeyDown: (event) => {
					if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
				}
			},
				h('div', { className: 'dsh-rss-itemTop' },
					showSource && item.feedTitle ? h('button', {
						className: 'dsh-rss-chip',
						title: item.feedTitle,
						onClick: (event) => { event.stopPropagation(); onSelectSource(item.feedId); }
					}, h('span', { className: 'dsh-rss-chipText' }, item.feedTitle)) : null,
					titleNode,
					timeText ? h('span', { className: 'dsh-rss-itemTime', title: fullTime(item.publishedAt) }, timeText) : null
				),
				bodyNode,
				actionsNode
			);
		}
		//#region Markdown 渲染（手写解析器直产 React 元素；feed 全文是不可信数据）
		/**
		 * 行内解析：单趟扫描产 span/strong/code/a/img 数组——**粗**、*斜*、`行内码`、
		 * [文](url) 与 ![alt](url)；裸 URL 不自动链接（保守）。不合法链接/图片降级为
		 * 原文字面纯文本节点；源文本中的 HTML 标签天然按字面转义（React 文本节点）。
		 */
		function mdInline(text, keyPrefix, altFallback) {
			const source = String(text ?? '');
			const nodes = [];
			let buffer = '';
			let key = 0;
			const flush = () => { if (buffer !== '') { nodes.push(buffer); buffer = ''; } };
			for (let i = 0; i < source.length; i++) {
				const ch = source[i];
				if (ch === '!' && source[i + 1] === '[') {
					const close = source.indexOf(']', i + 2);
					if (close > i + 1 && source[close + 1] === '(') {
						const endParen = source.indexOf(')', close + 2);
						if (endParen > close + 1) {
							const alt = source.slice(i + 2, close);
							const raw = source.slice(close + 2, endParen);
							const url = safeUrl(raw);
							flush();
							if (url !== null && url.startsWith('https://')) {
								nodes.push(h('img', {
									key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdImg', src: url,
									alt: alt || (altFallback || ''), loading: 'lazy', referrerPolicy: 'no-referrer',
									onError: (event) => { event.currentTarget.style.display = 'none'; }
								}));
							} else {
								nodes.push(h('span', { key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdImgFallback' }, `![${alt}](${raw})`));
							}
							i = endParen;
							continue;
						}
					}
				} else if (ch === '`') {
					const end = source.indexOf('`', i + 1);
					if (end > i + 1 && !source.slice(i + 1, end).includes('\n')) {
						flush();
						nodes.push(h('code', { key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdCode' }, source.slice(i + 1, end)));
						i = end;
						continue;
					}
				} else if (ch === '*' && source[i + 1] === '*') {
					const end = source.indexOf('**', i + 2);
					if (end > i + 2 && !source.slice(i + 2, end).includes('\n')) {
						flush();
						nodes.push(h('strong', { key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdStrong' }, source.slice(i + 2, end)));
						i = end + 1;
						continue;
					}
				} else if (ch === '*' && source[i + 1] !== '*' && source[i + 1] !== ' ') {
					const end = source.indexOf('*', i + 1);
					const inner = end > i + 1 ? source.slice(i + 1, end) : '';
					if (end > i + 1 && source[end + 1] !== '*' && !inner.includes('\n') && !inner.endsWith(' ')) {
						flush();
						nodes.push(h('em', { key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdEm' }, inner));
						i = end;
						continue;
					}
				} else if (ch === '[') {
					const close = source.indexOf(']', i + 1);
					if (close > i && source[close + 1] === '(') {
						const endParen = source.indexOf(')', close + 2);
						if (endParen > close + 1) {
							const label = source.slice(i + 1, close);
							const url = safeUrl(source.slice(close + 2, endParen));
							if (label.length > 0 && label.length <= 200 && url !== null) {
								flush();
								nodes.push(h('a', {
									key: keyPrefix + '-' + (key++), className: 'dsh-rss-mdLink', href: url,
									target: '_blank', rel: 'noreferrer noopener'
								}, label));
								i = endParen;
								continue;
							}
						}
					}
				}
				buffer += ch;
			}
			flush();
			return nodes;
		}

		/**
		 * Markdown 块级渲染：按行扫描状态机 → 直接产出 React 元素（标题 h1-h4、
		 * 段落、代码围栏、一层 ul/ol、blockquote、hr）。绝不生成 HTML 字符串，
		 * 绝不使用 dangerouslySetInnerHTML。
		 */
		function MarkdownView({ text, altFallback }) {
			const lines = String(text ?? '').split('\n');
			const blocks = [];
			let key = 0;
			const isSpecial = (t) => t.startsWith('```') || /^#{1,4}\s+\S/.test(t) || /^[-*+]\s+\S/.test(t)
				|| /^\d{1,3}\.\s+\S/.test(t) || /^>\s*\S/.test(t) || /^(-{3,}|\*{3,})$/.test(t);
			let i = 0;
			while (i < lines.length) {
				const line = lines[i];
				const trimmed = line.trim();
				if (trimmed === '') { i += 1; continue; }
				if (trimmed.startsWith('```')) {
					i += 1;
					const code = [];
					while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i += 1; }
					i += 1; // 收尾围栏（截断文本无围栏时自然结束）
					blocks.push(h('pre', { key: key++, className: 'dsh-rss-mdPre' }, h('code', null, code.join('\n'))));
					continue;
				}
				const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
				if (heading !== null) {
					const level = heading[1].length;
					blocks.push(h(`h${level}`, { key: key++, className: `dsh-rss-mdH${level}` }, mdInline(heading[2], `h${key}`, altFallback)));
					i += 1;
					continue;
				}
				if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
					blocks.push(h('hr', { key: key++, className: 'dsh-rss-mdHr' }));
					i += 1;
					continue;
				}
				if (/^>\s*\S/.test(trimmed)) {
					const quote = [];
					while (i < lines.length && /^>\s*\S/.test(lines[i].trim())) {
						quote.push(lines[i].trim().replace(/^>\s?/, ''));
						i += 1;
					}
					blocks.push(h('blockquote', { key: key++, className: 'dsh-rss-mdQuote' },
						quote.map((para, index) => h('p', { key: index, className: 'dsh-rss-mdQuotePara' }, mdInline(para, `q${key}-${index}`, altFallback)))));
					continue;
				}
				if (/^[-*+]\s+\S/.test(trimmed) || /^\d{1,3}\.\s+\S/.test(trimmed)) {
					const ordered = /^\d/.test(trimmed);
					const items = [];
					while (i < lines.length) {
						const t = lines[i].trim();
						if ((ordered ? /^\d{1,3}\.\s+\S/ : /^[-*+]\s+\S/).test(t)) {
							items.push(t.replace(ordered ? /^\d{1,3}\.\s+/ : /^[-*+]\s+/, ''));
							i += 1;
							continue;
						}
						if (t !== '' && /^\s/.test(lines[i]) && items.length > 0) { // 缩进续行并入上一项
							items[items.length - 1] += ' ' + t;
							i += 1;
							continue;
						}
						break;
					}
					blocks.push(h(ordered ? 'ol' : 'ul', { key: key++, className: 'dsh-rss-mdList' + (ordered ? ' dsh-rss-mdListOrdered' : '') },
						items.map((item, index) => h('li', { key: index }, mdInline(item, `l${key}-${index}`, altFallback)))));
					continue;
				}
				const para = [];
				while (i < lines.length && lines[i].trim() !== '' && !isSpecial(lines[i].trim())) {
					para.push(lines[i]);
					i += 1;
				}
				blocks.push(h('p', { key: key++, className: 'dsh-rss-mdPara' }, mdInline(para.join('\n'), `p${key}`, altFallback)));
			}
			return h('div', { className: 'dsh-rss-md' }, blocks);
		}
		//#endregion

		/**全文阅读弹窗（Apple 风格磨砂浮层）：外站内容全部纯文本节点渲染，焦点圈定在弹窗内。 */
		function EntryModal({ item, entry, loading, error, closing, full, onTranslateFull, onRetry, onClose, t }) {
			const { useEffect, useRef } = React;
			const panelRef = useRef(null);
			const closeRef = useRef(null);
			// 打开即聚焦关闭按钮（焦点随弹层进入；卸载时由外层归还触发标题）
			useEffect(() => {
				const el = closeRef.current;
				if (el) el.focus();
			}, []);
			/**焦点圈定：Tab 在弹窗内首/末可聚焦元素间循环；Esc 关闭（stopPropagation 免触其他 Esc 逻辑）。 */
			const onKeyDown = (event) => {
				if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
				if (event.key !== 'Tab') return;
				const panel = panelRef.current;
				if (!panel) return;
				const nodes = panel.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
				const list = [];
				for (const node of nodes) if (node.offsetParent !== null) list.push(node);
				if (!list.length) return;
				const first = list[0];
				const last = list[list.length - 1];
				const active = document.activeElement;
				if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
				else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
			};
			const feedTitle = entry && entry.feedTitle ? entry.feedTitle : item.feedTitle;
			const publishedAt = entry && typeof entry.publishedAt === 'number' ? entry.publishedAt : item.publishedAt;
			const link = entry && typeof entry.link === 'string' ? entry.link : item.link;
			const title = entry && entry.title ? entry.title : (item.title || t('item.untitled'));
			const bodyText = entry ? String(entry.content || entry.summary || '') : '';
			let bodyNode;
			if (loading) {
				bodyNode = h('div', { className: 'dsh-rss-modalLoading' }, h(Spinner, { size: 18 }), t('list.loading'));
			} else if (error) {
				bodyNode = h('div', { className: 'dsh-rss-modalError' },
					h('div', { className: 'dsh-rss-modalErrorText' }, error),
					h('button', { className: 'dsh-rss-btn', onClick: onRetry }, t('modal.retry'))
				);
			} else if (full.pairs && full.pairs.length) {
				// 全文对照：机译 chip + 逐段「原文 / 译文」（复用列表对照样式，弹窗内放大字号）
				bodyNode = h('div', { className: 'dsh-rss-parallel dsh-rss-modalParallel' },
					h('span', { className: 'dsh-rss-mtChip' }, t('translate.chip')),
					full.pairs.map((pair, index) => h('div', { key: index, className: 'dsh-rss-pair' },
						h('div', { className: 'dsh-rss-pairOriginal' },
							looksLikeMarkdown(pair.original) ? h(MarkdownView, { text: pair.original, altFallback: title }) : pair.original),
						h('div', { className: 'dsh-rss-pairTrans' }, pair.translated)
					))
				);
			} else if (bodyText) {
				// 命中保守启发式才按 Markdown 呈现（直产 React 元素，零 HTML 注入）；否则维持按 \n 分段纯文本
				bodyNode = looksLikeMarkdown(bodyText)
					? h(MarkdownView, { text: bodyText, altFallback: title })
					: h('div', { className: 'dsh-rss-modalText' },
						bodyText.split('\n').map((para, index) => h('p', { key: index, className: 'dsh-rss-modalPara' }, para))
					);
			} else {
				bodyNode = null;
			}
			return h('div', { className: 'dsh-rss-modal', 'data-closing': closing ? 'true' : undefined, onKeyDown },
				h('div', { className: 'dsh-rss-modalMask', onClick: onClose, 'aria-hidden': 'true' }),
				h('div', { className: 'dsh-rss-modalPanel', ref: panelRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
					h('button', {
						className: 'dsh-rss-modalClose',
						ref: closeRef,
						onClick: onClose,
						'aria-label': t('modal.close'),
						title: t('modal.close')
					}, '×'),
					h('div', { className: 'dsh-rss-modalBody' },
						h('h2', { className: 'dsh-rss-modalTitle' }, title),
						h('div', { className: 'dsh-rss-modalMeta' },
							feedTitle ? h('span', { className: 'dsh-rss-modalFeed', title: feedTitle }, feedTitle) : null,
							feedTitle && publishedAt ? h('span', { 'aria-hidden': 'true' }, '·') : null,
							publishedAt ? h('span', { className: 'dsh-rss-modalTime' }, fullTime(publishedAt)) : null,
							link ? h('a', { className: 'dsh-rss-modalOpen', href: link, target: '_blank', rel: 'noreferrer noopener' },
								h(ExternalIcon), h('span', null, t('modal.open'))) : null
						),
						bodyNode,
						full.error ? h('div', { className: 'dsh-rss-modalTransError' }, full.error) : null
					),
					h('div', { className: 'dsh-rss-modalFooter' },
						link ? h('a', { className: 'dsh-rss-btn dsh-rss-modalFooterOpen', href: link, target: '_blank', rel: 'noreferrer noopener' },
							h(ExternalIcon), t('modal.open')) : null,
						h('button', {
							className: 'dsh-rss-btn' + (full.pairs ? '' : ' dsh-rss-btn-accent'),
							onClick: onTranslateFull,
							disabled: full.loading || loading || !!error || !bodyText
						},
							full.loading ? h(Spinner, { size: 12 }) : null,
							full.loading && full.progress
								? t('modal.translating', { done: full.progress.done, total: full.progress.total })
								: (full.pairs ? t('translate.showOriginal') : t('modal.translate'))
						)
					)
				)
			);
		}
		//#endregion

		//#region 主面板
		function RssPage({ t, api, localeId }) {
			const { useState, useEffect, useRef, useCallback } = React;
			const [snapshot, setSnapshot] = useState(null);
			const [allItems, setAllItems] = useState([]);
			const [loading, setLoading] = useState(true);
			const [loadError, setLoadError] = useState(null); // state() 拉取失败
			const [actionError, setActionError] = useState(null); // refresh/rename/remove 失败
			const [streamDown, setStreamDown] = useState(false); // follow 流中断标志
			const [selectedFeedId, setSelectedFeedId] = useState(null); // null = 全部源
			const [query, setQuery] = useState('');
			const [expanded, setExpanded] = useState({}); // item.id -> true
			const [addUrl, setAddUrl] = useState('');
			const [addTitle, setAddTitle] = useState('');
			const [addExpanded, setAddExpanded] = useState(false); // 可选标题输入展开
			const [adding, setAdding] = useState(false);
			const [addError, setAddError] = useState(null);
			const [renaming, setRenaming] = useState(false);
			const [renameDraft, setRenameDraft] = useState('');
			const [confirmRemove, setConfirmRemove] = useState(false); // 两步删除确认
			const [removing, setRemoving] = useState(false);
			const [refreshBusy, setRefreshBusy] = useState(false);
			const [transShow, setTransShow] = useState({}); // item.id -> 已显示对照视图
			const [transLoading, setTransLoading] = useState({}); // item.id -> 对照翻译请求中
			const [transError, setTransError] = useState({}); // item.id -> 对照翻译失败文案
			const [popover, setPopover] = useState(null); // 划词翻译弹层（同时仅一个）
			const [exporting, setExporting] = useState(false); // OPML 导出中
			const [importing, setImporting] = useState(false); // OPML 导入中（逐源校验较慢）
			const [importResult, setImportResult] = useState(null); // 导入结果摘要 { added, failed[] }
			const [modal, setModal] = useState(null); // 全文弹窗 { item, closing }
			const [modalEntry, setModalEntry] = useState(null); // entry() 返回的全文条目
			const [modalLoading, setModalLoading] = useState(false);
			const [modalError, setModalError] = useState(null);
			const [modalRetry, setModalRetry] = useState(0); // 递增触发重试
			const [fullTrans, setFullTrans] = useState({ loading: false, error: '', pairs: null }); // 全文翻译对照

			const backoffRef = useRef(1000);
			const timerRef = useRef(0);
			const stoppedRef = useRef(false);
			const selectedRef = useRef(null);
			const renameInputRef = useRef(null);
			const handleEventRef = useRef(() => {});
			const refreshRef = useRef(() => {});
			const rootRef = useRef(null); // 面板根（划词范围 + 弹层定位容器）
			const popRef = useRef(null); // 弹层元素（点击命中检测）
			const transCacheRef = useRef(new Map()); // `${item.id}|${to}` -> { to, pairs }
			const selTimerRef = useRef(0); // 划词防抖定时器
			const selCacheRef = useRef([]); // 最近 ~10 条划词翻译结果
			const popSeqRef = useRef(0); // 弹层异步序号（旧响应作废）
			const fileInputRef = useRef(null); // 隐藏的 OPML 文件选择框
			const modalTimerRef = useRef(0); // 弹窗关闭动画定时器
			const modalTokenRef = useRef(0); // 弹窗数据请求序号（旧响应作废）
			const entryTriggerRef = useRef(null); // 触发弹窗的标题按钮（关闭后归还焦点）
			const fullTransCacheRef = useRef(new Map()); // `${item.id}|full|${to}` -> pairs

			selectedRef.current = selectedFeedId;

			/**快照落地：整体替换本地状态。 */
			const applySnapshot = useCallback((snap) => {
				if (!snap || typeof snap !== 'object') return;
				setSnapshot(snap);
				const items = Array.isArray(snap.items) ? snap.items.filter(Boolean) : [];
				setAllItems(sortItems(items));
			}, []);

			/**拉取全量快照（首拉 / 重连后 / 重试）。 */
			const refresh = useCallback(async () => {
				try {
					applySnapshot(await api.state());
					setLoadError(null);
				} catch (error) {
					setLoadError(t('error.load', { message: fmtError(error) }));
				} finally {
					setLoading(false);
				}
			}, [api, t, applySnapshot]);

			/**变更类操作（增删改名）返回值不含快照，静默回拉一次。 */
			const resync = useCallback(async () => {
				try {
					applySnapshot(await api.state());
				} catch (error) {
					setActionError(t('error.action', { message: fmtError(error) }));
				}
			}, [api, t, applySnapshot]);

			/**处理 follow 事件（kind:'state'）。 */
			const handleEvent = useCallback((ev) => {
				if (!ev || typeof ev !== 'object') return;
				if (ev.kind === 'state' && ev.state && typeof ev.state === 'object') {
					applySnapshot(ev.state);
					setStreamDown(false);
				}
			}, [applySnapshot]);

			handleEventRef.current = handleEvent;
			refreshRef.current = refresh;

			// 首拉 + follow 流（断开后指数退避 1s→8s 重建，并重拉数据）
			useEffect(() => {
				stoppedRef.current = false;
				void refresh();
				const controller = new AbortController();
				const run = async () => {
					if (stoppedRef.current) return;
					let handle = null;
					try {
						handle = await api.follow(controller.signal);
						if (!handle || typeof handle[Symbol.asyncIterator] !== 'function') {
							throw new Error('follow stream handle is not iterable');
						}
						for await (const ev of handle) {
							if (stoppedRef.current) break;
							backoffRef.current = 1000; // 有事件到达即视为链路健康
							handleEventRef.current(ev);
						}
					} catch (_) { /* 断开走下方重连 */ }
					if (stoppedRef.current) {
						try { if (handle && typeof handle.dispose === 'function') await handle.dispose(); } catch (_) { /* 忽略 */ }
						return;
					}
					try { if (handle && typeof handle.dispose === 'function') await handle.dispose(); } catch (_) { /* 忽略 */ }
					setStreamDown(true);
					const delay = backoffRef.current;
					backoffRef.current = Math.min(backoffRef.current * 2, 8000);
					timerRef.current = setTimeout(() => {
						void refreshRef.current();
						void run();
					}, delay);
				};
				void run();
				return () => {
					stoppedRef.current = true;
					controller.abort();
					clearTimeout(timerRef.current);
				};
			}, [api, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

			// 选中某源：按源补拉一次条目（与快照按 id 合并，仅作补充）
			useEffect(() => {
				if (!selectedFeedId) return;
				let cancelled = false;
				api.items({ feedId: selectedFeedId }).then((result) => {
					if (cancelled) return;
					const list = Array.isArray(result && result.items) ? result.items.filter(Boolean) : [];
					if (list.length) setAllItems((prev) => mergeItems(prev, list));
				}).catch(() => { /* 快照已含该源条目，静默 */ });
				return () => { cancelled = true; };
			}, [selectedFeedId, api]);

			// 选中源被删除：回到「全部源」
			useEffect(() => {
				if (!snapshot || !selectedFeedId) return;
				const feeds = Array.isArray(snapshot.feeds) ? snapshot.feeds : [];
				if (!feeds.some((feed) => feed && feed.id === selectedFeedId)) {
					setSelectedFeedId(null);
				}
			}, [snapshot, selectedFeedId]);

			// 切换选中时退出重命名 / 取消删除确认
			useEffect(() => {
				setRenaming(false);
				setConfirmRemove(false);
			}, [selectedFeedId]);

			// 两步删除确认 4 秒后自动复位
			useEffect(() => {
				if (!confirmRemove) return;
				const timer = setTimeout(() => setConfirmRemove(false), 4000);
				return () => clearTimeout(timer);
			}, [confirmRemove]);

			// 进入重命名：聚焦并全选
			useEffect(() => {
				if (!renaming) return;
				const el = renameInputRef.current;
				if (el) { el.focus(); el.select(); }
			}, [renaming]);

			// 划词弹层：Esc 关闭（document 级监听，随 effect 清理）
			useEffect(() => {
				if (!popover) return;
				const onKey = (event) => {
					if (event.key === 'Escape') dismissPopover(false);
				};
				document.addEventListener('keydown', onKey);
				return () => document.removeEventListener('keydown', onKey);
			}, [popover]); // eslint-disable-line react-hooks/exhaustive-deps

			// 卸载清理划词防抖定时器（根元素监听随组件卸载由 React 移除）
			useEffect(() => () => { clearTimeout(selTimerRef.current); }, []);

			/**刷新（feedId 省略 = 全部）。 */
			const doRefresh = useCallback(async (feedId) => {
				if (refreshBusy) return;
				setRefreshBusy(true);
				setActionError(null);
				try {
					applySnapshot(await api.refresh(feedId ? { feedId } : {}));
				} catch (error) {
					setActionError(t('error.action', { message: fmtError(error) }));
				} finally {
					setRefreshBusy(false);
				}
			}, [api, t, applySnapshot, refreshBusy]);

			/**添加订阅源：成功后清空表单并选中新源。 */
			const doAdd = useCallback(async () => {
				const url = addUrl.trim();
				if (!url || adding) return;
				setAdding(true);
				setAddError(null);
				try {
					const request = { url };
					const custom = addTitle.trim();
					if (custom) request.title = custom;
					const result = await api.addFeed(request);
					setAddUrl('');
					setAddTitle('');
					setAddExpanded(false);
					if (result && typeof result.feedId === 'string' && result.feedId) setSelectedFeedId(result.feedId);
					await resync();
				} catch (error) {
					setAddError(t('error.add', { message: fmtError(error) }));
				} finally {
					setAdding(false);
				}
			}, [api, adding, addUrl, addTitle, resync, t]);

			/**重命名（Enter 提交 / Esc 或失焦取消）。 */
			const doRename = useCallback(async (feedId, title) => {
				const next = String(title || '').trim();
				setRenaming(false);
				if (!next) return;
				setActionError(null);
				try {
					await api.renameFeed({ feedId, title: next });
					await resync();
				} catch (error) {
					setActionError(t('error.action', { message: fmtError(error) }));
				}
			}, [api, resync, t]);

			/**两步确认后的删除。 */
			const doRemove = useCallback(async (feedId) => {
				if (removing) return;
				setRemoving(true);
				setActionError(null);
				try {
					await api.removeFeed({ feedId });
				} catch (error) {
					setActionError(t('error.action', { message: fmtError(error) }));
					return;
				} finally {
					setRemoving(false);
				}
				setConfirmRemove(false);
				if (selectedRef.current === feedId) setSelectedFeedId(null);
				await resync();
			}, [api, removing, resync, t]);

			/**导出 OPML：取 XML 字符串 → Blob → 临时 <a download> 触发下载（不向 DOM 追加持久节点）。 */
			async function doExportOpml() {
				if (exporting || importing) return;
				setExporting(true);
				setActionError(null);
				try {
					const opml = await api.exportOpml();
					if (typeof opml !== 'string' || !opml) throw new Error('empty OPML payload');
					const blob = new Blob([opml], { type: 'text/x-opml+xml' });
					const url = URL.createObjectURL(blob);
					try {
						const link = document.createElement('a');
						link.href = url;
						link.download = 'dsh-rss-reader.opml';
						link.click();
					} finally {
						URL.revokeObjectURL(url);
					}
				} catch (error) {
					setActionError(t('opml.exportFailed', { message: fmtError(error) }));
				} finally {
					setExporting(false);
				}
			}

			/**文件选择回调：取第一个文件后立即复位 value（同一文件可重复选择）。 */
			function onImportFileChange(event) {
				const input = event.currentTarget;
				const file = input.files && input.files[0];
				input.value = '';
				if (file) void doImportOpml(file);
			}

			/**导入 OPML：读文本 → importOpml → 展示结果摘要（含前 3 条失败明细）并回拉快照。 */
			async function doImportOpml(file) {
				if (importing || exporting) return;
				setImporting(true);
				setActionError(null);
				setImportResult(null);
				try {
					const xml = await file.text();
					const result = await api.importOpml({ xml });
					setImportResult({
						added: result && typeof result.added === 'number' ? result.added : 0,
						failed: result && Array.isArray(result.failed) ? result.failed.filter(Boolean) : []
					});
					await resync();
				} catch (error) {
					setActionError(t('opml.importFailed', { message: fmtError(error) }));
				} finally {
					setImporting(false);
				}
			}

			/**展开/收起一条文章。 */
			const toggleExpand = useCallback((id) => {
				setExpanded((prev) => {
					const next = { ...prev };
					if (prev[id]) delete next[id];
					else next[id] = true;
					return next;
				});
			}, []);

			/**对照翻译：切换回原文 / 命中缓存直接显示 / 请求并缓存（标题行在最前）。 */
			async function handleTranslate(item, to) {
				const id = item.id;
				if (!id || transLoading[id]) return;
				if (transShow[id]) { setTransShow((prev) => omitKey(prev, id)); return; } // 切回原文
				const key = id + '|' + to;
				const cache = transCacheRef.current;
				if (cache.has(key)) {
					setTransError((prev) => omitKey(prev, id));
					setTransShow((prev) => ({ ...prev, [id]: true }));
					return;
				}
				// 标题 + 摘要按行拆分：每行 trim 且 ≤900 字符，跳过空行，总数 ≤50
				const titleText = String(item.title || '').trim().slice(0, 900);
				const lineTexts = String(item.summary || '').split('\n')
					.map((line) => line.trim().slice(0, 900))
					.filter(Boolean);
				const texts = (titleText ? [titleText] : []).concat(lineTexts).slice(0, 50);
				if (!texts.length) return;
				setTransLoading((prev) => ({ ...prev, [id]: true }));
				setTransError((prev) => omitKey(prev, id));
				try {
					const result = await api.translate({ texts, to });
					const outs = result && Array.isArray(result.items) ? result.items : [];
					const pairs = texts.map((text, index) => {
						const one = outs[index] || null;
						return {
							original: text,
							translated: one && typeof one.text === 'string' ? one.text : '',
							detected: one && one.detected ? String(one.detected) : null
						};
					});
					if (cache.size > 200) {
						const oldest = cache.keys().next().value;
						if (oldest !== undefined) cache.delete(oldest);
					}
					cache.set(key, { to, pairs });
					setTransShow((prev) => ({ ...prev, [id]: true }));
				} catch (error) {
					setTransError((prev) => ({ ...prev, [id]: t('translate.error', { message: fmtError(error) }) }));
				} finally {
					setTransLoading((prev) => omitKey(prev, id));
				}
			}

			/**打开全文弹窗（记录触发元素，关闭后归还焦点）。 */
			function openEntryModal(item, triggerEl) {
				entryTriggerRef.current = triggerEl || null;
				setModal({ item, closing: false });
			}

			/**关闭全文弹窗：先播对称关闭动画，动画后卸载并归还焦点。 */
			function closeEntryModal() {
				setModal((prev) => prev && !prev.closing ? { ...prev, closing: true } : prev);
				clearTimeout(modalTimerRef.current);
				modalTimerRef.current = setTimeout(() => {
					setModal(null);
					setModalEntry(null);
					setModalError(null);
					setModalLoading(false);
					setFullTrans({ loading: false, error: '', pairs: null });
					const el = entryTriggerRef.current;
					entryTriggerRef.current = null;
					if (el && el.isConnected && typeof el.focus === 'function') {
						try { el.focus(); } catch (_) { /* 忽略 */ }
					}
				}, 190);
			}

			// 弹窗打开时拉取 entry()（含 content）；modalRetry 递增即重试
			const modalId = modal ? modal.item.id : null;
			useEffect(() => {
				if (!modalId) return;
				const token = ++modalTokenRef.current;
				setModalLoading(true);
				setModalError(null);
				setModalEntry(null);
				setFullTrans({ loading: false, error: '', pairs: null });
				api.entry({ id: modalId }).then((result) => {
					if (token !== modalTokenRef.current) return;
					setModalEntry(result && typeof result === 'object' ? result : null);
				}).catch((error) => {
					if (token !== modalTokenRef.current) return;
					setModalError(t('modal.error', { message: fmtError(error) }));
				}).finally(() => {
					if (token === modalTokenRef.current) setModalLoading(false);
				});
			}, [modalId, modalRetry, api, t]);

			/**全文翻译：content 按段切块（每段 ≤900、每批 ≤50 段且合计 ≤6000 字符），多批顺序调用后拼接对照。 */
			async function handleTranslateFull() {
				if (fullTrans.loading || !modal || !modalEntry) return;
				if (fullTrans.pairs) { setFullTrans({ loading: false, error: '', pairs: null }); return; } // 切回原文
				const bodyText = String(modalEntry.content || modalEntry.summary || '');
				const paragraphs = bodyText.split('\n').map((para) => para.trim().slice(0, 900)).filter(Boolean);
				if (!paragraphs.length) return;
				const to = targetLang(localeId);
				const key = modal.item.id + '|full|' + to;
				const cache = fullTransCacheRef.current;
				if (cache.has(key)) { setFullTrans({ loading: false, error: '', pairs: cache.get(key) }); return; }
				// 分批：批内 ≤50 段、合计 ≤6000 字符（单段最长 900，必能入批）
				const batches = [];
				let batch = [];
				let chars = 0;
				for (const para of paragraphs) {
					if (batch.length && (batch.length >= 50 || chars + para.length > 6000)) {
						batches.push(batch);
						batch = [];
						chars = 0;
					}
					batch.push(para);
					chars += para.length;
				}
				if (batch.length) batches.push(batch);
				setFullTrans({ loading: true, error: '', pairs: null, progress: { done: 0, total: batches.length } });
				const pairs = [];
				try {
					for (let index = 0; index < batches.length; index++) {
						const current = batches[index];
						const result = await api.translate({ texts: current, to });
						const outs = result && Array.isArray(result.items) ? result.items : [];
						for (let i = 0; i < current.length; i++) {
							const one = outs[i] || null;
							pairs.push({ original: current[i], translated: one && typeof one.text === 'string' ? one.text : '' });
						}
						setFullTrans({ loading: true, error: '', pairs: null, progress: { done: index + 1, total: batches.length } });
					}
					if (cache.size > 60) {
						const oldest = cache.keys().next().value;
						if (oldest !== undefined) cache.delete(oldest);
					}
					cache.set(key, pairs);
					setFullTrans({ loading: false, error: '', pairs });
				} catch (error) {
					setFullTrans({ loading: false, error: t('translate.error', { message: fmtError(error) }), pairs: null });
				}
			}

			// 卸载清理弹窗定时器
			useEffect(() => () => { clearTimeout(modalTimerRef.current); }, []);

			/**关闭划词弹层；keepTimer=true 时保留防抖（紧随其后的新选区仍可触发）。 */
			function dismissPopover(keepTimer) {
				popSeqRef.current++;
				if (!keepTimer) clearTimeout(selTimerRef.current);
				setPopover(null);
			}

			/**划词翻译：mouseup / shift+方向键选区后防抖 250ms 触发。 */
			function scheduleSelectionTranslate() {
				clearTimeout(selTimerRef.current);
				selTimerRef.current = setTimeout(() => { void processSelection(); }, 250);
			}

			/**根元素 keyup：仅 Shift 组合或方向键（键盘扩大选区）时调度划词。 */
			function onRootKeyUp(event) {
				if (event.shiftKey || event.key === 'ArrowUp' || event.key === 'ArrowDown'
					|| event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
					scheduleSelectionTranslate();
				}
			}

			/**根元素 click：弹层外点击关闭（不清理防抖定时器）。 */
			function onRootClick(event) {
				if (!popover) return;
				if (popRef.current && popRef.current.contains(event.target)) return;
				dismissPopover(true);
			}

			/**读取当前选区：面板内、≤300 字符则请求翻译并展示弹层。 */
			async function processSelection() {
				const root = rootRef.current;
				if (!root || typeof window.getSelection !== 'function') { setPopover(null); return; }
				if (modal) { setPopover(null); return; } // 全文弹窗打开时不做划词翻译
				const sel = window.getSelection();
				if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { setPopover(null); return; }
				const text = String(sel.toString() || '').trim();
				const anchorNode = sel.anchorNode;
				const focusNode = sel.focusNode;
				if (!text || text.length > 300 || !anchorNode || !focusNode) { setPopover(null); return; }
				if (!root.contains(anchorNode) || !root.contains(focusNode)) { setPopover(null); return; }
				if (popRef.current && popRef.current.contains(anchorNode)) return; // 弹层内选择不触发
				const rect = sel.getRangeAt(0).getBoundingClientRect();
				const rootRect = root.getBoundingClientRect();
				const to = targetLang(localeId);
				const hit = selCacheRef.current.find((entry) => entry.text === text && entry.to === to);
				const seq = ++popSeqRef.current; // 新选区使旧请求作废
				// 定位：选区下方 8px；底部放不下且上方有空间时改放选区上方（预估高度）
				const left = rect.left - rootRect.left;
				const belowTop = rect.bottom - rootRect.top + 8;
				const aboveTop = rect.top - rootRect.top - 148;
				const top = belowTop + 140 > root.clientHeight && aboveTop >= 8 ? Math.max(8, aboveTop) : belowTop;
				const base = { text, to, left, top, rootW: root.clientWidth };
				if (hit) {
					setPopover({ ...base, loading: false, translated: hit.translated, detected: hit.detected, error: null });
					return;
				}
				setPopover({ ...base, loading: true, translated: '', detected: null, error: null });
				try {
					const result = await api.translate({ texts: [text], to });
					if (seq !== popSeqRef.current) return;
					const one = result && Array.isArray(result.items) && result.items[0] ? result.items[0] : null;
					const translated = one && typeof one.text === 'string' ? one.text : '';
					const detected = one && one.detected ? String(one.detected) : null;
					selCacheRef.current = [{ text, to, translated, detected }]
						.concat(selCacheRef.current.filter((entry) => !(entry.text === text && entry.to === to)))
						.slice(0, 10);
					setPopover((prev) => prev && prev.text === text
						? { ...prev, loading: false, translated, detected, error: null }
						: prev);
				} catch (error) {
					if (seq !== popSeqRef.current) return;
					setPopover((prev) => prev && prev.text === text
						? { ...prev, loading: false, error: t('translate.error', { message: fmtError(error) }) }
						: prev);
				}
			}

			// —— 派生视图 ——
			const feeds = snapshot && Array.isArray(snapshot.feeds) ? snapshot.feeds.filter(Boolean) : [];
			const refreshingIds = snapshot && Array.isArray(snapshot.refreshingFeedIds) ? snapshot.refreshingFeedIds : [];
			const selectedFeed = selectedFeedId ? feeds.find((feed) => feed.id === selectedFeedId) || null : null;
			const scopedItems = selectedFeedId ? allItems.filter((item) => item.feedId === selectedFeedId) : allItems;
			const q = query.trim().toLowerCase();
			const visibleItems = q ? scopedItems.filter((item) =>
				(typeof item.title === 'string' && item.title.toLowerCase().includes(q)) ||
				(typeof item.summary === 'string' && item.summary.toLowerCase().includes(q))
			) : scopedItems;
			const headTitle = selectedFeed ? (selectedFeed.title || selectedFeed.url || selectedFeed.id) : t('all.title');
			const headerRefreshing = refreshBusy || (selectedFeedId
				? refreshingIds.indexOf(selectedFeedId) !== -1
				: !!(snapshot && snapshot.refreshing));
			const updatedText = snapshot && typeof snapshot.lastRefreshAt === 'number' && snapshot.lastRefreshAt > 0
				? t('header.updated', { time: relTime(snapshot.lastRefreshAt, t) })
				: '';

			// —— 头部 ——
			let siteNode = null;
			if (selectedFeed && typeof selectedFeed.siteLink === 'string' && selectedFeed.siteLink) {
				const label = hostOf(selectedFeed.siteLink) || t('header.site');
				siteNode = h('a', {
					className: 'dsh-rss-site', href: selectedFeed.siteLink, target: '_blank', rel: 'noreferrer noopener',
					title: selectedFeed.siteLink
				}, h(ExternalIcon), h('span', { className: 'dsh-rss-siteText' }, label));
			}

			const header = h('div', { className: 'dsh-rss-head' },
				renaming && selectedFeed
					? h('input', {
						className: 'dsh-rss-input dsh-rss-renameInput',
						ref: renameInputRef,
						value: renameDraft,
						placeholder: t('rename.placeholder'),
						onChange: (event) => setRenameDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void doRename(selectedFeed.id, renameDraft);
							} else if (event.key === 'Escape') {
								setRenaming(false);
							}
						},
						onBlur: () => setRenaming(false)
					})
					: h('div', { className: 'dsh-rss-headTitle', title: headTitle }, headTitle),
				h('span', { className: 'dsh-rss-headCount' }, t('count.items', { count: scopedItems.length })),
				h('span', { className: 'dsh-rss-headMeta', title: fullTime(snapshot && snapshot.lastRefreshAt) }, updatedText),
				h('div', { className: 'dsh-rss-headActions' },
					siteNode,
					h('button', {
						className: 'dsh-rss-btn',
						onClick: () => { void doRefresh(selectedFeedId); },
						disabled: refreshBusy,
						title: t('action.refresh'),
						'aria-label': t('action.refresh')
					}, headerRefreshing ? h(Spinner, { size: 11 }) : null, t('action.refresh')),
					h('button', {
						className: 'dsh-rss-btn dsh-rss-iconBtn',
						onClick: () => { void doExportOpml(); },
						disabled: exporting || importing || !feeds.length,
						title: t('opml.export'),
						'aria-label': t('opml.export')
					}, exporting ? h(Spinner, { size: 11 }) : h(DownloadIcon)),
					h('button', {
						className: 'dsh-rss-btn dsh-rss-iconBtn',
						onClick: () => { if (fileInputRef.current) fileInputRef.current.click(); },
						disabled: exporting || importing,
						title: importing ? t('opml.importing') : t('opml.import'),
						'aria-label': t('opml.import')
					}, importing ? h(Spinner, { size: 11 }) : h(UploadIcon)),
					selectedFeed && !renaming ? h('button', {
						className: 'dsh-rss-btn dsh-rss-iconBtn',
						onClick: () => {
							setRenaming(true);
							setRenameDraft(selectedFeed.title || '');
							setConfirmRemove(false);
						},
						title: t('action.rename'),
						'aria-label': t('action.rename')
					}, h(RenameIcon)) : null,
					selectedFeed && !renaming ? (confirmRemove
						? h('button', {
							className: 'dsh-rss-btn dsh-rss-btn-danger',
							onClick: () => { void doRemove(selectedFeed.id); },
							disabled: removing,
							title: t('action.remove')
						}, removing ? h(Spinner, { size: 11 }) : null, t('action.confirm'))
						: h('button', {
							className: 'dsh-rss-btn dsh-rss-iconBtn',
							onClick: () => setConfirmRemove(true),
							title: t('action.remove'),
							'aria-label': t('action.remove')
						}, h(RemoveIcon))) : null
				)
			);

			// —— OPML 导入结果摘要（可手动关闭；失败明细最多展示 3 条） ——
			const importBanner = importResult ? h('div', { className: 'dsh-rss-importResult', role: 'status' },
				h('div', { className: 'dsh-rss-importResultBody' },
					h('div', { className: 'dsh-rss-importResultSummary' },
						t('opml.importDone', { added: importResult.added, failed: importResult.failed.length })),
					importResult.failed.length ? h('div', { className: 'dsh-rss-importResultList' },
						importResult.failed.slice(0, 3).map((failure, index) => h('div', {
							key: index,
							className: 'dsh-rss-importResultLine',
							title: (failure.url || '?') + ' — ' + (failure.error || '')
						}, (failure.url || '?') + ' — ' + (failure.error || ''))),
						importResult.failed.length > 3 ? h('div', { className: 'dsh-rss-importResultMore' },
							t('opml.moreFailed', { n: importResult.failed.length - 3 })) : null
					) : null
				),
				h('button', {
					className: 'dsh-rss-popClose',
					onClick: () => setImportResult(null),
					'aria-label': t('translate.close'),
					title: t('translate.close')
				}, '×')
			) : null;

			// —— 通知条（操作错误 / 流中断） ——
			const errorNotice = actionError || (loadError && snapshot ? loadError : null);
			const notices = h(React.Fragment, null,
				errorNotice ? h('div', { className: 'dsh-rss-notice', role: 'alert' },
					h('span', { className: 'dsh-rss-noticeText', title: errorNotice }, errorNotice)) : null,
				streamDown ? h('div', { className: 'dsh-rss-notice dsh-rss-noticeWarn' },
					h('span', { className: 'dsh-rss-noticeText' }, t('error.stream'))) : null
			);

			// —— 添加表单 ——
			const addForm = h('div', { className: 'dsh-rss-add' },
				h('div', { className: 'dsh-rss-addRow' },
					h('input', {
						className: 'dsh-rss-input dsh-rss-addInput',
						value: addUrl,
						placeholder: 'https://example.com/feed.xml',
						'aria-label': t('add.urlLabel'),
						onChange: (event) => setAddUrl(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void doAdd();
							}
						}
					}),
					h('button', {
						className: 'dsh-rss-btn',
						'data-on': addExpanded ? 'true' : undefined,
						onClick: () => setAddExpanded((prev) => !prev),
						'aria-expanded': addExpanded ? 'true' : 'false',
						title: t('add.titlePlaceholder')
					}, t('add.titleToggle')),
					h('button', {
						className: 'dsh-rss-btn dsh-rss-btn-accent',
						onClick: () => { void doAdd(); },
						disabled: !addUrl.trim() || adding
					}, adding ? h(Spinner, { size: 12 }) : null, t('action.add'))
				),
				addExpanded ? h('div', { className: 'dsh-rss-addRow' },
					h('input', {
						className: 'dsh-rss-input dsh-rss-addTitle',
						value: addTitle,
						placeholder: t('add.titlePlaceholder'),
						onChange: (event) => setAddTitle(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void doAdd();
							}
						}
					})
				) : null,
				addError ? h('div', { className: 'dsh-rss-addError' }, addError) : null
			);

			// —— 搜索 ——
			const searchRow = h('div', { className: 'dsh-rss-searchWrap' },
				h(SearchIcon),
				h('input', {
					className: 'dsh-rss-input dsh-rss-searchInput',
					value: query,
					placeholder: t('search.placeholder'),
					onChange: (event) => setQuery(event.target.value)
				})
			);

			// —— 条目列表 ——
			let listArea;
			if (loading) {
				listArea = h('div', { className: 'dsh-rss-center' },
					h(Spinner, { size: 18 }),
					h('div', { className: 'dsh-rss-centerTitle' }, t('list.loading'))
				);
			} else if (!snapshot && loadError) {
				listArea = h('div', { className: 'dsh-rss-center' },
					h(IllusError),
					h('div', { className: 'dsh-rss-centerTitle' }, loadError),
					h('button', { className: 'dsh-rss-btn', onClick: () => { void refresh(); } }, t('action.retry'))
				);
			} else if (visibleItems.length) {
				const to = targetLang(localeId);
				const cjkUI = targetIsCJK(to);
				listArea = h('div', { className: 'dsh-rss-items' },
					visibleItems.map((item, index) => {
						const entry = transShow[item.id] ? transCacheRef.current.get(item.id + '|' + to) : null;
						return h(ItemView, {
							key: item.id || ('i' + index + '-' + (item.publishedAt || 0)),
							item, t,
							showSource: !selectedFeedId,
							open: !!expanded[item.id],
							onToggle: toggleExpand,
							onSelectSource: (feedId) => { if (feedId) setSelectedFeedId(feedId); },
							onOpenEntry: openEntryModal,
							trans: {
								showing: !!entry,
								loading: !!transLoading[item.id],
								error: transError[item.id] || '',
								prominent: isCJK(String(item.title || '') + ' ' + String(item.summary || '')) !== cjkUI,
								pairs: entry ? entry.pairs : null
							},
							onTranslate: () => { void handleTranslate(item, to); }
						});
					})
				);
			} else if (q) {
				listArea = h(EmptyState, { icon: h(IllusSearch), text: t('empty.search') });
			} else if (!selectedFeedId && !feeds.length) {
				listArea = h(EmptyState, { icon: h(IllusFeeds), text: t('empty.feeds') });
			} else {
				listArea = h(EmptyState, { icon: h(IllusEmpty), text: t('empty.items') });
			}

			// —— 左栏 ——
			const side = h('div', { className: 'dsh-rss-side' },
				h('div', { className: 'dsh-rss-sidePad' },
					h('button', {
						className: 'dsh-rss-allRow',
						'data-selected': selectedFeedId ? undefined : 'true',
						onClick: () => setSelectedFeedId(null)
					},
						h('span', { className: 'dsh-rss-allIcon', 'aria-hidden': 'true' }, h(GlobeIcon)),
						h('span', { className: 'dsh-rss-allName' }, t('all.title')),
						h('span', { className: 'dsh-rss-allCount' }, String(allItems.length))
					)
				),
				h('div', { className: 'dsh-rss-feeds' },
					feeds.map((feed) => h(FeedRow, {
						key: feed.id,
						feed, t,
						selected: feed.id === selectedFeedId,
						refreshing: refreshingIds.indexOf(feed.id) !== -1,
						onSelect: () => setSelectedFeedId(feed.id),
						onRefresh: () => { void doRefresh(feed.id); }
					}))
				)
			);

			// —— 划词翻译弹层（单个，随弹层状态重建；译文为纯文本节点） ——
			let popNode = null;
			if (popover && popover.text) {
				const popLeft = Math.max(8, Math.min(popover.left, Math.max(8, popover.rootW - 368)));
				popNode = h('div', {
					className: 'dsh-rss-pop',
					ref: popRef,
					style: { left: Math.round(popLeft) + 'px', top: Math.round(popover.top) + 'px' },
					onClick: (event) => event.stopPropagation()
				},
					h('div', { className: 'dsh-rss-popHead' },
						h('span', { className: 'dsh-rss-popLang' }, popover.detected || t('translate.langUnknown')),
						h('button', {
							className: 'dsh-rss-popClose',
							onClick: () => dismissPopover(false),
							'aria-label': t('translate.close'),
							title: t('translate.close')
						}, '×')
					),
					popover.loading
						? h('div', { className: 'dsh-rss-popMain dsh-rss-popMainLoading' }, h(Spinner, { size: 12 }), t('translate.detecting'))
						: popover.error
							? h('div', { className: 'dsh-rss-popMain dsh-rss-popMainError' }, popover.error)
							: h('div', { className: 'dsh-rss-popMain' }, popover.translated),
					h('div', { className: 'dsh-rss-popSrc' },
						h('span', { className: 'dsh-rss-popSrcLabel' }, t('translate.popoverSource')),
						h('span', { className: 'dsh-rss-popSrcText' }, popover.text)
					)
				);
			}

			// —— 全文弹窗（key 按条目 id，每次打开重新挂载以重放入场动画） ——
			const modalNode = modal ? h(EntryModal, {
				key: 'modal-' + modal.item.id,
				item: modal.item,
				entry: modalEntry,
				loading: modalLoading,
				error: modalError,
				closing: modal.closing,
				full: fullTrans,
				onTranslateFull: () => { void handleTranslateFull(); },
				onRetry: () => setModalRetry((n) => n + 1),
				onClose: closeEntryModal,
				t
			}) : null;

			return h('div', {
				className: 'dsh-rss-root',
				ref: rootRef,
				onMouseUp: scheduleSelectionTranslate,
				onKeyUp: onRootKeyUp,
				onClick: onRootClick
			},
				h('style', null, CSS),
				h('input', {
					className: 'dsh-rss-hiddenInput',
					ref: fileInputRef,
					type: 'file',
					accept: '.opml,.xml,text/xml,application/xml',
					onChange: onImportFileChange
				}),
				side,
				h('div', { className: 'dsh-rss-main' },
					header,
					importBanner,
					notices,
					addForm,
					searchRow,
					listArea
				),
				popNode,
				modalNode
			);
		}
		//#endregion

		//#region mount.js（结构照抄 qq-connector / voice-input）
		const inject = ['remote', 'slots', 'locale'];

		function registerUi(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }));
			const t = ctx.locale.bind(NS);
			// Remote 调用统一解包 {ok,value|error} 信封；follow 除外——流方法同步返回 handle。
			async function unwrap(promise) {
				const result = await promise;
				if (result && typeof result === 'object' && 'ok' in result) {
					if (result.ok) return result.value;
					throw (result.error ?? new Error('remote call failed'));
				}
				return result;
			}
			// Remote 调用薄封装：统一入口，便于组件调用
			const api = {
				state: () => unwrap(ctx.remote.rss.state()),
				items: (request) => unwrap(ctx.remote.rss.items(request || {})),
				refresh: (request) => unwrap(ctx.remote.rss.refresh(request || {})),
				addFeed: (request) => unwrap(ctx.remote.rss.addFeed(request)),
				removeFeed: (request) => unwrap(ctx.remote.rss.removeFeed(request)),
				renameFeed: (request) => unwrap(ctx.remote.rss.renameFeed(request)),
				translate: (request) => unwrap(ctx.remote.rss.translate(request)),
				exportOpml: () => unwrap(ctx.remote.rss.exportOpml()),
				importOpml: (request) => unwrap(ctx.remote.rss.importOpml(request)),
				entry: (request) => unwrap(ctx.remote.rss.entry(request)),
				follow: (signal) => ctx.remote.rss.follow(signal)
			};
			// UI 语言 id（尽力从 ctx.locale 读取；取不到时组件内回退 navigator.language）
			const localeSource = ctx.locale && typeof ctx.locale === 'object' ? ctx.locale : null;
			const localeId = String((localeSource && (localeSource.id || localeSource.locale || localeSource.current || localeSource.lang)) || '');
			const RssMain = () => h(RssPage, { t, api, localeId });
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: PANEL_ID,
				locale: NS,
				inject: () => ({})
			}, RssMain));
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 11,
				locale: NS,
				label: () => t('panel')
			}, RssPanelIcon));
		}

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(RSS_REMOTE);
			// 注入 'remote.rss'（$mount 创建的命名空间服务）而非泛型 'remote'
			const ui = ctx.inject(['remote.rss', 'slots', 'locale'], registerUi);
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				await disposeRemote();
				throw error;
			}
			return async () => {
				await ui.dispose();
				await disposeRemote();
			};
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
