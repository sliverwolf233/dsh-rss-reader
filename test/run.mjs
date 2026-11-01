/**
 * Self-contained tests for rss-reader parsing. Run with:
 *   node test/run.mjs
 *
 * No test framework: assertions throw on failure and the script prints one
 * line per passing group.
 *
 * @module rss-reader/test
 */
import { buildOpml, parseOpml } from "../lib/opml.js";
import { htmlToReadableText, parseFeed, salvageFeedDocument } from "../lib/parse.js";

const failures = [];
let passed = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the claim under test.
 * @param {string} label - what the assertion checks.
 */
function ok(condition, label) {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(label);
	console.error(`FAIL ${label}`);
}

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example News</title>
    <link>https://example.com/news</link>
    <description>Example feed &amp; updates</description>
    <lastBuildDate>Mon, 02 Jan 2026 08:00:00 GMT</lastBuildDate>
    <item>
      <title>Second &lt;post&gt;</title>
      <link>https://example.com/news/2</link>
      <guid isPermaLink="false">post-2</guid>
      <pubDate>Tue, 03 Jan 2026 09:30:00 GMT</pubDate>
      <dc:creator>Ann</dc:creator>
      <category>tech</category>
      <category>tools</category>
      <description><![CDATA[Short <b>summary</b> here.]]></description>
      <content:encoded><![CDATA[<p>First para.</p><p>Second <a href="https://example.com/x">link</a>.</p>]]></content:encoded>
    </item>
    <item>
      <title>First post</title>
      <link>https://example.com/news/1</link>
      <guid>post-1</guid>
      <pubDate>Mon, 02 Jan 2026 10:00:00 GMT</pubDate>
      <description>Plain summary.</description>
    </item>
    <item>
      <title>No date item</title>
      <link>https://example.com/news/3</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atom Example</title>
  <subtitle>example atom feed</subtitle>
  <link rel="alternate" type="text/html" href="https://atom.example/"/>
  <link rel="self" href="https://atom.example/feed"/>
  <updated>2026-01-04T12:00:00Z</updated>
  <entry>
    <title>Entry A</title>
    <id>urn:uuid:aaa</id>
    <link rel="alternate" href="https://atom.example/a"/>
    <published>2026-01-04T08:00:00Z</published>
    <updated>2026-01-04T09:00:00Z</updated>
    <author><name>Bob</name></author>
    <category term="alpha"/>
    <summary>summary text</summary>
    <content type="html">&lt;p&gt;hello &lt;em&gt;world&lt;/em&gt;&lt;/p&gt;</content>
  </entry>
  <entry>
    <title type="html">Entry &amp; B</title>
    <id>urn:uuid:bbb</id>
    <link href="https://atom.example/b"/>
    <updated>2026-01-03T09:00:00Z</updated>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://rdf.example/">
    <title>RDF Example</title>
    <link>https://rdf.example/</link>
    <description>rdf feed</description>
    <dc:date>2026-01-05T00:00:00Z</dc:date>
  </channel>
  <item rdf:about="https://rdf.example/1">
    <title>RDF item</title>
    <link>https://rdf.example/1</link>
    <description>rdf item text</description>
    <dc:date>2026-01-05T01:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
	version: "https://jsonfeed.org/version/1.1",
	title: "JSON Example",
	description: "json feed",
	home_page_url: "https://json.example/",
	feed_url: "https://json.example/feed.json",
	items: [
		{ id: "1", url: "https://json.example/1", title: "J1", content_html: "<p>hello</p>", date_published: "2026-01-06T00:00:00Z", authors: [{ name: "Cy" }], tags: ["a"] },
		{ id: "2", url: "https://json.example/2", title: "J2", content_text: "plain text" }
	]
});

