/**
 * Fetch-first news collector (RSS / HTML). This is the PRIMARY news path — it
 * tries plain HTTP fetches before the heavy browser-use fallback.
 *
 * Sources:
 *   - Korean stocks (market === "KR"):
 *       네이버 증권 종목뉴스 HTML (finance.naver.com/item/news_news.naver?code=SYMBOL)
 *   - US stocks (market === "US"):
 *       Google News RSS (news.google.com/rss/search?q=SYMBOL+stock)
 *
 * No npm deps — global fetch() + regex parsing only. EUC-KR decoding for Naver.
 */

export interface CollectedNewsItem {
	title: string;
	summary: string;
	url: string;
	date: string; // ISO timestamp
	region: "KR" | "US";
	source: string; // "naver", "google-news"
}

export interface CollectResult {
	items: CollectedNewsItem[];
	source: "naver" | "yahoo" | "google-news" | "mixed";
	degraded: boolean;
	reason?: string;
}

interface Holding {
	ticker: string;
	name?: string;
	market: string;
	symbol: string;
}

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Fetch with timeout + UA, returning text (with EUC-KR fallback for Naver). */
async function fetchText(
	url: string,
	timeoutMs: number,
	eucKr = false,
): Promise<string | undefined> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept:
					"text/html,application/xhtml+xml,application/xml,text/xml,*/*",
				"Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
			},
			signal: ctrl.signal,
		});
		if (!resp.ok) return undefined;
		if (eucKr) {
			const buf = await resp.arrayBuffer();
			try {
				return new TextDecoder("euc-kr", { fatal: false }).decode(buf);
			} catch {
				return new TextDecoder("utf-8").decode(buf);
			}
		}
		return await resp.text();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** HTML-decode the common entities Naver uses in titles. */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&#\d+;/g, (m) => {
			const cp = Number(m.slice(2, -1));
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
		});
}

/** Strip ".KS"/".KQ"/etc. from a Korean ticker to get the 6-digit symbol. */
function naverSymbol(ticker: string, fallbackSymbol: string): string {
	const m = ticker.match(/^(\d{6})/);
	if (m && m[1]) return m[1];
	if (/^\d{6}$/.test(fallbackSymbol)) return fallbackSymbol;
	return fallbackSymbol.replace(/\.(KS|KQ|KO)$/, "");
}

/** Parse Naver item-news HTML into CollectedNewsItem[]. */
function parseNaverItemNews(html: string, code: string): CollectedNewsItem[] {
	const items: CollectedNewsItem[] = [];
	// Naver's news table: each row is a <tr class="first">|<tr> with a link
	// <a href="...">TITLE</a>, an info line (source, date), and optional summary.
	// We anchor on <a ...href="(url)"...>(title)</a> followed within ~400 chars by
	// a date pattern like "2024.07.15 14:30".
	const rowRe =
		/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,500}?(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2})/g;
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(html)) !== null) {
		const href = m[1] ?? "";
		const url = href.startsWith("http")
			? href
			: `https://finance.naver.com${href}`;
		const title = decodeEntities((m[2] ?? "").trim());
		const date = naverDateToIso((m[3] ?? "").trim());
		if (!title || title.length < 4) continue;
		items.push({
			title,
			summary: "",
			url,
			date,
			region: "KR",
			source: "naver",
		});
	}
	// Fallback: title-only links if the row regex missed.
	if (items.length === 0) {
		const linkRe =
			/<a[^>]*class="tit"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
		while ((m = linkRe.exec(html)) !== null && items.length < 10) {
		const title = decodeEntities((m[2] ?? "").trim());
		if (!title || title.length < 4) continue;
		const href = m[1] ?? "";
		items.push({
			title,
			summary: "",
			url: href.startsWith("http") ? href : `https://finance.naver.com${href}`,
			date: new Date().toISOString(),
			region: "KR",
			source: "naver",
		});
		}
	}
	void code;
	return items;
}

