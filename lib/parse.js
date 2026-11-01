/**
 * Feed parsing for rss-reader: a zero-dependency scanner for RSS 2.0,
 * Atom 1.0, RDF/RSS 1.x, and JSON Feed 1.x documents.
 *
 * The scanner reads the small XML subset that feeds use. It does not build
 * a full document model and it does not fetch anything. Every function is
 * pure so tests can drive it with inline fixtures.
 *
 * @module rss-reader/parse
 */

/** Predefined XML entities and the numeric forms decoded in text nodes. */
const NAMED_ENTITIES = new Map([
	["lt", "<"],
	["gt", ">"],
	["amp", "&"],
	["quot", "\""],
	["apos", "'"]
]);

/** Upper bound for one decoded text run; guards against hostile inputs. */
const MAX_TEXT_LENGTH = 2_000_000;

/**
 * Decode XML character entities in a text run.
 * Numeric forms (`&#123;`, `&#x1A;`) and the five predefined named forms
 * are decoded. Unknown named entities are kept as written.
 * @param {string} text - raw text with entity references.
 * @returns the decoded text.
 */
function decodeEntities(text) {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
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
		const named = NAMED_ENTITIES.get(body);
		return named === undefined ? whole : named;
	});
}

/**
 * One XML element: local name, attributes, child elements, and the joined
 * text that sits directly inside it.
 */
class XmlElement {
	/**
	 * @param {string} name - element name as written (prefix kept).
	 * @param {Record<string, string>} attrs - attributes keyed by local name.
	 */
	constructor(name, attrs) {
		this.name = name;
		this.attrs = attrs;
		/** @type {XmlElement[]} */
		this.children = [];
		/** @type {string[]} */
		this.textParts = [];
	}

	/** Element local name: the part after a namespace prefix, if any. */
	get localName() {
		const at = this.name.indexOf(":");
		return at === -1 ? this.name : this.name.slice(at + 1);
	}

	/** Joined and entity-decoded direct text of this element. */
	get text() {
		const joined = this.textParts.join("");
		return joined.length > MAX_TEXT_LENGTH ? joined.slice(0, MAX_TEXT_LENGTH) : joined;
	}

	/** Attribute value by local name, entity-decoded, or undefined. */
	attr(name) {
		const value = this.attrs[name];
		return value === undefined ? undefined : decodeEntities(value);
	}
}

/**
 * Scan one XML document and return its root element.
 * Comments, processing instructions, and doctype declarations are skipped.
 * CDATA sections are kept as raw text. Malformed markup throws.
 * @param {string} text - the full XML source.
 * @returns {XmlElement} the root element.
 */
function scanXml(text) {
	const length = text.length;
	let pos = 0;
	/** @type {XmlElement[]} */
	const stack = [];
	let root = null;
	const appendText = (raw, cdata) => {
		if (raw.length === 0 || stack.length === 0) return;
		stack[stack.length - 1].textParts.push(cdata ? raw : decodeEntities(raw));
	};
	while (pos < length) {
		const open = text.indexOf("<", pos);
		if (open === -1) {
			appendText(text.slice(pos), false);
			break;
		}
		if (open > pos) appendText(text.slice(pos, open), false);
		if (text.startsWith("<!--", open)) {
			const end = text.indexOf("-->", open + 4);
			if (end === -1) throw new Error("unterminated XML comment");
			pos = end + 3;
			continue;
		}
		if (text.startsWith("<![CDATA[", open)) {
			const end = text.indexOf("]]>", open + 9);
			if (end === -1) throw new Error("unterminated CDATA section");
			appendText(text.slice(open + 9, end), true);
			pos = end + 3;
			continue;
		}
		if (text.startsWith("<?", open)) {
			const end = text.indexOf("?>", open + 2);
			if (end === -1) throw new Error("unterminated processing instruction");
			pos = end + 2;
			continue;
		}
		if (text.startsWith("<!", open)) {
			let end = text.indexOf(">", open + 2);
			if (end !== -1 && text.slice(open, end).includes("[")) {
				let depth = 0;
				for (let scan = open; scan < length && scan < end + 1; scan += 1) {
					const ch = text[scan];
					if (ch === "[") depth += 1;
					else if (ch === "]") depth -= 1;
					else if (ch === ">" && depth <= 0) {
						end = scan;
						break;
					}
				}
			}
			if (end === -1) throw new Error("unterminated declaration");
			pos = end + 1;
			continue;
		}
		const close = text.indexOf(">", open);
		if (close === -1) throw new Error("unterminated tag");
		let inner = text.slice(open + 1, close);
		if (inner.endsWith("/")) {
			inner = inner.slice(0, -1).trimEnd();
			const selfClosing = true;
			emitElement(inner, selfClosing);
			pos = close + 1;
			continue;
		}
		if (inner.startsWith("/")) {
			const name = inner.slice(1).trim();
			const current = stack.pop();
			if (current === undefined || current.name !== name) throw new Error(`unexpected closing tag </${name}>`);
			pos = close + 1;
			continue;
		}
		emitElement(inner, false);
		pos = close + 1;
	}
	if (stack.length > 0) throw new Error(`unclosed element <${stack[stack.length - 1].name}>`);
	if (root === null) throw new Error("no XML element found");
	return root;

	/** Parse `inner` as a start tag and push or attach the element. */
	function emitElement(inner, selfClosing) {
		const space = inner.search(/[\s\/]/);
		const name = space === -1 ? inner : inner.slice(0, space);
		if (name.length === 0) throw new Error("empty tag name");
		const attrs = {};
		const attrText = space === -1 ? "" : inner.slice(space);
		const attrPattern = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
		for (const match of attrText.matchAll(attrPattern)) {
			const attrName = match[1];
			const at = attrName.indexOf(":");
			const local = at === -1 ? attrName : attrName.slice(at + 1);
			if (local === "xmlns") continue;
			attrs[local] = match[3] !== undefined ? match[3] : match[4];
		}
		const element = new XmlElement(name, attrs);
		if (stack.length === 0) {
			if (root !== null) throw new Error("multiple root elements");
			root = element;
		} else stack[stack.length - 1].children.push(element);
		if (!selfClosing) stack.push(element);
	}
}

