/**
 * Self-contained tests for the modal Markdown pure functions. Run with:
 *   node test/markdown.mjs
 *
 * Method: client.js is a browser-side Cordis module (require('react')), so it
 * cannot be imported here. The two zero-closure pure functions —
 * `looksLikeMarkdown` and `safeUrl` — are kept inside explicit
 * `[md-pure-start] … [md-pure-end]` markers in client.js and extracted here
 * by slicing that exact region and evaluating it with `new Function`. The
 * functions are therefore tested as-shipped, never a copied duplicate.
 *
 * @module rss-reader/markdown-test
 */
import { readFileSync } from "node:fs";

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

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = source.indexOf("// [md-pure-start]");
const end = source.indexOf("// [md-pure-end]");
if (start === -1 || end === -1) throw new Error("md-pure markers not found in client.js");
const { looksLikeMarkdown, safeUrl } = new Function(`${source.slice(start, end)}\nreturn { looksLikeMarkdown, safeUrl };`)();

// ---------- looksLikeMarkdown: positives (≥2 strong feature classes) ----------

ok(looksLikeMarkdown("# Release notes\n\n- new parser\n- faster fetch\n\nBody prose follows the list.") === true, "md+: heading + bullet list");
ok(looksLikeMarkdown("```\nconst x = 1;\n```\n\nSee [docs](https://a.example/d) and [spec](https://b.example/s).") === true, "md+: code fence + two inline links");
ok(looksLikeMarkdown("> quoted line here\n\n1. first step\n2. second step\n\nplain paragraph") === true, "md+: quote + ordered list");
ok(looksLikeMarkdown("Intro line.\n\n---\n\nUse **bold** here, **there** and `code` plus `more`.") === true, "md+: hr + emphasis counts (3 hits)");

// ---------- looksLikeMarkdown: negatives (conservative: prefer plain text) ----------

ok(looksLikeMarkdown("This is a plain paragraph with no markup at all.\nThe second line continues the same thought.") === false, "md-: plain prose stays plain");
ok(looksLikeMarkdown("- a lone bullet\nwith a continuation line and more words") === false, "md-: single list feature alone");
ok(looksLikeMarkdown("A **bold** word and one [link](https://a.example) inside prose.") === false, "md-: one link + one bold below thresholds");
ok(looksLikeMarkdown("short text") === false, "md-: too short to judge");

// ---------- safeUrl: protocol whitelist (links: http/https; else null) ----------

ok(safeUrl("https://example.com/a?b=c") === "https://example.com/a?b=c", "url: https passes through normalized");
ok(safeUrl("  https://example.com/x  ") === "https://example.com/x", "url: surrounding whitespace trimmed");
ok(safeUrl("http://example.com/page") === "http://example.com/page", "url: http allowed for links");
ok(safeUrl("javascript:alert(1)") === null, "url: javascript: rejected");
ok(safeUrl("data:text/html;base64,PHNjcmlwdD4=") === null, "url: data: rejected");
ok(safeUrl("ftp://example.com/file") === null, "url: ftp rejected");
ok(safeUrl("/relative/path") === null, "url: relative path rejected");
ok(safeUrl("example.com/no-scheme") === null, "url: schemeless host rejected");
ok(safeUrl("") === null && safeUrl(null) === null && safeUrl(123) === null, "url: non-string inputs rejected");

if (failures.length > 0) {
	console.error(`\n${failures.length} assertion(s) failed; ${passed} passed.`);
	process.exit(1);
}
console.log(`markdown tests: ${passed} passed, 0 failed.`);
