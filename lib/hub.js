/**
 * rss-reader host runtime: a dynamic feed store shared by the Web panel and
 * the chat tools.
 *
 * The store owns the subscription list and the retained items:
 *
 * - subscriptions live in `.rss-reader-data.json` next to the package's
 *   parent directory, seeded once from `sources` / `initialFeeds` in the
 *   plugin config when that file is empty;
 * - every feed fetches through one serialized chain, merges new items into
 *   the retained history (capped at `historyPerFeed`), and republishes a
 *   snapshot to the service, which streams it to the panel;
 * - the chat tools (`rss_status`, `rss_refresh`, `rss_read`, `rss_manage`)
 *   read and mutate the same store, so the panel and the agent never hold
 *   separate state.
 *
 * The module consumes only `ctx.logger`, `ctx.tools.register`, `ctx.effect`
 * — plus Node's fs/crypto — so tests can drive it with a fake context.
 *
 * @module rss-reader/hub
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToReadableText, parseFeed, salvageFeedDocument } from "./parse.js";

/** Characters of item summary kept in snapshots and the store. */
const SUMMARY_CHARS = 400;
/** Characters of full item text kept in the store for the `entry` payload. */
const CONTENT_CHARS = 20000;
/** Newest-first items included in one snapshot payload. */
const SNAPSHOT_ITEM_CAP = 500;
/** Default and hard bounds for numeric options. */
const BOUNDS = {
	timeoutMs: [1000, 120000, 15000],
	maxBytes: [1024, 8388608, 4194304],
	maxItemsPerFeed: [1, 200, 50],
	historyPerFeed: [1, 2000, 200],
	autoRefreshMinutes: [0, 1440, 10]
};
/** Feed title length bounds for panel renames. */
const TITLE_MIN = 1;
const TITLE_MAX = 64;
/** Latest items listed per feed in the status report. */
const STATUS_ITEM_SAMPLE = 5;
/** parser format name → wire kind. */
const KIND_BY_FORMAT = new Map([["rss2", "rss"], ["atom", "atom"], ["rdf", "rdf"], ["jsonfeed", "json"]]);
/** Debounce window kept for future coalescing; writes currently queue at once. */
const SAVE_DEBOUNCE_MS = 500;
/** Lazily resolved undici module (ProxyAgent source); empty until first use. */
let undiciPromise = null;

/** Resolve undici once: normal import first, then the Harness install's copy. */
function loadUndici() {
	undiciPromise ??= import("undici").catch(() => import("file:///E:/Deepseek-Harness/resources/app.asar/dsh/node_modules/undici/index.js"));
	return undiciPromise;
}

/** Cached proxy client per proxy URL: { fetch, agent } from ONE undici copy. */
const proxyClients = new Map();

/** One proxy client for the URL, created on first use (undefined when undici is unavailable). */
async function proxyDispatcher(proxyUrl) {
	if (!proxyClients.has(proxyUrl)) {
		const load = loadUndici().then((mod) => ({ fetch: mod.fetch, agent: new mod.ProxyAgent(proxyUrl) })).catch(() => undefined);
		proxyClients.set(proxyUrl, load);
	}
	return proxyClients.get(proxyUrl);
}

/** True when the failure chain looks like the proxy itself being unreachable or dead. */
function isProxyUnreachable(error) {
	let level = error;
	for (let depth = 0; level !== null && typeof level === "object" && depth < 4; depth += 1) {
		const text = `${level.code ?? ""} ${level.message ?? ""}`;
		if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNABORTED|EADDRNOTAVAIL|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i.test(text)) return true;
		if (/\bproxy\b/i.test(text)) return true;
		level = level.cause;
	}
	return false;
}

/**
 * Fetch through the configured HTTP proxy when one is set, falling back to a
 * direct fetch when the proxy is unavailable (e.g. the local client is off).
 * The proxy path uses the loaded undici copy's own `fetch` with its
 * `ProxyAgent` — mixing a foreign dispatcher into the global fetch is not
 * supported across undici copies.
 * @param {string} url - request target.
 * @param {object} init - fetch init (method, headers, body, signal).
 * @param {string} proxyUrl - proxy to route through, or '' for direct.
 */
export async function proxyFetch(url, init, proxyUrl) {
	if (typeof proxyUrl !== "string" || proxyUrl.length === 0) return fetch(url, init);
	let client;
	try {
		client = await proxyDispatcher(proxyUrl);
	} catch {
		client = undefined;
	}
	if (client === undefined) return fetch(url, init);
	try {
		return await client.fetch(url, { ...init, dispatcher: client.agent });
	} catch (error) {
		if (isProxyUnreachable(error)) return fetch(url, init);
		throw error;
	}
}

