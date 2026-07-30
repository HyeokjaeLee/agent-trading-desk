/**
 * Cross-market leading indicators.
 *
 * When the Korean market is closed, the US session that already traded (or is
 * trading) is a FORWARD signal for the next KR open. Korean semiconductor names
 * (Samsung 005930, SK Hynix 000660) move closely with US semis: the Philadelphia
 * Semiconductor Index (tracked by SOXX/SMH ETFs) and Micron (MU) are strong
 * overnight leading indicators. Same idea applies to other sectors via ADRs.
 *
 * Relationships are no longer hardcoded — they live in
 * ~/.agent-trading-desk/proxy-map.json (managed by proxy-store.ts / `td proxy`)
 * and are loaded into `cachedMap`. Call reloadProxyMap() to pick up edits.
 */
import { yahooToSymbol } from "./ticker-map.js";
import {
	loadProxyMap,
	findCategory,
	type ProxyEntry,
	type ProxyMap,
} from "./proxy-store.js";

/** A leading-indicator proxy (alias kept for backward compatibility). */
export type LeadingIndicator = ProxyEntry;

// Cache the proxy map in memory (reload via reloadProxyMap()).
let cachedMap: ProxyMap = loadProxyMap();

/** Reload the proxy map from disk — call after proxy-map.json is edited. */
export function reloadProxyMap(): void {
	cachedMap = loadProxyMap();
}

/**
 * Whether a ticker is a Korean semiconductor name. A ticker matches if it falls
 * in the "korean-semiconductor" proxy-map category AND is on the KR market.
 */
export function isKoreanSemiconductor(ticker: string, name?: string): boolean {
	const { symbol, market } = yahooToSymbol(ticker);
	if (market !== "KR") return false;
	// Match on either the full ticker or the bare symbol, like the old code.
	const cat =
		findCategory(cachedMap, ticker, name, market) ??
		findCategory(cachedMap, symbol, name, market);
	return cat?.id === "korean-semiconductor";
}

/** US leading-indicator proxies for a given (typically Korean) ticker. */
export function leadingProxiesFor(
	ticker: string,
	name?: string,
): LeadingIndicator[] {
	const { symbol, market } = yahooToSymbol(ticker);
	const cat =
		findCategory(cachedMap, ticker, name, market) ??
		findCategory(cachedMap, symbol, name, market);
	return cat?.proxies ?? [];
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
