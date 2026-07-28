/**
 * Macro interest rates — hybrid collection (yfinance proxy tickers + web scraping).
 *
 * A안 (yfinance): ^TNX (10Y), ^TYX (30Y), ^IRX (13W T-Bill), ^FVX (5Y).
 *   Korean yields are NOT covered by yfinance.
 * B안 (web scraping, no API key):
 *   - Naver marketindex (국고채/회사채/CD/콜금리) — EUC-KR encoded HTML.
 *   - CNBC quotes (US backup) — best-effort regex.
 *
 * Cross-validates overlapping indicators (US 10Y from yfinance vs CNBC); flags
 * any divergence > 5bp. All sources fetched in parallel; degrades gracefully.
 */

export interface RateIndicator {
	name: string; // "US 10Y Treasury", "한국 국고채 10년"
	value: number; // yield in %
	changeBp: number; // daily change in basis points
	source: "yfinance" | "naver" | "cnbc";
	region: "KR" | "US";
	fetchedAt: string; // ISO timestamp
}

export interface RateDiscrepancy {
	name: string;
	aValue: number;
	bValue: number;
	diffBp: number;
}

export interface MacroSnapshot {
	rates: RateIndicator[];
	crossValidated: boolean;
	discrepancies: RateDiscrepancy[];
	fetchedAt: string;
	degraded: boolean;
	reason?: string;
}

/** Minimal ticker-map shape passed in from the snapshot. */
type TickerMap = Record<
	string,
	{ fundamentals?: { price?: number }; technicals?: { return1d?: number } }
>;

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SOURCE_TIMEOUT_MS = 15_000;