/**
 * First child element whose local name equals `name`, or undefined.
 * @param {XmlElement} element - parent to search.
 * @param {string} name - local name to match.
 */
function child(element, name) {
	return element.children.find((candidate) => candidate.localName === name);
}

/**
 * Every child element whose local name equals `name`.
 * @param {XmlElement} element - parent to search.
 * @param {string} name - local name to match.
 * @returns {XmlElement[]}
 */
function children(element, name) {
	return element.children.filter((candidate) => candidate.localName === name);
}

/**
 * Decoded text of the first child with the local name `name`, or undefined.
 * @param {XmlElement} element - parent to search.
 * @param {string} name - local name to match.
 */
function childText(element, name) {
	const found = child(element, name);
	return found === undefined ? undefined : found.text.trim();
}

/**
 * Parse one date string from a feed into an ISO timestamp.
 * RFC 822 dates (RSS) and ISO 8601 dates (Atom, RDF, JSON Feed) are
 * accepted. Unparseable values return null.
 * @param {string|undefined} value - raw date text.
 * @returns {string|null} ISO timestamp or null.
 */
function parseDate(value) {
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value.trim());
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * Absolute URL for a link found in a feed, resolved against the feed URL
 * when the link is relative. Invalid values return null.
 * @param {string|undefined} value - raw link text.
 * @param {string} baseUrl - URL of the feed the link came from.
 * @returns {string|null}
 */
function resolveUrl(value, baseUrl) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		const resolved = new URL(value.trim(), baseUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
		return resolved.href;
	} catch {
		return null;
	}
}

/**
 * Convert feed entry HTML into readable plain text.
 * Script and style blocks are removed. Links keep their target in
 * parentheses. Images become a bracketed label. Structure such as
 * paragraphs, list items, and headings is kept as line breaks.
 * @param {string} html - raw HTML from a feed entry.
 * @returns readable text; empty string for empty input.
 */
