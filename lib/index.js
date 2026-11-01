/**
 * Deprecated module path. The plugin entry moved to the package root
 * (`@local/rss-reader` → `./index.js`, the RssReaderService). This stub
 * keeps old relative imports from silently loading a second, stale plugin.
 */
throw new Error("rss-reader/lib/index.js is deprecated; import the package root (../index.js) instead");
