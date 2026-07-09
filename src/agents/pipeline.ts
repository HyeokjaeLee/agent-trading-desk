import { loadConfig } from "../config/app-config.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
import { refreshSnapshot, loadSnapshot } from "../market/snapshot.js";
import { mapToYahoo } from "../market/ticker-map.js";
import { expandWithProxies } from "../market/proxies.js";
import { getMarketState } from "../market/market-state.js";
import { fetchNews, type NewsItem } from "../news/browser-use.js";
import { loadRelevantMemory } from "./memory.js";
import type { AnalysisContext } from "./roles.js";
import type { AggregatedPortfolio, MarketSnapshot } from "../types.js";
import { fail } from "../output.js";

export interface BuildContextOptions {
	objective: "portfolio-recommend" | "strategy";
	/** Extra raw symbols (e.g. AAPL, 005930) to analyze beyond current holdings. */
	symbols?: string[];
	/** Force a fresh yfinance fetch even if a snapshot is cached. */
	refresh?: boolean;
	/** Fetch news via browser-use. */
	fetchNews?: boolean;
	/** Backtest/blind mode (hide realized outcomes). */
	blind?: boolean;
	/** As-of date override (ISO or YYYY-MM-DD) for backtesting. */
	asOf?: string;
	/** History window. */
	period?: string;
}

/** Assemble the full AnalysisContext: portfolio + snapshot (source of truth) + news + memory. */
export async function buildAnalysisContext(opts: BuildContextOptions): Promise<{
	ctx: AnalysisContext;
	portfolio: AggregatedPortfolio;
	snapshot: MarketSnapshot;
}> {
	const config = loadConfig();
	const asOf = config.asOfDate ?? opts.asOf;

	if (config.accounts.length === 0) {
		fail(
			"No accounts enabled. Run: td auth account enable <broker> <profile>",
			2,
		);
	}

	// 1. READ-ONLY portfolio aggregation.
	const portfolio = await aggregatePortfolio(config.accounts, { asOf });

	// 2. Source-of-truth snapshot (fetched ONCE). Expand Korean holdings with US
	//    leading-indicator proxies (overnight forward signals for the KR open).
	const holdings: Array<{ ticker: string; name?: string }> =
		portfolio.holdings.map((h) => ({ ticker: h.ticker, name: h.name }));
	for (const raw of opts.symbols ?? [])
		holdings.push({ ticker: mapToYahoo(raw).ticker });
	const { tickers: expanded, proxies } = expandWithProxies(holdings);
	const tickers = [...new Set([...holdings.map((h) => h.ticker), ...expanded])];

	let snapshot: MarketSnapshot | undefined;
	if (!opts.refresh) snapshot = loadSnapshot();
	// Refresh if there is no cache OR any requested ticker (+proxies) is missing
	// from the cached snapshot, so --symbols NEWTICKER is never silently dropped.
	const cached = new Set((snapshot?.tickers ?? []).map((t) => t.ticker));
	const stale = !snapshot || tickers.some((t) => !cached.has(t));
	if (stale) {
		if (tickers.length === 0)
			fail("No tickers to analyze (no holdings and no --symbols).", 2);
		snapshot = await refreshSnapshot(tickers, {
			period: opts.period ?? "1y",
			asOf,
			leadingIndicators: proxies,
		});
	}
	if (!snapshot) fail("snapshot unavailable after refresh", 1);

	const tickersByYahoo: Record<string, (typeof snapshot.tickers)[number]> = {};
	for (const t of snapshot.tickers) tickersByYahoo[t.ticker] = t;

	// 3. News (optional; degrades gracefully).
	let news: NewsItem[] | undefined;
	let newsReason: string | undefined;
	const wantNews = opts.fetchNews ?? config.newsEnabled;
	if (wantNews) {
		const queries = tickers.map((t) => {
			const region = t.endsWith(".KS") || t.endsWith(".KQ") ? "KR" : "US";
			return {
				query: `${t} stock news`,
				region: region as "KR" | "US",
				ticker: t,
			};
		});
		const result = await fetchNews(queries, { nowIso: asOf });
		news = result.degraded ? undefined : result.items;
		newsReason = result.degraded ? result.reason : undefined;
	}

	// 4. Market state.
	const marketState = {
		KR: getMarketState("KR", asOf),
		US: getMarketState("US", asOf),
	};

	// 5. Decision memory.
	const priorDecisions = loadRelevantMemory(tickers);

	const ctx: AnalysisContext = {
		objective: opts.objective,
		marketState,
		portfolio,
		snapshot,
		tickersByYahoo,
		news,
		newsReason,
		config,
		blind: opts.blind ?? config.blindMode ?? false,
		priorDecisions,
	};

	return { ctx, portfolio, snapshot };
}
