/**
 * OPML 2.0 import/export for the reader.
 *
 * Export renders the subscription list as a flat OPML document; import scans
 * an OPML document for `<outline>` elements at any depth (folder outlines
 * carry no feed url and are skipped) and returns candidate subscriptions.
 *
 * Both directions are plain string functions with no I/O, so tests drive
 * them with inline fixtures.
 *
 * @module rss-reader/opml
 */

/** Predefined XML entities decoded inside attribute values. */
const NAMED = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", "\""], ["apos", "'"]]);

/** Decode XML entities in one attribute value (numeric + the five named). */
function decode(value) {
	if (!value.includes("&")) return value;
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
		if (body.startsWith("#")) {
			const hex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
			if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		return NAMED.get(body) ?? whole;
	});
}

/** Escape one attribute value for OPML output. */
function escape(value) {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** RFC 822 date for OPML headers. */
function rfc822(date) {
	return date.toUTCString();
}

/**
 * Render subscriptions as an OPML 2.0 document.
 * @param {Array<{title: string, url: string, siteLink?: string}>} feeds -
 * the subscription list.
 * @param {object} [options] - `{ title?: string }` for the document title.
 * @returns the OPML XML text.
 */
export function buildOpml(feeds, options = {}) {
	const title = escape(options.title ?? "RSS Reader 订阅");
	const lines = [
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
		`<opml version="2.0">`,
		"  <head>",
		`    <title>${title}</title>`,
		`    <dateCreated>${rfc822(new Date())}</dateCreated>`,
		"  </head>",
		"  <body>"
	];
	for (const feed of feeds) {
		if (typeof feed?.url !== "string" || feed.url.length === 0) continue;
		const text = escape(feed.title ?? feed.url);
		const html = typeof feed.siteLink === "string" && feed.siteLink.length > 0 ? ` htmlUrl="${escape(feed.siteLink)}"` : "";
		lines.push(`    <outline type="rss" text="${text}" title="${text}" xmlUrl="${escape(feed.url)}"${html} />`);
	}
	lines.push("  </body>");
	lines.push("</opml>");
	return `${lines.join("\n")}\n`;
}

/**
 * Scan an OPML document for feed outlines at any nesting depth. Outlines
 * without a feed url (folders, category nodes) are skipped. Unknown shapes
 * throw with a clear message rather than returning a wrong list.
 * @param {string} xml - the OPML document text.
 * @returns {Array<{title: string, url: string}>} candidates, document order.
 */
export function parseOpml(xml) {
	if (typeof xml !== "string" || xml.trim().length === 0) throw new Error("OPML document is empty");
	// quote-aware outline open-tag scan: attributes may contain '>' inside quotes
	const tag = /<outline\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
	const attr = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	const found = [];
	let match;
	while ((match = tag.exec(xml)) !== null) {
		const attrs = {};
		let pair;
		while ((pair = attr.exec(match[1])) !== null) {
			attrs[pair[1].toLowerCase()] = decode(pair[2] ?? pair[3] ?? "");
		}
		attr.lastIndex = 0;
		const url = attrs.xmlurl;
		if (typeof url !== "string" || url.length === 0) continue;
		if (!/^https?:\/\//i.test(url)) continue;
		const title = (attrs.title ?? attrs.text ?? "").trim();
		found.push({ title, url });
	}
	if (found.length === 0) {
		throw new Error("no feed outlines with xmlUrl found in the OPML document");
	}
	return found;
}