/** Fetch with a per-source timeout + UA header. */
async function fetchWithTimeout(
	url: string,
	timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,application/xml,text/xml,*/*",
				"Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
			},
			signal: ctrl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

/** Decode a Naver response body, preferring EUC-KR when the runtime supports it. */
async function decodeNaverBody(resp: Response): Promise<string> {
	const buf = await resp.arrayBuffer();
	// Node's TextDecoder supports 'euc-kr' only when full ICU is linked. Try, then
	// fall back to utf-8 (which mangles Hangul but still exposes numeric yields).
	try {
		const dec = new TextDecoder("euc-kr", { fatal: false });
		const out = dec.decode(buf);
		// Heuristic: if decoded text still has replacement chars for Hangul but
		// has digits, euc-kr path likely worked (Hangul may decode either way).
		return out;
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

/** Escape regex meta-characters in a literal string. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pull the first <number.number> that appears within ~200 chars after `label`. */
function numberAfterLabel(html: string, label: string): number | undefined {
	const re = new RegExp(`${escapeRegex(label)}[\\s\\S]{0,200}?(-?\\d+\\.\\d+)`);
	const m = html.match(re);
	if (!m) return undefined;
	const v = Number(m[1]);
	return Number.isFinite(v) ? v : undefined;
}

/** Read yfinance rate tickers out of the snapshot map. */
function ratesFromYahoo(
	tm: TickerMap | undefined,
	now: string,
): RateIndicator[] {
	if (!tm) return [];
	const defs: Array<{ ticker: string; name: string }> = [
		{ ticker: "^TNX", name: "US 10Y Treasury" },
		{ ticker: "^TYX", name: "US 30Y Treasury" },
		{ ticker: "^IRX", name: "US 13-Week T-Bill" },
		{ ticker: "^FVX", name: "US 5Y Treasury" },
	];
	const out: RateIndicator[] = [];
	for (const d of defs) {
		const t = tm[d.ticker];
		const price = t?.fundamentals?.price;
		if (typeof price !== "number" || !Number.isFinite(price)) continue;
		const ret1d = t?.technicals?.return1d;
		const changeBp =
			typeof ret1d === "number" && Number.isFinite(ret1d)
				? Math.round(ret1d * 10000)
				: 0;
		out.push({
			name: d.name,
			value: price,
			changeBp,
			source: "yfinance",
			region: "US",
			fetchedAt: now,
		});
	}
	return out;
}

/** Scrape Korean bond/CD/call yields from Naver marketindex. */
async function ratesFromNaver(
	now: string,
): Promise<RateIndicator[]> {
	const urls = [
		"https://finance.naver.com/marketindex/depositList.naver",
		"https://finance.naver.com/marketindex/",
	];
	let html = "";
	for (const url of urls) {
		try {
			const resp = await fetchWithTimeout(url);
			if (!resp.ok) continue;
			html = await decodeNaverBody(resp);
			if (html) break;
		} catch {
			/* try next */
		}
	}
	if (!html) return [];

	// Targets: 국고채 1년/3년/5년/10년, 회사채 AA-/BBB-, CD(91일), 콜금리.
	const targets: Array<{ label: RegExp; name: string }> = [
		{ label: /국고채\s*10\s*년/, name: "한국 국고채 10년" },
		{ label: /국고채\s*5\s*년/, name: "한국 국고채 5년" },
		{ label: /국고채\s*3\s*년/, name: "한국 국고채 3년" },
		{ label: /국고채\s*1\s*년/, name: "한국 국고채 1년" },
		{ label: /회사채\s*AA-?/, name: "한국 회사채 AA-" },
		{ label: /회사채\s*BBB-?/, name: "한국 회사채 BBB-" },
		{ label: /CD\s*\(?\s*91\s*일?\)?|CD\s*91/, name: "한국 CD(91일)" },
		{ label: /콜금리/, name: "한국 콜금리" },
	];

	const out: RateIndicator[] = [];
	const seen = new Set<string>();
	for (const t of targets) {
		// Find the label's literal position in the decoded HTML, then scan forward
		// for the first decimal yield.
		const m = html.match(t.label);
		if (!m || m.index === undefined) continue;
		if (seen.has(t.name)) continue;
		const slice = html.slice(m.index, m.index + 250);
		const numMatch = slice.match(/(-?\d+\.\d{1,4})/);
		if (!numMatch) continue;
		const value = Number(numMatch[1]);
		if (!Number.isFinite(value) || value < -2 || value > 30) continue;
		seen.add(t.name);
		out.push({
			name: t.name,
			value,
			changeBp: 0, // Naver page change column is inconsistent — not parsed.
			source: "naver",
			region: "KR",
			fetchedAt: now,
		});
	}
	return out;
}

/** Scrape US 10Y yield from CNBC as a cross-validation source. */
async function rateFromCnbc(now: string): Promise<RateIndicator | undefined> {
	try {
		const resp = await fetchWithTimeout("https://www.cnbc.com/quotes/US10Y");
		if (!resp.ok) return undefined;
		const html = await resp.text();
		// CNBC embeds quote data in a JSON-ish blob; look for the last price near
		// "US10Y" or a percentage-style number following key markers.
		const candidates = [
			html.match(/"last"\s*:\s*"?(?:US10Y"?[^}]{0,80}?|)(\d{1,2}\.\d{2,4})/),
			html.match(/"RegularMarketPrice"\s*:\s*"?(\d{1,2}\.\d{2,4})/),
			html.match(/US10Y[\s\S]{0,400}?(\d{1,2}\.\d{2,3})\s*%/),
		];
		for (const c of candidates) {
			if (!c) continue;
			const v = Number(c[1]);
			if (Number.isFinite(v) && v > 0 && v < 25) {
				return {
					name: "US 10Y Treasury",
					value: v,
					changeBp: 0,
					source: "cnbc",
					region: "US",
					fetchedAt: now,
				};
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Cross-validate US 10Y from yfinance vs CNBC; flag divergence > 5bp. */
function crossValidate(rates: RateIndicator[]): {
	crossValidated: boolean;
	discrepancies: RateDiscrepancy[];
} {
	const tnx = rates.find((r) => r.name === "US 10Y Treasury" && r.source === "yfinance");
	const cnbc = rates.find((r) => r.name === "US 10Y Treasury" && r.source === "cnbc");
	const discrepancies: RateDiscrepancy[] = [];
	let crossValidated = false;
	if (tnx && cnbc) {
		crossValidated = true;
		const diffBp = Math.abs(tnx.value - cnbc.value) * 100;
		if (diffBp > 5) {
			discrepancies.push({
				name: "US 10Y Treasury",
				aValue: tnx.value,
				bValue: cnbc.value,
				diffBp,
			});
		}
	}
	return { crossValidated, discrepancies };
}

/**
 * Fetch macro interest rates from hybrid sources (yfinance + Naver + CNBC).
 * @param tickersByYahoo - snapshot ticker map (for yfinance rates ^TNX etc).
 */
export async function fetchMacroRates(
	tickersByYahoo?: TickerMap,
): Promise<MacroSnapshot> {
	const now = new Date().toISOString();
	const [yRates, naverRates, cnbcRate] = await Promise.allSettled([
		Promise.resolve(ratesFromYahoo(tickersByYahoo, now)),
		ratesFromNaver(now),
		rateFromCnbc(now),
	]);

	const rates: RateIndicator[] = [];
	const failures: string[] = [];
	if (yRates.status === "fulfilled") rates.push(...yRates.value);
	else failures.push("yfinance");
	if (naverRates.status === "fulfilled") rates.push(...naverRates.value);
	else failures.push("naver");
	if (cnbcRate.status === "fulfilled" && cnbcRate.value) rates.push(cnbcRate.value);
	else failures.push("cnbc");

	const { crossValidated, discrepancies } = crossValidate(rates);

	if (rates.length === 0) {
		return {
			rates: [],
			crossValidated: false,
			discrepancies: [],
			fetchedAt: now,
			degraded: true,
			reason: `all macro sources failed (${failures.join(", ")})`,
		};
	}

	return {
		rates,
		crossValidated,
		discrepancies,
		fetchedAt: now,
		degraded: failures.length === 3,
		reason:
			failures.length > 0
				? `partial: ${failures.join(", ")} failed`
				: undefined,
	};
}
