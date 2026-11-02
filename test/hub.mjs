/**
 * Self-contained tests for the rss-reader hub (no network). Run with:
 *   node test/hub.mjs
 *
 * The store file is redirected into a temp directory so the tests never
 * touch the real `.rss-reader-data.json`, and `fetchOnStart: false` keeps
 * the hub from fetching anything.
 *
 * @module rss-reader/hub-test
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../lib/hub.js";

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

/**
 * Assert that a function throws.
 * @param {Function} fn - the call under test.
 * @param {string} label - what the assertion checks.
 */
function throws(fn, label) {
	try {
		fn();
		failures.push(label);
		console.error(`FAIL ${label} (did not throw)`);
	} catch {
		passed += 1;
	}
}

/**
 * Assert that an async function rejects.
 * @param {Function} fn - the call under test.
 * @param {string} label - what the assertion checks.
 */
async function rejects(fn, label) {
	try {
		await fn();
		failures.push(label);
		console.error(`FAIL ${label} (did not reject)`);
	} catch {
		passed += 1;
	}
}

/**
 * Fresh fake plugin context collecting tool registrations.
 * @returns {{ ctx: object, definitions: Array }} the context and the tool
 * definitions its tools.register collected.
 */
function fakeContext() {
	const definitions = [];
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: {
			register(definition) {
				definitions.push(definition);
				return () => {};
			}
		},
		effect(fn) {
			fn();
			return () => {};
		}
	};
	return { ctx, definitions };
}

const workDir = await mkdtemp(join(tmpdir(), "rss-reader-hub-test-"));
const dataPath = join(workDir, "store.json");

