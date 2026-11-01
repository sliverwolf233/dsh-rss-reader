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