const rss = parseFeed(RSS2, "https://example.com/news/rss.xml");
ok(rss.format === "rss2", "rss2: format detected");
ok(rss.title === "Example News", "rss2: channel title");
ok(rss.link === "https://example.com/news", "rss2: channel link");
ok(rss.updated === "2026-01-02T08:00:00.000Z", "rss2: lastBuildDate parsed");
ok(rss.items.length === 3, "rss2: three items");
ok(rss.items[0].id === "post-2", "rss2: newest item first");
ok(rss.items[0].published === "2026-01-03T09:30:00.000Z", "rss2: pubDate parsed");
ok(rss.items[0].author === "Ann", "rss2: dc:creator author");
ok(rss.items[0].categories.join(",") === "tech,tools", "rss2: categories");
ok(rss.items[0].html.includes("<b>summary</b>") === false, "rss2: description CDATA text kept plain");
ok(rss.items[0].summary === "Short summary here.", "rss2: summary html stripped");
ok(rss.items[0].text.includes("First para."), "rss2: content:encoded converted");
ok(rss.items[0].text.includes("link (https://example.com/x)"), "rss2: link target kept");
ok(rss.items[1].id === "post-1", "rss2: second item order");
ok(rss.items[2].published === null, "rss2: undated item has null date");
ok(rss.items[2].id === "https://example.com/news/3", "rss2: undated item id falls back to link");

const atom = parseFeed(ATOM, "https://atom.example/feed");
ok(atom.format === "atom", "atom: format detected");
ok(atom.title === "Atom Example", "atom: title");
ok(atom.link === "https://atom.example/", "atom: alternate link picked over self");
ok(atom.updated === "2026-01-04T12:00:00.000Z", "atom: feed updated");
ok(atom.items.length === 2, "atom: two entries");
ok(atom.items[0].id === "urn:uuid:aaa", "atom: entry id");
ok(atom.items[0].url === "https://atom.example/a", "atom: entry alternate link");
ok(atom.items[0].author === "Bob", "atom: author name");
ok(atom.items[0].categories[0] === "alpha", "atom: category term");
ok(atom.items[0].text.includes("hello world"), "atom: html content converted");
ok(atom.items[1].url === "https://atom.example/b", "atom: link without rel resolves");
ok(atom.items[1].published === null && atom.items[1].updated !== null, "atom: updated-only entry");

const rdf = parseFeed(RDF, "https://rdf.example/feed.xml");
ok(rdf.format === "rdf", "rdf: format detected");
ok(rdf.title === "RDF Example", "rdf: channel title");
ok(rdf.items.length === 1, "rdf: one item");
ok(rdf.items[0].published === "2026-01-05T01:00:00.000Z", "rdf: dc:date parsed");
ok(rdf.items[0].text === "rdf item text", "rdf: description text");

const json = parseFeed(JSONFEED, "https://json.example/feed.json");
ok(json.format === "jsonfeed", "jsonfeed: format detected");
ok(json.items.length === 2, "jsonfeed: two items");
ok(json.items[0].text.includes("hello"), "jsonfeed: content_html converted");
ok(json.items[1].text === "plain text", "jsonfeed: content_text kept");
ok(json.items[0].author === "Cy", "jsonfeed: author");

let threw = false;
try {
	parseFeed("<html><body>not a feed</body></html>", "https://example.com/");
} catch {
	threw = true;
}
ok(threw, "unsupported: throws on non-feed XML");
threw = false;
try {
	parseFeed("{\"version\": \"1.0\"}", "https://example.com/");
} catch {
	threw = true;
}
ok(threw, "unsupported: throws on non-jsonfeed JSON");

ok(htmlToReadableText("<p>a</p><script>alert(1)</script><p>b</p>") === "a\n\nb", "htmlToText: script removed");
ok(htmlToReadableText("a &amp;amp; b") === "a & b", "htmlToText: double-encoded entity");
ok(htmlToReadableText("") === "", "htmlToText: empty input");

