/**
 * Machine translation for the reader panel.
 *
 * A provider chain, each step routed through the plugin's proxy-aware fetch
 * so a local proxy (or direct) works uniformly:
 *
 * 1. Bing — the Edge browser's token endpoint plus the public Translator
 *    v3 endpoint. Free, batch-capable, precise language detection. The token
 *    endpoint is unofficial and may be unavailable in some networks, which is
 *    exactly why the chain continues;
 * 2. Google — the keyless `translate_a` gtx endpoint (auto-detect);
 * 3. MyMemory — keyless community API as the last resort (heuristic source
 *    language, small daily quota).
 *
 * Every provider returns items aligned 1:1 with the input texts:
 * `{ detected: string | null, text: string }`.
 *
 * @module rss-reader/translate
 */

import { proxyFetch } from "./hub.js";

/** Per-request timeout for translation calls (ms). */
const REQUEST_TIMEOUT_MS = 15000;
/** Bing v3 accepts arrays; keep one request at most this size. */
const BING_BATCH = 40;
/** Google gtx is single-text; cap the parallel GETs. */
const GOOGLE_PARALLEL = 4;

/** One cached Bing bearer token with its expiry. */
const bingToken = { value: null, expiresAt: 0, loading: null };

/** Target-code aliases: unified input code → provider-native code. */
const CODE_ALIASES = new Map([["zh-CHS", "zh-CN"], ["zh-Hant", "zh-TW"], ["zh-Hans", "zh-CN"], ["iw", "he"]]);

/** Normalize one target code for a provider that uses BCP-47-like codes. */
function bcp47(code) {
	return CODE_ALIASES.get(code) ?? code;
}

/** True when the text contains CJK ideographs or kana (source-language heuristic). */
function isCJK(text) {
	return /[\u2E80-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text);
}

/** fetch JSON (or text) through the proxy with the shared timeout. */
async function request(url, init, proxyUrl) {
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const mergedSignal = init?.signal === undefined ? signal : AbortSignal.any([signal, init.signal]);
	const response = await proxyFetch(url, { ...init, signal: mergedSignal }, proxyUrl);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.startsWith("https://api.cognitive") ? "the translator API" : new URL(url).hostname}`);
	return response;
}

/** Fetch a fresh Edge translate token (cached until ~2 min before expiry). */
async function bingAuthToken(proxyUrl) {
	const now = Date.now();
	if (bingToken.value !== null && bingToken.expiresAt > now + 120000) return bingToken.value;
	bingToken.loading ??= (async () => {
		const response = await request("https://edge.microsoft.com/translate/auth", { method: "GET" }, proxyUrl);
		const text = (await response.text()).trim();
		const payload = text.split(".")[1];
		if (payload === undefined) throw new Error("the token endpoint returned no JWT");
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const expiresAt = Number.isFinite(claims.exp) ? claims.exp * 1000 : now + 300000;
		bingToken.value = text;
		bingToken.expiresAt = expiresAt;
		return text;
	})().finally(() => {
		bingToken.loading = null;
	});
	return bingToken.loading;
}

/** Provider 1: Bing Translator v3 with the Edge token (batch). */
async function bingTranslate(texts, to, proxyUrl) {
	const token = await bingAuthToken(proxyUrl);
	const items = [];
	for (let offset = 0; offset < texts.length; offset += BING_BATCH) {
		const batch = texts.slice(offset, offset + BING_BATCH);
		const response = await request(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(bcp47(to))}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(batch.map((text) => ({ Text: text })))
		}, proxyUrl);
		const data = await response.json();
		if (!Array.isArray(data) || data.length !== batch.length) throw new Error("unexpected Bing response shape");
		for (const entry of data) {
			const translated = Array.isArray(entry?.translations) && typeof entry.translations[0]?.text === "string" ? entry.translations[0].text : "";
			items.push({ detected: typeof entry?.detectedLanguage?.language === "string" ? entry.detectedLanguage.language : null, text: translated });
		}
	}
	return items;
}

/** Provider 2: the keyless Google gtx endpoint (auto-detect, one GET per text). */
async function googleTranslate(texts, to, proxyUrl) {
	const target = bcp47(to);
	const items = new Array(texts.length);
	for (let offset = 0; offset < texts.length; offset += GOOGLE_PARALLEL) {
		const batch = texts.slice(offset, offset + GOOGLE_PARALLEL);
		await Promise.all(batch.map(async (text, index) => {
			const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
			const response = await request(url, { method: "GET" }, proxyUrl);
			const data = await response.json();
			if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("unexpected Google response shape");
			const translated = data[0].map((segment) => (Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "")).join("");
			items[offset + index] = { detected: typeof data[2] === "string" ? data[2] : null, text: translated };
		}));
	}
	return items;
}

/** Provider 3: MyMemory (keyless, heuristic source language, last resort). */
async function myMemoryTranslate(texts, to, proxyUrl) {
	const target = bcp47(to);
	const items = new Array(texts.length);
	for (let offset = 0; offset < texts.length; offset += GOOGLE_PARALLEL) {
		const batch = texts.slice(offset, offset + GOOGLE_PARALLEL);
		await Promise.all(batch.map(async (text, index) => {
			const source = isCJK(text) ? "zh-CN" : "en";
			const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${encodeURIComponent(target)}`;
			const response = await request(url, { method: "GET" }, proxyUrl);
			const data = await response.json();
			const translated = typeof data?.responseData?.translatedText === "string" ? data.responseData.translatedText : "";
			if (translated.length === 0) throw new Error("unexpected MyMemory response shape");
			items[offset + index] = { detected: source, text: translated };
		}));
	}
	return items;
}

/** The chain, first success wins; each failure recorded for the thrown message. */
const PROVIDERS = [
	["bing", bingTranslate],
	["google", googleTranslate],
	["mymemory", myMemoryTranslate]
];

/**
 * Translate a batch of texts to one target language.
 *
 * @param {string[]} texts - 1..50 non-empty strings.
 * @param {string} to - target code such as 'zh-CHS', 'zh-CN', or 'en'.
 * @param {object} options - `{ proxyUrl?: string }`.
 * @returns `{ to, provider, items: Array<{ detected, text }> }` aligned with
 * the input order.
 * @throws {Error} when every provider fails; the message names each attempt.
 */
export async function translateTexts(texts, to, { proxyUrl = "" } = {}) {
	const failures = [];
	for (const [name, provider] of PROVIDERS) {
		try {
			const items = await provider(texts, to, proxyUrl);
			if (items.every((item) => item !== undefined)) return { to, provider: name, items };
			failures.push(`${name}: incomplete result`);
		} catch (error) {
			failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`all translation providers failed — ${failures.join("; ")}`);
}