/** Human-readable one-line error message. */
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Clamp one numeric option into its bounds, defaulting when absent. */
function clampOption(value, [min, max, fallback]) {
	const n = Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
	return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Effective proxy: explicit config, else the classic env variables, else none. */
function resolveProxyUrl(config) {
	const fromConfig = typeof config.proxyUrl === "string" ? config.proxyUrl.trim() : "";
	if (fromConfig.length > 0) return fromConfig;
	for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
		const value = process.env[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return "";
}

/** Feed record id: stable 12-hex digest of the normalized URL. */
function feedIdFor(url) {
	let normalized = "";
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		normalized = parsed.href;
	} catch {
		normalized = url;
	}
	return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

/** ISO string → epoch ms, or null when absent/unparsable. */
function toMs(iso) {
	if (typeof iso !== "string" || iso.length === 0) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

/** Plain-text one-line summary clipped to SUMMARY_CHARS. */
function clipSummary(text) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	if (flat.length <= SUMMARY_CHARS) return flat;
	return `${flat.slice(0, SUMMARY_CHARS)}…`;
}

/** Full plain-text item body clipped to CONTENT_CHARS; paragraph breaks kept. */
function clipContent(text) {
	const body = String(text ?? "");
	return body.length <= CONTENT_CHARS ? body : body.slice(0, CONTENT_CHARS);
}

/** Compare items newest-first; undated items sink in stable order. */
function byNewestFirst(a, b) {
	return (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity);
}

/**
 * Fetch one URL as text with a per-request timeout and a hard byte cap.
 * The result flags truncation so feed parsing can salvage a complete prefix
 * (multi-megabyte changelogs regularly exceed any sane cap).
 * @returns `{ text, truncated }`
 */
async function fetchText(url, { headers = {}, timeoutMs, maxBytes, signal, proxyUrl } = {}) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);
	const response = await proxyFetch(url, { headers: { "user-agent": "dsh-rss-reader/0.1 (+feed reader)", ...headers }, redirect: "follow", signal: combined }, proxyUrl);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
	const whole = await response.text();
	if (whole.length <= maxBytes) return { text: whole, truncated: false };
	return { text: whole.slice(0, maxBytes), truncated: true };
}

/**
 * Create the feeds hub.
 *
 * `extras.onState` receives a fresh snapshot after every store mutation or
 * completed fetch; the Remote service turns it into the panel stream.
 * `extras.dataPath` overrides the store file for tests.
 *
 * @returns the hub handle: `ready`, `snapshot`, `itemsFor`, `entryItem`,
 * `refresh`, `addFeed`, `removeFeed`, `renameFeed`, `onState`,
 * `registerTools`, `dispose`.
 */