const TRUNCATED_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title><link>https://big.example/</link><description>big</description>
<item><title>One</title><link>https://big.example/1</link><guid>1</guid><pubDate>Mon, 05 Jan 2026 10:00:00 GMT</pubDate></item>
<item><title>Two</title><link>https://big.example/2</link><guid>2</guid><pubDate>Tue, 06 Jan 2026 10:00:00 GMT</pubDate></item>
<item><title>Three</title><description>cut mid-`;
const salvagedRss = salvageFeedDocument(TRUNCATED_RSS);
ok(salvagedRss !== null, "salvage: rss prefix found");
ok(salvagedRss.endsWith("</item></channel></rss>"), "salvage: rss root closed");
const salvagedFeed = parseFeed(salvagedRss, "https://big.example/rss.xml");
ok(salvagedFeed.format === "rss2" && salvagedFeed.items.length === 2 && salvagedFeed.items[0].id === "2", "salvage: rss keeps the complete items, newest first");

const TRUNCATED_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Big Atom</title>
<entry><title>A</title><id>a</id><updated>2026-01-05T10:00:00Z</updated></entry>
<entry><title>B</title><id>b</id><updated>2026-01-06T10:00:00Z</updated></entry>
<entry><title>C</title><content>cut mid-`;
const salvagedAtom = salvageFeedDocument(TRUNCATED_ATOM);
ok(salvagedAtom !== null && salvagedAtom.endsWith("</entry></feed>"), "salvage: atom root closed");
ok(parseFeed(salvagedAtom, "https://big.example/atom.xml").items.length === 2, "salvage: atom keeps the complete entries");
ok(salvageFeedDocument("<html><body>no items at all</body>") === null, "salvage: null without an item boundary");
ok(salvageFeedDocument("") === null, "salvage: null on empty input");

// ---------- OPML ----------

const opml = buildOpml([
	{ title: "A & B <测试>", url: "https://a.example/rss.xml", siteLink: "https://a.example/" },
	{ title: "Plain", url: "https://b.example/feed" }
], { title: "测试清单" });
ok(opml.startsWith("<?xml") && opml.includes('<opml version="2.0">') && opml.includes("<body>") && opml.trimEnd().endsWith("</opml>"), "opml: document shape");
const reparsed = parseOpml(opml);
ok(reparsed.length === 2 && reparsed[0].url === "https://a.example/rss.xml" && reparsed[0].title === "A & B <测试>", "opml: round-trip keeps url and decoded title");
ok(reparsed[1].title === "Plain", "opml: second outline order kept");

const nested = `<?xml version="1.0"?><opml version="2.0"><head><title>t</title></head><body>
<outline text="分类：新闻">
  <outline type="rss" text="BBC" xmlUrl="http://feeds.bbci.co.uk/news/world/rss.xml"/>
  <outline text="子文件夹">
    <outline type="rss" title='NHK &amp; 新闻' xmlUrl="https://www3.nhk.or.jp/rss/news/cat0.xml"/>
  </outline>
</outline>
<outline text="仅文件夹无源"/>
<outline type="rss" text="javascript:void(0)" xmlUrl="javascript:alert(1)"/>
</body></opml>`;
const found = parseOpml(nested);
ok(found.length === 2, "opml: nested outlines found, folders and non-http urls skipped");
ok(found[0].url === "http://feeds.bbci.co.uk/news/world/rss.xml", "opml: first candidate url");
ok(found[1].title === "NHK & 新闻" && found[1].url === "https://www3.nhk.or.jp/rss/news/cat0.xml", "opml: entity in title decoded, depth-3 outline found");

let opmlThrew = false;
try {
	parseOpml("<opml><body><outline text='no urls here'/></body></opml>");
} catch {
	opmlThrew = true;
}
ok(opmlThrew, "opml: throws when no feed outlines exist");

if (failures.length > 0) {
	console.error(`\n${failures.length} assertion(s) failed; ${passed} passed.`);
	process.exit(1);
}
console.log(`parse tests: ${passed} passed, 0 failed.`);