export function htmlToReadableText(html) {
	if (typeof html !== "string" || html.length === 0) return "";
	let text = html;
	text = text.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<img\b[^>]*?\balt="([^"]*)"[^>]*>/gi, (_whole, alt) => `[image: ${alt}]`);
	text = text.replace(/<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi, (_whole, src) => `[image: ${src}]`);
	text = text.replace(/<img\b[^>]*>/gi, "[image]");
	text = text.replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_whole, href, label) => {
		const labelText = label.replace(/<[^>]+>/g, " ").trim();
		return labelText.length === 0 ? `(${href})` : `${labelText} (${href})`;
	});
	text = text.replace(/<\/(p|div|section|article|header|footer|blockquote|pre|table|ul|ol|dl|h[1-6])\s*>/gi, "\n\n");
	text = text.replace(/<\/tr\s*>/gi, "\n");
	text = text.replace(/<br\s*\/?\s*>/gi, "\n");
	text = text.replace(/<li\b[^>]*>/gi, "\n• ");
	text = text.replace(/<(h[1-6])\b[^>]*>/gi, (_whole, tag) => `\n${"#".repeat(Number(tag[1]))} `);
	text = text.replace(/<\/(li|dd|dt|th|td)\s*>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");
	text = decodeEntities(decodeEntities(text));
	text = text.replace(/[ \t\u00a0]+/g, " ");
	text = text.split("\n").map((line) => line.trim()).join("\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/** Normalize one JSON Feed item. */
function jsonItem(raw, index) {
	const url = resolveUrl(raw.url ?? raw.external_url, "");
	const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : (url ?? `item-${index}`);
	const contentHtml = typeof raw.content_html === "string" ? raw.content_html : null;
	const contentText = typeof raw.content_text === "string" ? raw.content_text : null;
	const author = Array.isArray(raw.authors) && typeof raw.authors[0]?.name === "string" ? raw.authors[0].name : (typeof raw.author === "object" && raw.author !== null && typeof raw.author.name === "string" ? raw.author.name : null);
	return {
		id,
		url,
		title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : (url ?? id),
		summary: typeof raw.summary === "string" ? htmlToReadableText(raw.summary) : null,
		text: contentHtml !== null ? htmlToReadableText(contentHtml) : contentText,
		html: contentHtml,
		author,
		published: parseDate(raw.date_published),
		updated: parseDate(raw.date_modified),
		categories: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === "string").slice(0, 12) : [],
		enclosure: typeof raw.image === "string" ? { url: raw.image, type: null, length: null } : null
	};
}

/** Read the best link of an Atom element: alternate, or the first link. */
function atomLink(element, baseUrl) {
	let first = null;
	for (const link of children(element, "link")) {
		const rel = link.attr("rel") ?? "alternate";
		const href = resolveUrl(link.attr("href"), baseUrl);
		if (href === null) continue;
		if (rel === "alternate") return href;
		if (first === null) first = href;
	}
	return first;
}

/** Normalize one RSS 2.0 item. */
function rssItem(element, baseUrl) {
	const link = resolveUrl(childText(element, "link"), baseUrl);
	const guid = childText(element, "guid");
	const contentEncoded = childText(element, "encoded") ?? null;
	const description = childText(element, "description") ?? null;
	const author = childText(element, "author") ?? childText(element, "creator") ?? null;
	const enclosureElement = child(element, "enclosure");
	const enclosure = enclosureElement === undefined ? null : {
		url: resolveUrl(enclosureElement.attr("url"), baseUrl),
		type: enclosureElement.attr("type") ?? null,
		length: enclosureElement.attr("length") ?? null
	};
	return {
		id: guid ?? link ?? null,
		url: link,
		title: childText(element, "title") ?? link ?? guid ?? null,
		summary: description === null ? null : htmlToReadableText(description),
		text: contentEncoded === null ? (description === null ? null : htmlToReadableText(description)) : htmlToReadableText(contentEncoded),
		html: contentEncoded ?? description,
		author,
		published: parseDate(childText(element, "pubDate") ?? childText(element, "date")),
		updated: null,
		categories: children(element, "category").map((node) => node.text.trim()).filter((value) => value.length > 0).slice(0, 12),
		enclosure
	};
}

/** Normalize one Atom entry. */
function atomItem(element, baseUrl) {
	const link = atomLink(element, baseUrl);
	const id = childText(element, "id");
	const content = child(element, "content");
	const summary = child(element, "summary");
	const authorElement = child(element, "author");
	const contentText = content === undefined ? null : content.text;
	const contentHtml = content !== undefined && (content.attr("type") === "html" || content.attr("type") === "xhtml" || /[<&]/.test(contentText ?? "")) ? contentText : null;
	return {
		id: id ?? link ?? null,
		url: link,
		title: childText(element, "title") ?? link ?? id ?? null,
		summary: summary === undefined ? null : htmlToReadableText(summary.text),
		text: contentHtml !== null ? htmlToReadableText(contentHtml) : contentText,
		html: contentHtml ?? (summary === undefined ? null : summary.text),
		author: authorElement === undefined ? null : (childText(authorElement, "name") ?? childText(authorElement, "email") ?? null),
		published: parseDate(childText(element, "published") ?? childText(element, "issued")),
		updated: parseDate(childText(element, "updated") ?? childText(element, "modified")),
		categories: element.children.filter((node) => node.localName === "category").map((node) => node.attr("term") ?? node.text.trim()).filter((value) => value !== undefined && value.length > 0).slice(0, 12),
		enclosure: null
	};
}

/**
 * Parse one feed document into a normalized shape.
 *
 * Supported formats: RSS 2.0 (`<rss>`), Atom 1.0 (`<feed>`), RDF/RSS 1.x
 * (`<rdf:RDF>`), and JSON Feed 1.x. The parser detects the format from the
 * document itself. Items are sorted newest first. Items without a usable
 * date keep their document order after dated items.
 *
 * @param {string} text - the full feed document.
 * @param {string} sourceUrl - URL the document came from; resolves links.
 * @returns {{format: string, title: string|null, description: string|null, link: string|null, updated: string|null, items: Array<object>}}
 * @throws {Error} when the document matches no supported format.
 */
export function parseFeed(text, sourceUrl) {
	const base = typeof sourceUrl === "string" && sourceUrl.length > 0 ? sourceUrl : "https://example.invalid/";
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error("feed looks like JSON but does not parse");
		}
		if (typeof parsed !== "object" || parsed === null || typeof parsed.version !== "string" || !parsed.version.includes("jsonfeed")) {
			throw new Error("JSON document is not a JSON Feed (missing jsonfeed version)");
		}
		const homeLink = resolveUrl(parsed.home_page_url, base) ?? resolveUrl(parsed.feed_url, base);
		return {
			format: "jsonfeed",
			title: typeof parsed.title === "string" ? parsed.title : null,
			description: typeof parsed.description === "string" ? parsed.description : null,
			link: homeLink,
			updated: null,
			items: normalizeItems(Array.isArray(parsed.items) ? parsed.items.map(jsonItem) : [], parsed.title ?? null)
		};
	}
	const root = scanXml(trimmed);
	const rootName = root.localName;
	if (rootName === "rss") {
		const channel = child(root, "channel") ?? root;
		return {
			format: "rss2",
			title: childText(channel, "title") ?? null,
			description: childText(channel, "description") ?? null,
			link: resolveUrl(childText(channel, "link"), base),
			updated: parseDate(childText(channel, "lastBuildDate") ?? childText(channel, "date")),
			items: normalizeItems(children(channel, "item").map((node) => rssItem(node, base)), childText(channel, "title") ?? null)
		};
	}
	if (rootName === "feed") {
		return {
			format: "atom",
			title: childText(root, "title") ?? null,
			description: childText(root, "subtitle") ?? null,
			link: atomLink(root, base),
			updated: parseDate(childText(root, "updated")),
			items: normalizeItems(children(root, "entry").map((node) => atomItem(node, base)), childText(root, "title") ?? null)
		};
	}
	if (rootName === "rdf" || rootName === "RDF") {
		const channel = child(root, "channel");
		return {
			format: "rdf",
			title: channel === undefined ? null : (childText(channel, "title") ?? null),
			description: channel === undefined ? null : (childText(channel, "description") ?? null),
			link: channel === undefined ? null : resolveUrl(childText(channel, "link"), base),
			updated: channel === undefined ? null : parseDate(childText(channel, "date")),
			items: normalizeItems(children(root, "item").map((node) => rssItem(node, base)), channel === undefined ? null : (childText(channel, "title") ?? null))
		};
	}
	throw new Error(`unsupported feed format: root element <${root.name}> is not rss, feed, or rdf`);
}