export function createHub(ctx, rawConfig, extras = {}) {
	const config = rawConfig ?? {};
	const logger = extras.logger ?? ctx.logger ?? { info() {}, warn() {} };
	const onState = typeof extras.onState === "function" ? extras.onState : () => {};
	const dataPath = extras.dataPath ?? fileURLToPath(new URL("../../.rss-reader-data.json", import.meta.url));

	const opts = {
		fetch: {
			timeoutMs: clampOption(config.fetch?.timeoutMs, BOUNDS.timeoutMs),
			maxBytes: clampOption(config.fetch?.maxBytes, BOUNDS.maxBytes),
			maxItemsPerFeed: clampOption(config.fetch?.maxItemsPerFeed, BOUNDS.maxItemsPerFeed)
		},
		proxyUrl: resolveProxyUrl(config),
		historyPerFeed: clampOption(config.historyPerFeed, BOUNDS.historyPerFeed),
		autoRefreshMinutes: clampOption(config.autoRefreshMinutes, BOUNDS.autoRefreshMinutes),
		fetchOnStart: config.fetchOnStart !== false,
		registerTools: config.registerTools !== false,
		statusToolName: config.statusToolName ?? "rss_status",
		refreshToolName: config.refreshToolName ?? "rss_refresh",
		readToolName: config.readToolName ?? "rss_read",
		manageToolName: config.manageToolName ?? "rss_manage"
	};

	/** id → { id, url, title, siteLink, kind, headers, lastFetchedAt, error } */
	const feeds = new Map();
	/** id → plain item list, newest first */
	const itemsByFeed = new Map();
	/** ids with a fetch in flight */
	const fetching = new Set();
	let lastRefreshAt = null;
	let disposed = false;
	let autoTimer = null;
	let saveChain = Promise.resolve();
	const toolDisposers = [];

	// ---------- persistence ----------

	/** Serialize one store snapshot to disk (atomic tmp + rename). */
	function persistNow() {
		const document = {
			version: 1,
			feeds: [...feeds.values()].map((feed) => ({ id: feed.id, url: feed.url, title: feed.title, siteLink: feed.siteLink, kind: feed.kind, headers: feed.headers, lastFetchedAt: feed.lastFetchedAt, error: feed.error })),
			itemsByFeed: Object.fromEntries([...itemsByFeed].map(([id, items]) => [id, items]))
		};
		const tmpPath = `${dataPath}.tmp`;
		saveChain = saveChain.then(async () => {
			await mkdir(dirname(dataPath), { recursive: true });
			await writeFile(tmpPath, `${JSON.stringify(document)}\n`, "utf8");
			await rename(tmpPath, dataPath);
		}).catch((error) => {
			logger.warn?.(`rss-reader: saving the store failed: ${errorMessage(error)}`);
		});
		return saveChain;
	}

	/** Queue one store write (serialized through `saveChain`). */
	function scheduleSave() {
		if (!disposed) void persistNow();
	}

	/** Load the store file; a malformed file is quarantined, not fatal. */
	async function loadStore() {
		let text;
		try {
			text = await readFile(dataPath, "utf8");
		} catch {
			return; // no store yet — seeding may apply
		}
		let document;
		try {
			document = JSON.parse(text);
		} catch (error) {
			const quarantine = `${dataPath}.corrupt-${Date.now()}`;
			logger.warn?.(`rss-reader: store is not valid JSON (${errorMessage(error)}); moving it to ${quarantine}`);
			await rename(dataPath, quarantine).catch(() => {});
			return;
		}
		if (document === null || typeof document !== "object") return;
		const list = Array.isArray(document.feeds) ? document.feeds : [];
		const storedItems = document.itemsByFeed !== null && typeof document.itemsByFeed === "object" ? document.itemsByFeed : {};
		for (const raw of list) {
			if (raw === null || typeof raw !== "object" || typeof raw.url !== "string" || raw.url.length === 0) continue;
			const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : feedIdFor(raw.url);
			feeds.set(id, {
				id,
				url: raw.url,
				title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : new URL(raw.url).hostname,
				siteLink: typeof raw.siteLink === "string" ? raw.siteLink : "",
				kind: typeof raw.kind === "string" ? raw.kind : "unknown",
				headers: raw.headers !== null && typeof raw.headers === "object" && !Array.isArray(raw.headers) ? raw.headers : {},
				lastFetchedAt: typeof raw.lastFetchedAt === "number" && Number.isFinite(raw.lastFetchedAt) ? raw.lastFetchedAt : null,
				error: typeof raw.error === "string" && raw.error.length > 0 ? raw.error : null
			});
			const items = storedItems[id];
			// Older stores predate the `content` field; missing reads as '' and
			// the next successful refresh of the feed backfills the full text.
			itemsByFeed.set(id, Array.isArray(items) ? items.filter((item) => item !== null && typeof item === "object").map((item) => ({ ...item, content: typeof item.content === "string" ? item.content : "" })) : []);
		}
	}

	/** Seed entries derived from `sources` + `initialFeeds`; empty-store rule. */
	function seedEntries() {
		const entries = [];
		const seen = new Set();
		const push = (url, name, headers) => {
			if (typeof url !== "string" || url.trim().length === 0) return;
			let normalized = url.trim();
			if (!/^[a-z][a-z0-9+.-]*:/i.test(normalized)) normalized = `https://${normalized}`;
			try {
				const parsed = new URL(normalized);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
				parsed.hash = "";
				const id = feedIdFor(parsed.href);
				if (seen.has(id)) return;
				seen.add(id);
				entries.push({ id, url: parsed.href, title: (typeof name === "string" && name.trim().length > 0 ? name.trim() : parsed.hostname), headers: headers ?? {} });
			} catch {
				// skip invalid seed URL
			}
		};
		for (const source of Array.isArray(config.sources) ? config.sources : []) {
			if (source === null || typeof source !== "object") continue;
			push(source.url, source.name, source.headers);
		}
		for (const url of Array.isArray(config.initialFeeds) ? config.initialFeeds : []) push(url, undefined, undefined);
		return entries;
	}

	// ---------- items ----------

	/** Map parsed feed items into the store's plain item shape. */
	function mapItems(parsed, feed) {
		return parsed.items.slice(0, opts.fetch.maxItemsPerFeed).map((item) => ({
			id: `${feed.id}|${item.id ?? item.url ?? item.title}`,
			feedId: feed.id,
			feedTitle: feed.title,
			title: item.title ?? "",
			link: typeof item.url === "string" ? item.url : "",
			publishedAt: toMs(item.published ?? item.updated),
			summary: clipSummary(item.summary ?? item.text ?? ""),
			content: clipContent(item.text ?? item.summary ?? "")
		}));
	}

	/** Merge fresh items into the retained history: union by id, newest first, capped. */
	function mergeItems(feed, fresh) {
		const previous = itemsByFeed.get(feed.id) ?? [];
		const byId = new Map(previous.map((item) => [item.id, { ...item, feedTitle: feed.title }]));
		for (const item of fresh) byId.set(item.id, item);
		const merged = [...byId.values()].sort(byNewestFirst).slice(0, opts.historyPerFeed);
		itemsByFeed.set(feed.id, merged);
		return merged;
	}

	// ---------- fetch ----------

	/** Fetch + parse one URL. Throws on network or format failure. */
	async function discover(url, headers, signal) {
		const { text, truncated } = await fetchText(url, { headers, timeoutMs: opts.fetch.timeoutMs, maxBytes: opts.fetch.maxBytes, signal, proxyUrl: opts.proxyUrl });
		try {
			return parseFeed(text, url);
		} catch (error) {
			if (!truncated) throw error;
			// 截断的文档：截到最后一个完整条目并闭合根元素后重试
			const salvaged = salvageFeedDocument(text);
			if (salvaged === null) throw error;
			logger.warn?.(`rss-reader: ${url} exceeded the byte cap; parsed the salvaged prefix`);
			return parseFeed(salvaged, url);
		}
	}

	/** Serialize per-feed work through one chain. */
	function enqueue(feedId, run) {
		const chain = (chains.get(feedId) ?? Promise.resolve()).then(run, run);
		chains.set(feedId, chain.catch(() => {}));
		return chain;
	}
	const chains = new Map();

	/**
	 * Refresh one feed in place. Fetch failures keep the retained items and
	 * surface the error on the record.
	 */
	function refreshOne(feed, signal) {
		return enqueue(feed.id, async () => {
			try {
				const parsed = await discover(feed.url, feed.headers, signal);
				feed.kind = KIND_BY_FORMAT.get(parsed.format) ?? feed.kind;
				if (typeof parsed.link === "string" && parsed.link.length > 0) feed.siteLink = parsed.link;
				feed.error = null;
				feed.lastFetchedAt = Date.now();
				mergeItems(feed, mapItems(parsed, feed));
				logger.info?.(`rss-reader(${feed.title}): fetched ${parsed.format} — ${parsed.items.length} items`);
			} catch (error) {
				feed.error = errorMessage(error);
				feed.lastFetchedAt = Date.now();
				logger.warn?.(`rss-reader(${feed.title}): fetch failed: ${feed.error}`);
			}
		});
	}

	/** True when the id matches a feed by id, exact title, or exact URL. */
	function matchFeed(selector) {
		if (typeof selector !== "string" || selector.length === 0) return undefined;
		return feeds.get(selector) ?? [...feeds.values()].find((feed) => feed.title === selector || feed.url === selector);
	}

	// ---------- snapshots ----------

	/** One feed's snapshot record. */
	function feedView(feed) {
		const items = itemsByFeed.get(feed.id) ?? [];
		return {
			id: feed.id,
			url: feed.url,
			title: feed.title,
			siteLink: feed.siteLink,
			kind: feed.kind,
			error: feed.error,
			lastFetchedAt: feed.lastFetchedAt,
			itemCount: items.length,
			latestAt: items.length > 0 ? items[0].publishedAt : null
		};
	}

	/**
	 * Item view for the snapshot and `items()` wire payloads: the summary
	 * list stays lean — the full `content` leaves the host only through
	 * `entry()`, one entry at a time.
	 */
	function itemWireView(item) {
		return {
			id: item.id,
			feedId: item.feedId,
			feedTitle: item.feedTitle,
			title: item.title,
			link: item.link,
			publishedAt: item.publishedAt,
			summary: item.summary
		};
	}

	/** Full panel snapshot per the frozen Client contract. */
	function snapshot() {
		const items = [];
		for (const list of itemsByFeed.values()) items.push(...list);
		items.sort(byNewestFirst);
		return {
			version: 1,
			refreshing: fetching.size > 0,
			refreshingFeedIds: [...fetching],
			lastRefreshAt,
			feeds: [...feeds.values()].map(feedView),
			items: items.slice(0, SNAPSHOT_ITEM_CAP).map(itemWireView)
		};
	}

	/** Filtered item list for `items(feedId?, limit?)`. */
	function itemsFor(request) {
		const feedId = request?.feedId;
		let items;
		if (typeof feedId === "string" && feedId.length > 0) {
			items = [...(itemsByFeed.get(feedId) ?? [])];
		} else {
			items = [];
			for (const list of itemsByFeed.values()) items.push(...list);
			items.sort(byNewestFirst);
		}
		const limit = clampOption(request?.limit, [1, SNAPSHOT_ITEM_CAP, 100]);
		return items.slice(0, limit).map(itemWireView);
	}

	/**
	 * Find one retained item by its exact id across every feed's history.
	 * The stored record carries every field the `entry` payload needs
	 * (including the full `content`); returns null when no feed holds it.
	 */
	function entryItem(id) {
		if (typeof id !== "string" || id.length === 0) return null;
		for (const items of itemsByFeed.values()) {
			const item = items.find((candidate) => candidate.id === id);
			if (item !== undefined) return { ...item };
		}
		return null;
	}

	function notify() {
		if (!disposed) onState(snapshot());
	}

	// ---------- public store operations ----------

	/**
	 * Refresh one feed (selector: id, exact title, or exact URL) or every
	 * feed (empty selector). Resolves after every targeted fetch settles;
	 * returns the fresh snapshot. An unmatched non-empty selector throws.
	 */
	async function refresh(selector) {
		const explicit = typeof selector === "string" && selector.trim().length > 0;
		const targets = [...matchTargets(explicit ? selector.trim() : "")];
		if (explicit && targets.length === 0) throw new Error(`no feed matches "${selector}"`);
		if (targets.length === 0) return snapshot();
		for (const feed of targets) fetching.add(feed.id);
		notify();
		try {
			await Promise.all(targets.map((feed) => refreshOne(feed)));
		} finally {
			for (const feed of targets) fetching.delete(feed.id);
			lastRefreshAt = Date.now();
			scheduleSave();
			notify();
		}
		return snapshot();
	}

	/** Targets for one selector: every feed when empty; none when unmatched. */
	function* matchTargets(selector) {
		if (typeof selector !== "string" || selector.length === 0) {
			for (const candidate of feeds.values()) yield candidate;
			return;
		}
		const feed = matchFeed(selector);
		if (feed !== undefined) yield feed;
	}

	/** Validate one URL for subscription; throws on invalid input. */
	function requireFeedUrl(raw) {
		let text = String(raw ?? "").trim();
		if (text.length === 0) throw new Error("url is required");
		if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
		let parsed;
		try {
			parsed = new URL(text);
		} catch {
			throw new Error(`not a valid URL: ${raw}`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`url must use http or https: ${raw}`);
		parsed.hash = "";
		return parsed.href;
	}

	/**
	 * Subscribe to a new feed. Fetches once to validate before the record is
	 * stored, so the panel never lists a feed that cannot be read.
	 */
	async function addFeed(request) {
		const url = requireFeedUrl(request?.url);
		const id = feedIdFor(url);
		if (feeds.has(id)) throw new Error(`already subscribed: ${feeds.get(id).url}`);
		const overrideTitle = typeof request?.title === "string" ? request.title.trim() : "";
		const headers = {};
		fetching.add(id);
		notify();
		try {
			let parsed;
			try {
				parsed = await discover(url, headers);
			} catch (error) {
				throw new Error(`fetch failed: ${errorMessage(error)}`);
			}
			const feed = {
				id,
				url,
				title: overrideTitle.length > 0 ? overrideTitle.slice(0, TITLE_MAX) : (parsed.title && parsed.title.trim().length > 0 ? parsed.title.trim().slice(0, TITLE_MAX) : new URL(url).hostname),
				siteLink: typeof parsed.link === "string" ? parsed.link : "",
				kind: KIND_BY_FORMAT.get(parsed.format) ?? "unknown",
				headers,
				lastFetchedAt: Date.now(),
				error: null
			};
			feeds.set(id, feed);
			itemsByFeed.set(id, []);
			mergeItems(feed, mapItems(parsed, feed));
			scheduleSave();
			return { feedId: id };
		} finally {
			fetching.delete(id);
			notify();
		}
	}

	/** Drop one subscription and its retained items. */
	function removeFeed(request) {
		const id = String(request?.feedId ?? "");
		if (!feeds.has(id)) throw new Error(`no feed with id "${id}"`);
		feeds.delete(id);
		itemsByFeed.delete(id);
		fetching.delete(id);
		scheduleSave();
		notify();
		return { ok: true };
	}

	/** Rename one subscription (display title only). */
	function renameFeed(request) {
		const id = String(request?.feedId ?? "");
		const feed = feeds.get(id);
		if (feed === undefined) throw new Error(`no feed with id "${id}"`);
		const title = String(request?.title ?? "").trim();
		if (title.length < TITLE_MIN || title.length > TITLE_MAX) throw new Error(`title must be ${TITLE_MIN}-${TITLE_MAX} characters`);
		feed.title = title;
		const items = itemsByFeed.get(id) ?? [];
		for (const item of items) item.feedTitle = title;
		scheduleSave();
		notify();
		return { ok: true };
	}

	const stateListeners = new Set();

	/** Snapshot subscription for the Remote stream. */
	function subscribeState(listener) {
		stateListeners.add(listener);
		return () => stateListeners.delete(listener);
	}

	// ---------- chat tools ----------

	/** Origins the read tool may fetch: subscribed feeds plus their item links. */
	function allowedOrigins() {
		const origins = new Set();
		const admit = (url) => {
			try {
				origins.add(new URL(url).origin);
			} catch {}
		};
		for (const feed of feeds.values()) {
			admit(feed.url);
			for (const item of itemsByFeed.get(feed.id) ?? []) {
				if (item.link.length > 0) admit(item.link);
			}
		}
		return origins;
	}

	/** Find one item across every feed (or one matched feed) by URL or id. */
	function findItem(locator, feedSelector) {
		const pool = typeof feedSelector === "string" && feedSelector.length > 0
			? [...matchTargets(feedSelector)]
			: [...feeds.values()];
		for (const feed of pool) {
			for (const item of itemsByFeed.get(feed.id) ?? []) {
				if (locator === item.link || locator === item.id) return { feed, item };
			}
		}
		return null;
	}

	/** Render a hub snapshot as markdown for the status/refresh tools. */
	function renderStatusMarkdown(value) {
		const lines = [];
		lines.push(`# RSS Reader — ${value.summary.ok}/${value.summary.feeds} feeds ok — ${value.summary.items} items (at ${value.summary.generatedAt})`);
		for (const feed of value.feeds) {
			const flag = feed.state === "ok" ? "●" : feed.state === "fetching" ? "…" : "✕";
			lines.push(`## ${flag} ${feed.title} — ${feed.state}${feed.siteLink ? ` — ${feed.siteLink}` : ""}`);
			if (feed.lastError) lines.push(`last error: ${feed.lastError}`);
			if (feed.state === "ok" || feed.itemCount > 0) {
				lines.push(`${feed.kind} — ${feed.itemCount} items`);
				for (const item of feed.items) {
					const when = item.publishedAt === null ? "" : ` (${new Date(item.publishedAt).toISOString()})`;
					lines.push(`- ${item.title}${when}${item.link ? ` — ${item.link}` : ""}`);
				}
			}
		}
		return lines.join("\n");
	}

	/** Serializable per-feed view for the status report. */
	function reportFeeds(selector) {
		const targets = typeof selector === "string" && selector.length > 0 ? [...matchTargets(selector)] : [...feeds.values()];
		return targets.map((feed) => {
			const items = itemsByFeed.get(feed.id) ?? [];
			return {
				id: feed.id,
				title: feed.title,
				url: feed.url,
				siteLink: feed.siteLink,
				kind: feed.kind,
				state: fetching.has(feed.id) ? "fetching" : feed.error === null ? (items.length > 0 || feed.lastFetchedAt !== null ? "ok" : "pending") : "failed",
				itemCount: items.length,
				lastFetchedAt: feed.lastFetchedAt,
				lastError: feed.error ?? undefined,
				items: items.slice(0, STATUS_ITEM_SAMPLE).map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt, summary: item.summary }))
			};
		});
	}

	/** Report summary + feeds in the shape the tools return. */
	function report(selector) {
		const feedsView = reportFeeds(selector);
		return {
			summary: {
				feeds: feedsView.length,
				ok: feedsView.filter((feed) => feed.state === "ok").length,
				failed: feedsView.filter((feed) => feed.state === "failed").length,
				items: feedsView.reduce((total, feed) => total + feed.itemCount, 0),
				generatedAt: new Date().toISOString()
			},
			feeds: feedsView
		};
	}

	/** Register the four chat tools on `ctx.tools`. */
	function registerTools(toolCtx) {
		if (typeof toolCtx.tools?.register !== "function") {
			logger.warn?.("rss-reader: the tools service is unavailable; chat tools stay unregistered");
			return;
		}
		toolDisposers.push(toolCtx.tools.register({
			name: opts.statusToolName,
			description: "List the RSS/Atom feeds this Harness subscribes to. The report shows each feed title, its state, and its latest items. Pass feed=<title|url|id> to report one feed only. The panel in the Web GUI shows the same data.",
			parameters: {
				type: "object",
				properties: { feed: { type: "string", description: "Optional feed title, URL, or id; omit for all feeds" } },
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { summary: { type: "object" }, feeds: { type: "array", items: {} } },
					required: ["summary", "feeds"],
					additionalProperties: false
				},
				render(_args, value) {
					return [{ type: "text", text: renderStatusMarkdown(value) }];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe() {
				return true;
			},
			execute(args) {
				const selector = typeof args?.feed === "string" && args.feed.length > 0 ? args.feed : undefined;
				const value = report(selector);
				if (selector !== undefined && value.feeds.length === 0) throw new Error(`no feed matches "${selector}"`);
				return value;
			}
		}));

		toolDisposers.push(toolCtx.tools.register({
			name: opts.refreshToolName,
			description: "Fetch the subscribed feeds again and report the updated item lists. Use this when a feed published new entries. Pass feed=<title|url|id> to refresh one feed only.",
			parameters: {
				type: "object",
				properties: { feed: { type: "string", description: "Optional feed title, URL, or id; omit to refresh every feed" } },
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { refreshed: { type: "array", items: { type: "string" } }, failed: { type: "array", items: { type: "string" } }, summary: { type: "object" }, feeds: { type: "array", items: {} } },
					required: ["refreshed", "failed", "summary", "feeds"],
					additionalProperties: false
				},
				render(_args, value) {
					const head = `refreshed: ${value.refreshed.length > 0 ? value.refreshed.join(", ") : "(none)"}${value.failed.length > 0 ? `; failed: ${value.failed.join(", ")}` : ""}`;
					return [{ type: "text", text: `${head}\n${renderStatusMarkdown(value)}` }];
				}
			},
			timeoutMs: 120000,
			async execute(args) {
				const selector = typeof args?.feed === "string" && args.feed.length > 0 ? args.feed : undefined;
				const before = report(selector);
				await refresh(selector);
				const value = report(selector);
				const previous = new Set(before.feeds.map((feed) => feed.id));
				return {
					refreshed: value.feeds.filter((feed) => feed.state !== "failed" && previous.has(feed.id)).map((feed) => feed.title),
					failed: value.feeds.filter((feed) => feed.state === "failed").map((feed) => feed.title),
					summary: value.summary,
					feeds: value.feeds
				};
			}
		}));

		toolDisposers.push(toolCtx.tools.register({
			name: opts.readToolName,
			description: "Read one feed entry as text. Pass url=<item link or id> from the rss_status report. mode=content (default) reads the text stored in the feed. mode=page fetches the linked page. Reads stay limited to the subscribed feeds and their item links.",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "Item link or id from the rss_status report" },
					feed: { type: "string", description: "Optional feed title, URL, or id; limits the item search" },
					mode: { type: "string", enum: ["content", "page"], description: "content reads the stored text; page fetches the linked page" },
					maxChars: { type: "number", description: "Max characters returned (default 12000, max 50000)" }
				},
				required: ["url"],
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { feed: { type: "string" }, title: { type: "string" }, url: { type: "string" }, publishedAt: {}, mode: { type: "string" }, text: { type: "string" } },
					required: ["feed", "title", "url", "mode", "text"],
					additionalProperties: false
				},
				render(_args, value) {
					const head = [`# ${value.title}`, `feed: ${value.feed}${value.publishedAt === null ? "" : ` — ${new Date(value.publishedAt).toISOString()}`}`, value.url, `mode: ${value.mode}`, ""];
					return [{ type: "text", text: head.join("\n") + value.text }];
				}
			},
			timeoutMs: 60000,
			isConcurrencySafe() {
				return true;
			},
			async execute(args, exec) {
				const locator = typeof args?.url === "string" ? args.url.trim() : "";
				if (locator.length === 0) throw new Error("url is required");
				const feedSelector = typeof args?.feed === "string" && args.feed.length > 0 ? args.feed : undefined;
				const found = findItem(locator, feedSelector);
				if (found === null) throw new Error(`no feed entry matches "${locator}"${feedSelector !== undefined ? ` in feed "${feedSelector}"` : ""} — call ${opts.statusToolName} for the current entry list`);
				const { feed, item } = found;
				const mode = args?.mode === "page" ? "page" : "content";
				const maxChars = Math.min(Math.max(Number.isFinite(args?.maxChars) && Number.isInteger(args.maxChars) ? args.maxChars : 12000, 500), 50000);
				let text = item.summary;
				if (mode === "page") {
					if (item.link.length === 0) throw new Error("this entry has no page link; use mode=content");
					const allowed = allowedOrigins();
					let target;
					try {
						target = new URL(item.link);
					} catch {
						throw new Error(`entry link is not a valid URL: ${item.link}`);
					}
					if (!allowed.has(target.origin)) throw new Error(`refused: ${target.origin} is outside the subscribed feeds and their entry links`);
					const page = (await fetchText(target.href, { headers: feed.headers, timeoutMs: opts.fetch.timeoutMs, maxBytes: opts.fetch.maxBytes, signal: exec?.signal, proxyUrl: opts.proxyUrl })).text;
					const titleMatch = page.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
					const pageTitle = titleMatch === null ? null : htmlToReadableText(titleMatch[1]);
					text = htmlToReadableText(page);
					if (pageTitle !== null && pageTitle.length > 0 && !text.startsWith(pageTitle)) text = `${pageTitle}\n\n${text}`;
				}
				if (text.length === 0) text = "(this entry has no text content)";
				return {
					feed: feed.title,
					title: item.title,
					url: item.link.length > 0 ? item.link : locator,
					publishedAt: item.publishedAt,
					mode,
					text: text.slice(0, maxChars) + (text.length > maxChars ? `\n…(truncated at ${maxChars} chars — call again with a larger maxChars if needed)` : "")
				};
			}
		}));

		toolDisposers.push(toolCtx.tools.register({
			name: opts.manageToolName,
			description: "Manage the feed subscriptions persistently (the Web panel uses the same store). Actions: list (default) shows the subscriptions. add inserts {url, name?} and validates it with one fetch. rename sets {feed, title}. remove drops {feed}. `feed` matches a title, URL, or id.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "add", "rename", "remove"], description: "Management action" },
					feed: { type: "string", description: "Feed title, URL, or id (rename/remove: required)" },
					url: { type: "string", description: "Feed URL (add: required)" },
					name: { type: "string", description: "Display title (add: optional; defaults to the feed's own title)" },
					title: { type: "string", description: "New display title (rename: required)" }
				},
				required: ["action"],
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { action: { type: "string" }, changed: { type: "boolean" }, feeds: { type: "array", items: {} }, note: { type: "string" } },
					required: ["action", "changed", "feeds"],
					additionalProperties: false
				},
				render(_args, value) {
					const lines = [`action: ${value.action}${value.changed ? " (saved)" : ""}`];
					for (const feed of value.feeds) lines.push(`- ${feed.title} — ${feed.url}${feed.error ? ` (error: ${feed.error})` : ""}`);
					if (value.note) lines.push(value.note);
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			timeoutMs: 120000,
			async execute(args) {
				const action = args?.action ?? "list";
				const listing = () => [...feeds.values()].map((feed) => ({ id: feed.id, title: feed.title, url: feed.url, error: feed.error }));
				if (action === "list") {
					return { action, changed: false, feeds: listing(), note: "panel add/remove/rename writes the same store" };
				}
				if (action === "add") {
					const { feedId } = await addFeed({ url: args?.url, title: args?.name });
					return { action, changed: true, feeds: listing(), note: `subscribed as ${feedId}` };
				}
				if (action === "rename") {
					const feed = matchFeed(args?.feed);
					if (feed === undefined) throw new Error(`no feed matches "${args?.feed ?? ""}"`);
					renameFeed({ feedId: feed.id, title: args?.title });
					return { action, changed: true, feeds: listing() };
				}
				if (action === "remove") {
					const feed = matchFeed(args?.feed);
					if (feed === undefined) throw new Error(`no feed matches "${args?.feed ?? ""}"`);
					removeFeed({ feedId: feed.id });
					return { action, changed: true, feeds: listing() };
				}
				throw new Error(`unknown action "${action}" — use list, add, rename, or remove`);
			}
		}));
	}

	// ---------- lifecycle ----------

	/** Auto-refresh tick: quiet, skips when a refresh is already running. */
	function scheduleAutoRefresh() {
		if (opts.autoRefreshMinutes <= 0 || autoTimer !== null) return;
		autoTimer = setTimeout(() => {
			autoTimer = null;
			if (disposed) return;
			if (fetching.size === 0 && feeds.size > 0) void refresh().catch(() => {});
			scheduleAutoRefresh();
		}, opts.autoRefreshMinutes * 60_000);
	}

	const hub = {
		opts,
		get feeds() {
			return feeds;
		},
		snapshot,
		itemsFor,
		entryItem,
		refresh,
		addFeed,
		removeFeed,
		renameFeed,
		onState: subscribeState,
		registerTools,
		/** Resolves when every queued store write has settled. */
		persisted() {
			return saveChain;
		},
		/** Startup readiness: store loaded (and seeded); fetches run after. */
		ready: (async () => {
			await loadStore();
			if (feeds.size === 0) {
				const seeds = seedEntries();
				for (const seed of seeds) {
					feeds.set(seed.id, { ...seed, siteLink: "", kind: "unknown", lastFetchedAt: null, error: null });
					itemsByFeed.set(seed.id, []);
				}
				if (feeds.size > 0) {
					logger.info?.(`rss-reader: seeded ${feeds.size} feed(s) from the plugin config`);
					void persistNow();
				}
			}
			notify();
			if (opts.registerTools) registerTools(ctx);
			if (opts.fetchOnStart && feeds.size > 0) void refresh().catch(() => {});
			scheduleAutoRefresh();
		})(),
		async dispose() {
			disposed = true;
			if (autoTimer !== null) clearTimeout(autoTimer);
			for (const dispose of toolDisposers.splice(0)) {
				try {
					dispose();
				} catch {}
			}
			if (feeds.size > 0) await persistNow();
		}
	};

	return hub;
}