try {
	// ---------- seeding + tools ----------

	const states = [];
	const first = fakeContext();
	const hub = createHub(first.ctx, {
		sources: [{ name: "Example", url: "https://example.com/feed.xml" }],
		initialFeeds: ["https://example.com/feed.xml", "https://status.deepseek.com/feed.rss", "status.deepseek.com/feed.rss"],
		fetchOnStart: false
	}, { dataPath, onState: (state) => states.push(state) });
	await hub.ready;

	ok(hub.opts.statusToolName === "rss_status", "config: default status tool name");
	ok(hub.opts.autoRefreshMinutes === 10, "config: default auto refresh");
	ok(hub.opts.fetch.maxItemsPerFeed === 50, "config: default item cap");
	ok(first.definitions.length === 4, "hub: four tools registered");
	const byName = new Map(first.definitions.map((definition) => [definition.name, definition]));
	ok(byName.has("rss_status") && byName.has("rss_refresh") && byName.has("rss_read") && byName.has("rss_manage"), "hub: expected tool names");

	let snapshot = hub.snapshot();
	ok(snapshot.version === 1, "seed: snapshot version");
	ok(snapshot.feeds.length === 2, "seed: urls deduped across sources and initialFeeds");
	ok(snapshot.refreshing === false && snapshot.items.length === 0, "seed: quiet empty snapshot");
	ok(states.length >= 1, "seed: onState published");
	const example = snapshot.feeds.find((feed) => feed.url === "https://example.com/feed.xml");
	ok(example !== undefined && example.title === "Example", "seed: sources entry name wins over hostname");
	ok(example.kind === "unknown" && example.error === null, "seed: unfetched feed starts unknown");

	// ---------- items / rename / remove ----------

	ok(hub.itemsFor({ feedId: example.id }).length === 0, "items: empty list for a seeded feed");
	ok(hub.itemsFor({ feedId: "nope123" }).length === 0, "items: unknown feed yields empty");

	hub.renameFeed({ feedId: example.id, title: "Example News" });
	snapshot = hub.snapshot();
	ok(snapshot.feeds.find((feed) => feed.id === example.id).title === "Example News", "rename: title updated");
	throws(() => hub.renameFeed({ feedId: example.id, title: "  " }), "rename: blank title rejected");
	throws(() => hub.renameFeed({ feedId: "nope123", title: "x" }), "rename: unknown id rejected");

	await hub.persisted();
	const persisted = JSON.parse(await readFile(dataPath, "utf8"));
	ok(persisted.feeds.length === 2 && persisted.feeds.find((feed) => feed.id === example.id).title === "Example News", "persist: rename written to the store file");

	const removed = hub.removeFeed({ feedId: example.id });
	ok(removed.ok === true, "remove: subscription dropped");
	ok(hub.snapshot().feeds.length === 1, "remove: snapshot shrinks");
	throws(() => hub.removeFeed({ feedId: example.id }), "remove: unknown id rejected");

	// ---------- tools on the live hub ----------

	const status = byName.get("rss_status");
	const read = byName.get("rss_read");
	const manage = byName.get("rss_manage");
	const report = await status.execute({});
	ok(report.summary.feeds === 1 && report.feeds[0].title === "DeepSeek Status" || report.feeds[0].url === "https://status.deepseek.com/feed.rss", "tools: status report lists the remaining feed");
	ok(String(status.output.render({}, report)[0].text).includes("RSS Reader"), "tools: status renders markdown");
	await rejects(() => status.execute({ feed: "nope" }), "tools: unknown feed name rejected");
	await rejects(() => read.execute({ url: "https://unknown.example/x" }), "tools: unknown item rejected");
	await rejects(() => manage.execute({ action: "bogus" }), "tools: unknown manage action rejected");
	const listed = await manage.execute({ action: "list" });
	ok(listed.changed === false && listed.feeds.length === 1, "tools: manage list action");
	await rejects(() => hub.addFeed({ url: "" }), "add: empty url rejected");
	await rejects(() => hub.refresh("does-not-exist"), "refresh: unmatched selector rejected (no fetch)");
	ok(hub.snapshot().refreshing === false, "refresh: failed refresh leaves store quiet");
	await hub.dispose();

	// ---------- persistence reload ----------

	const second = fakeContext();
	const hub2 = createHub(second.ctx, { initialFeeds: ["https://seed-ignored.example/feed"], fetchOnStart: false }, { dataPath });
	await hub2.ready;
	const reloaded = hub2.snapshot();
	ok(reloaded.feeds.length === 1 && reloaded.feeds[0].url === "https://status.deepseek.com/feed.rss", "reload: store file wins over seeding");
	ok(second.definitions.length === 4, "reload: tools re-registered");
	await hub2.dispose();

	// ---------- entry content: lookup, wire payloads, persistence ----------

	const entryPath = join(workDir, "entry-store.json");
	const fullBody = "First paragraph.\n\nSecond paragraph — the full body is kept.";
	await writeFile(entryPath, `${JSON.stringify({
		version: 1,
		feeds: [
			{ id: "feedfull0000", url: "https://full.example/feed.xml", title: "Full Text Feed", siteLink: "https://full.example/", kind: "rss", headers: {}, lastFetchedAt: 1700000000000, error: null },
			{ id: "feedlegacy00", url: "https://legacy.example/feed.xml", title: "Legacy Feed", siteLink: "https://legacy.example/", kind: "rss", headers: {}, lastFetchedAt: null, error: null }
		],
		itemsByFeed: {
			feedfull0000: [
				{ id: "feedfull0000|post-9", feedId: "feedfull0000", feedTitle: "Full Text Feed", title: "With full text", link: "https://full.example/9", publishedAt: 1700000090000, summary: "Summary of nine", content: fullBody }
			],
			feedlegacy00: [
				{ id: "feedlegacy00|post-1", feedId: "feedlegacy00", feedTitle: "Legacy Feed", title: "Stored before content", link: "https://legacy.example/1", publishedAt: 1600000090000, summary: "Old summary" }
			]
		}
	})}\n`, "utf8");

	const fourth = fakeContext();
	const entryHub = createHub(fourth.ctx, { fetchOnStart: false }, { dataPath: entryPath });
	await entryHub.ready;

	const fullEntry = entryHub.entryItem("feedfull0000|post-9");
	ok(fullEntry !== null && fullEntry.content === fullBody, "entry: hub.entryItem returns the stored full text");
	ok(fullEntry !== null && fullEntry.summary === "Summary of nine" && fullEntry.feedTitle === "Full Text Feed" && fullEntry.link === "https://full.example/9", "entry: entry fields intact alongside content");

	const legacyEntry = entryHub.entryItem("feedlegacy00|post-1");
	ok(legacyEntry !== null && legacyEntry.content === "", "entry: legacy item without content reads as ''");
	ok(entryHub.entryItem("nope|missing") === null && entryHub.entryItem("") === null, "entry: unknown or empty id yields null");

	ok(entryHub.snapshot().items.every((item) => !("content" in item)), "wire: snapshot items carry no content field");
	ok(entryHub.itemsFor({}).every((item) => !("content" in item) && typeof item.summary === "string"), "wire: items() payload stays summary-only");

	await entryHub.dispose();
	const repersisted = JSON.parse(await readFile(entryPath, "utf8"));
	ok(repersisted.itemsByFeed.feedfull0000[0].content === fullBody, "persist: content round-trips through the store file");

	const fifth = fakeContext();
	const reloadHub = createHub(fifth.ctx, { fetchOnStart: false }, { dataPath: entryPath });
	await reloadHub.ready;
	ok(reloadHub.entryItem("feedfull0000|post-9")?.content === fullBody, "reload: content preserved after re-loading the store");
	await reloadHub.dispose();

	// ---------- fetch → mapItems content (global fetch stubbed) ----------

	const STUB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Stub Feed</title>
    <link>https://stub.example/</link>
    <description>stub</description>
    <item>
      <title>Full body</title>
      <link>https://stub.example/1</link>
      <guid>stub-1</guid>
      <pubDate>Wed, 07 Jan 2026 10:00:00 GMT</pubDate>
      <description>short summary</description>
      <content:encoded><![CDATA[<p>Para one.</p><p>Para two.</p>]]></content:encoded>
    </item>
    <item>
      <title>Summary only</title>
      <link>https://stub.example/2</link>
      <guid>stub-2</guid>
      <pubDate>Thu, 08 Jan 2026 10:00:00 GMT</pubDate>
      <description>fallback text</description>
    </item>
    <item>
      <title>Huge body</title>
      <link>https://stub.example/3</link>
      <guid>stub-3</guid>
      <pubDate>Fri, 09 Jan 2026 10:00:00 GMT</pubDate>
      <content:encoded><![CDATA[${"x".repeat(25000)}]]></content:encoded>
    </item>
  </channel>
</rss>`;
	const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
	const savedProxyEnv = new Map(PROXY_ENV.map((name) => [name, process.env[name]]));
	for (const name of PROXY_ENV) delete process.env[name];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: true, text: async () => STUB_XML });
	try {
		const stubPath = join(workDir, "stub-store.json");
		const sixth = fakeContext();
		const stubHub = createHub(sixth.ctx, { fetchOnStart: false, historyPerFeed: 50, initialFeeds: ["https://stub.example/feed.xml"] }, { dataPath: stubPath });
		await stubHub.ready;
		await stubHub.refresh();
		const listed = stubHub.itemsFor({ limit: 10 });
		ok(listed.length === 3, "fetch: stubbed feed yields three items");
		ok(stubHub.snapshot().items.every((item) => !("content" in item)), "wire: fetched snapshot stays summary-only");
		const byTitle = new Map(listed.map((item) => [item.title, item]));
		ok(byTitle.get("Full body") !== undefined && stubHub.entryItem(byTitle.get("Full body").id)?.content === "Para one.\n\nPara two.", "fetch: content taken from content:encoded");
		ok(byTitle.get("Full body").summary === "short summary", "fetch: summary still prefers the description");
		ok(byTitle.get("Summary only") !== undefined && stubHub.entryItem(byTitle.get("Summary only").id)?.content === "fallback text", "fetch: content falls back to summary text");
		const hugeId = byTitle.get("Huge body").id;
		ok(hugeId !== undefined && stubHub.entryItem(hugeId)?.content.length === 20000, "fetch: content clipped at 20000 characters");
		await stubHub.persisted();
		const stubFile = JSON.parse(await readFile(stubPath, "utf8"));
		const stubItems = Object.values(stubFile.itemsByFeed)[0];
		ok(stubItems.length === 3 && typeof stubItems.find((item) => item.id === hugeId)?.content === "string", "persist: fetched content written to the store file");
		const seventh = fakeContext();
		const stubReload = createHub(seventh.ctx, { fetchOnStart: false }, { dataPath: stubPath });
		await stubReload.ready;
		ok(stubReload.entryItem(byTitle.get("Full body").id)?.content === "Para one.\n\nPara two.", "reload: fetched content survives a store reload");
		await stubReload.dispose();
		await stubHub.dispose();
	} finally {
		globalThis.fetch = realFetch;
		for (const [name, value] of savedProxyEnv) {
			if (value !== undefined) process.env[name] = value;
		}
	}

	// ---------- corrupt store quarantine ----------

	const corruptPath = join(workDir, "corrupt.json");
	await writeFile(corruptPath, "{not json", "utf8");
	const third = fakeContext();
	const hub3 = createHub(third.ctx, { fetchOnStart: false }, { dataPath: corruptPath });
	await hub3.ready;
	ok(hub3.snapshot().feeds.length === 0, "quarantine: corrupt store starts empty");
	await hub3.dispose();
} finally {
	await rm(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} assertion(s) failed; ${passed} passed.`);
	process.exit(1);
}
console.log(`hub tests: ${passed} passed, 0 failed.`);