/**
 * Sort items newest first, drop items without any identity, and cap length.
 * Items without a date sort after dated items and keep document order.
 * @param {Array<object>} items - normalized items.
 * @param {string|null} feedTitle - used for untitled items.
 * @returns {Array<object>}
 */
function normalizeItems(items, feedTitle) {
	const usable = items.filter((item) => item.id !== null || item.url !== null);
	usable.forEach((item, index) => {
		if (item.id === null) item.id = item.url;
		if (item.title === null || item.title.length === 0) item.title = item.url ?? `${feedTitle ?? "feed"} item ${index + 1}`;
	});
	const dated = usable.filter((item) => item.published !== null || item.updated !== null);
	const undated = usable.filter((item) => item.published === null && item.updated === null);
	dated.sort((left, right) => Date.parse(right.published ?? right.updated) - Date.parse(left.published ?? left.updated));
	return [...dated, ...undated];
}

/**
 * Salvage a parseable document prefix from a byte-capped feed download.
 * Large feeds (multi-megabyte changelogs) arrive truncated mid-element; the
 * scanner then reports an unclosed element. Cutting at the last complete
 * `</item>` or `</entry>` and closing the root element yields a valid
 * document whose retained items are enough — readers keep only the newest
 * slice anyway.
 * @param {string} text - truncated feed document.
 * @returns the repaired document, or null when no item boundary exists.
 */
export function salvageFeedDocument(text) {
	if (typeof text !== "string" || text.length === 0) return null;
	const lastItem = text.lastIndexOf("</item>");
	const lastEntry = text.lastIndexOf("</entry>");
	const closeTag = lastItem > lastEntry ? "</item>" : "</entry>";
	const anchor = Math.max(lastItem, lastEntry);
	if (anchor < 0) return null;
	let head = text.slice(0, anchor + closeTag.length);
	if (/<rdf:RDF[\s>]/i.test(head)) head += "</rdf:RDF>";
	else if (/<feed[\s>]/i.test(head)) head += "</feed>";
	else if (/<rss[\s>]/i.test(head) || /<channel[\s>]/i.test(head)) head += "</channel></rss>";
	else return null;
	return head;
}
