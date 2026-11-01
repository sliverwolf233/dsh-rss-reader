import { parseFeed } from "../lib/parse.js";

const feeds = [
	"https://hnrss.org/frontpage",
	"https://github.com/deepseek-ai/DeepSeek-V3/commits/main.atom",
	"https://ruanyifeng.com/blog/atom.xml"
];
for (const url of feeds) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "dsh-rss-reader/0.1" } });
		if (!res.ok) {
			console.log(url, "->", "HTTP", res.status);
			continue;
		}
		const text = await res.text();
		const feed = parseFeed(text, url);
		const first = feed.items[0];
		console.log(url, "->", feed.format, "|", feed.title, "|", feed.items.length, "items | first:", String(first?.title).slice(0, 60), "|", first?.published);
	} catch (error) {
		console.log(url, "-> ERROR", error.message);
	}
}
