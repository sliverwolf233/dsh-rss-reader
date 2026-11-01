/**
 * Manual post-install check: load the installed @local/rss-reader entry
 * through the profile's module table and instantiate its Config with a
 * sample row. Run after `plugin_manager install_bundle`:
 *   node test/load-check.mjs
 */
import { createRequire } from "node:module";

const require = createRequire("C:/Users/vr2.bi2xm/.dsh/profiles/desktop/");
const pkgJsonPath = require.resolve("@local/rss-reader/package.json");
console.log("resolved package.json:", pkgJsonPath);
const entry = require(pkgJsonPath).exports["."].replace("./", "");
const mod = await import("file:///" + pkgJsonPath.replace(/package\.json$/, entry).replace(/\\/g, "/"));
console.log("module loaded; default export:", typeof mod.default?.name, mod.default?.name);
const config = {
	initialFeeds: ["https://status.deepseek.com/feed.rss"],
	autoRefreshMinutes: 10,
	fetchOnStart: false
};
const parsed = mod.default?.Config ? new mod.default.Config(config) : config;
console.log("Config parsed:", JSON.stringify({ initialFeeds: parsed.initialFeeds?.length, autoRefreshMinutes: parsed.autoRefreshMinutes }));
