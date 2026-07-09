import { yahooToSymbol } from "./ticker-map.js";

/**
 * Cross-market leading indicators.
 *
 * When the Korean market is closed, the US session that already traded (or is
 * trading) is a FORWARD signal for the next KR open. Korean semiconductor names
 * (Samsung 005930, SK Hynix 000660) move closely with US semis: the Philadelphia
 * Semiconductor Index (tracked by SOXX/SMH ETFs) and Micron (MU) are strong
 * overnight leading indicators. Same idea applies to other sectors via ADRs.
 */

export interface LeadingIndicator {
	/** yfinance proxy ticker, e.g. SOXX, MU. */
	ticker: string;
	name: string;
	/** Why this proxy leads the target. */
	relation: string;
}

const SEMI_TICKERS = new Set([
	"005930",
	"000660",
	"005935",
	"005930.KS",
	"000660.KS",
	"005935.KS",
]);

const SEMI_KEYWORDS = [
	"반도체",
	"semiconductor",
	"memory",
	"메모리",
	"hynix",
	"samsung electro",
];

/** Generic broad-market overnight proxies (always relevant for KR market direction). */
const BROAD_PROXIES: LeadingIndicator[] = [
	{
		ticker: "^IXIC",
		name: "Nasdaq Composite",
		relation: "US tech/risk-appetite overnight direction",
	},
	{
		ticker: "^GSPC",
		name: "S&P 500",
		relation: "US broad-market overnight direction",
	},
];

const SEMI_PROXIES: LeadingIndicator[] = [
	{
		ticker: "SOXX",
		name: "iShares Semiconductor ETF (Philadelphia Semiconductor Index tracker)",
		relation:
			"Tracks the PHLX Semiconductor (SOX) index — strongest overnight leader for Korean memory/logic chip stocks",
	},
	{
		ticker: "SMH",
		name: "VanEck Semiconductor ETF",
		relation: "US semiconductor sector momentum",
	},
	{
		ticker: "MU",
		name: "Micron Technology",
		relation:
			"DRAM/NAND memory peer — direct read-across to Samsung/SK Hynix memory cycle",
	},
	{
		ticker: "NVDA",
		name: "NVIDIA",
		relation: "AI/HPC demand driver for HBM (SK Hynix, Samsung)",
	},
];

/** Whether a ticker is a Korean semiconductor name. */
export function isKoreanSemiconductor(ticker: string, name?: string): boolean {
	const { symbol, market } = yahooToSymbol(ticker);
	if (market !== "KR") return false;
	if (SEMI_TICKERS.has(symbol) || SEMI_TICKERS.has(ticker)) return true;
	const lc = (name ?? "").toLowerCase();
	return SEMI_KEYWORDS.some((k) => lc.includes(k.toLowerCase()));
}

/** US leading-indicator proxies for a given (typically Korean) ticker. */
export function leadingProxiesFor(
	ticker: string,
	name?: string,
): LeadingIndicator[] {
	if (isKoreanSemiconductor(ticker, name)) return SEMI_PROXIES;
	// Other Korean names: broad indices as generic overnight direction.
	const { market } = yahooToSymbol(ticker);
	if (market === "KR") return BROAD_PROXIES;
	return [];
}

/**
 * Expand a ticker list with their leading proxies. Returns the deduped combined
 * ticker list (for fetching) and the proxy map (krTicker → proxies).
 */
export function expandWithProxies(
	holdings: Array<{ ticker: string; name?: string }>,
): { tickers: string[]; proxies: Record<string, LeadingIndicator[]> } {
	const all = new Set<string>(holdings.map((h) => h.ticker));
	const proxies: Record<string, LeadingIndicator[]> = {};
	for (const h of holdings) {
		const px = leadingProxiesFor(h.ticker, h.name);
		if (px.length === 0) continue;
		proxies[h.ticker] = px;
		for (const p of px) all.add(p.ticker);
	}
	return { tickers: [...all], proxies };
}
