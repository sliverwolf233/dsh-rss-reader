/**
 * Prints the registered tool descriptions so the STE linter can check the
 * text users and models actually read. Run:
 *   node test/descriptions.mjs | <ste-lint.py path> -
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../lib/hub.js";

const workDir = await mkdtemp(join(tmpdir(), "rss-reader-desc-"));
try {
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
	const hub = createHub(ctx, { sources: [], fetchOnStart: false }, { dataPath: join(workDir, "store.json") });
	await hub.ready;
	for (const definition of definitions) process.stdout.write(`${definition.name}: ${definition.description}\n`);
	await hub.dispose();
} finally {
	await rm(workDir, { recursive: true, force: true });
}