/** Convert "2024.07.15 14:30" (KST, no tz) to an ISO timestamp. */
function naverDateToIso(s: string): string {
	const m = s.match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
	if (!m) return new Date().toISOString();
	const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`;
	const d = new Date(iso);
	return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Parse Google News RSS XML into CollectedNewsItem[]. */
function parseGoogleNewsRss(
	xml: string,
	query: string,
	region: "KR" | "US" = "US",
): CollectedNewsItem[] {
	const items: CollectedNewsItem[] = [];
	const itemRe =
		/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml)) !== null) {
		const title = decodeEntities((m[1] ?? "").trim().replace(/\s+-\s+[^-]+$/, ""));
		const link = (m[2] ?? "").trim();
		const date = new Date((m[3] ?? "").trim());
		items.push({
			title,
			summary: "",
			url: link,
			date: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
			region,
			source: "google-news",
		});
	}
	void query;
	return items;
}

/** Normalize a title for dedup (lowercase, strip punctuation/whitespace). */
function normalizeTitle(s: string): string {
	return s.toLowerCase().replace(/[\s.,!?·:;\-"']/g, "");
}

/** Similarity ratio via bigram overlap (cheap, good enough for dedup). */
function titleSimilarity(a: string, b: string): number {
	const na = normalizeTitle(a);
	const nb = normalizeTitle(b);
	if (na === nb) return 1;
	if (na.length < 6 || nb.length < 6) return na === nb ? 1 : 0;
	const bigrams = (s: string): Set<string> => {
		const set = new Set<string>();
		for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
		return set;
	};
	const ba = bigrams(na);
	const bb = bigrams(nb);
	let inter = 0;
	for (const g of ba) if (bb.has(g)) inter++;
	return inter / Math.max(ba.size, bb.size);
}

/** Deduplicate by exact normalized match or >90% bigram overlap. */
function dedupe(items: CollectedNewsItem[]): CollectedNewsItem[] {
	const out: CollectedNewsItem[] = [];
	for (const it of items) {
		const dup = out.some(
			(o) => titleSimilarity(o.title, it.title) > 0.9,
		);
		if (!dup) out.push(it);
	}
	return out;
}

/**
 * Collect news via fetch (RSS/HTML). This is the PRIMARY path.
 * Returns enough items for analysis without browser-use.
 */
export async function collectNews(
	holdings: Holding[],
	opts: { timeoutMs?: number } = {},
): Promise<CollectResult> {
	const totalTimeout = opts.timeoutMs ?? 30_000;
	const perSourceTimeout = Math.min(12_000, totalTimeout);
	const now = Date.now();
	const cutoff = now - SEVEN_DAYS_MS;

	const krHoldings = holdings.filter((h) => h.market === "KR");
	const usHoldings = holdings.filter((h) => h.market === "US");

	const tasks: Array<Promise<CollectedNewsItem[]>> = [];

	// Korean: Google News RSS with Korean query (Naver item-news is JS-rendered,
	// static fetch returns empty body). Korean name gives best results.
	for (const h of krHoldings.slice(0, 8)) {
		const query = h.name || h.symbol || h.ticker.replace(/\.[A-Z]+$/, "");
		const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
		tasks.push(
			fetchText(url, perSourceTimeout).then(
				(xml) => (xml ? parseGoogleNewsRss(xml, query, "KR") : []),
			),
		);
	}

	// US: Google News RSS per ticker.
	for (const h of usHoldings.slice(0, 8)) {
		const sym = h.symbol || h.ticker.replace(/\.[A-Z]+$/, "");
		const url = `https://news.google.com/rss/search?q=${encodeURIComponent(sym + " stock")}&hl=en-US&gl=US&ceid=US:en`;
		tasks.push(
			fetchText(url, perSourceTimeout).then(
				(xml) => (xml ? parseGoogleNewsRss(xml, sym) : []),
			),
		);
	}

	// Macro/rate news queries — always included regardless of holdings, so the
	// news digest always has interest-rate / central-bank / FOMC context.
	const macroQueries: Array<{ q: string; region: "KR" | "US" }> = [
		{ q: "한국 기준금리", region: "KR" },
		{ q: "한국 국고채", region: "KR" },
		{ q: "FOMC 금리", region: "US" },
		{ q: "미국 국채 수익률", region: "US" },
	];
	for (const mq of macroQueries) {
		const hl = mq.region === "KR" ? "ko" : "en";
		const gl = mq.region;
		const ceid = mq.region === "KR" ? "KR:ko" : "US:en";
		const url = `https://news.google.com/rss/search?q=${encodeURIComponent(mq.q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
		tasks.push(
			fetchText(url, perSourceTimeout).then(
				(xml) => (xml ? parseGoogleNewsRss(xml, mq.q, mq.region) : []),
			),
		);
	}

	// Overall deadline: race the batch against a hard cutoff.
	const batch = Promise.allSettled(tasks);
	const cutoffPromise = new Promise<PromiseSettledResult<CollectedNewsItem[]>[]>(
		(resolve) =>
			setTimeout(
				() => resolve([]),
				totalTimeout,
			),
	).then(() => []);

	const settled = (await Promise.race([batch, cutoffPromise])) as
		| PromiseSettledResult<CollectedNewsItem[]>[]
		| [];

	let items: CollectedNewsItem[] = [];
	let failures = 0;
	for (const r of settled) {
		if (r.status === "fulfilled") items.push(...r.value);
		else failures++;
	}

	// Filter to last 7 days, dedupe, sort newest-first, cap at 20.
	items = items
		.filter((it) => {
			const t = new Date(it.date).getTime();
			return Number.isFinite(t) ? t >= cutoff : true;
		})
		.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	items = dedupe(items).slice(0, 20);

	const hasKr = items.some((i) => i.region === "KR");
	const hasUs = items.some((i) => i.region === "US");
	const source: CollectResult["source"] =
		hasKr && hasUs ? "mixed" : "google-news";

	if (items.length === 0) {
		return {
			items: [],
			source,
			degraded: true,
			reason: `no items collected (${failures} source(s) failed, timeout=${totalTimeout}ms)`,
		};
	}

	return { items, source, degraded: false };
}
