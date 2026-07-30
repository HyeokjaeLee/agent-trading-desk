import { loadConfig } from "../config/app-config.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
import { refreshSnapshot, loadSnapshot } from "../market/snapshot.js";
import { mapToYahoo } from "../market/ticker-map.js";
import { getKoreanCode } from "../market/naver.js";
import { expandWithProxies } from "../market/proxies.js";
import { getMarketState } from "../market/market-state.js";
import { runNewsWithFallback } from "../news/browser-use.js";
import { fetchMacroRates } from "../market/macro.js";
import { fetchInvestorFlows } from "../market/frgn.js";
import { loadRelevantMemory } from "./memory.js";
import { ensureTaxContextFresh } from "./tax-context.js";
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
	/** Skip portfolio data in context (for td ask — focus on question, not holdings). */
	skipPortfolio?: boolean;
	/** Offline mode: skip all live network fetches (macro/news/tax) and lock
	 *  agents to the cached snapshot. For backtests / controlled E2E. */
	offline?: boolean;
}

/** Assemble the full AnalysisContext: portfolio + snapshot (source of truth) + news + memory. */
type HoldingRef = { ticker: string; name?: string };
type Proxies = Record<
	string,
	Array<{ ticker: string; name: string; relation: string }>
>;

/** Expand portfolio + raw symbols into the full ticker set + US leading proxies. */
function resolveTickers(
	portfolio: AggregatedPortfolio,
	rawSymbols: string[] | undefined,
): { holdings: HoldingRef[]; tickers: string[]; proxies: Proxies } {
	const holdings: HoldingRef[] = portfolio.holdings.map((h) => ({
		ticker: h.ticker,
		name: h.name,
	}));
	for (const raw of rawSymbols ?? [])
		holdings.push({ ticker: mapToYahoo(raw).ticker });
	const { tickers: expanded, proxies } = expandWithProxies(holdings);
	const tickers = [
		...new Set([...holdings.map((h) => h.ticker), ...expanded, "KRW=X"]),
	];
	// US Treasury yield proxies for macro interest rates.
	tickers.push("^TNX", "^TYX", "^IRX", "^FVX");
	return { holdings, tickers, proxies };
}

/** Load the cached snapshot (offline) or refresh live, enforcing the historical cutoff
 *  and offline integrity. Never fetches when offline. */
async function resolveSnapshot(
	opts: BuildContextOptions,
	tickers: string[],
	proxies: Proxies,
	asOf: string | undefined,
	offline: boolean,
): Promise<MarketSnapshot> {
	let snapshot: MarketSnapshot | undefined = opts.refresh
		? undefined
		: loadSnapshot();
	const cached = new Set((snapshot?.tickers ?? []).map((t) => t.ticker));
	// Historical cutoff: a cache newer than asOf would let a backtest see the future.
	if (snapshot && asOf && new Date(snapshot.generatedAt) > new Date(asOf))
		fail(
			`Cached snapshot (${snapshot.generatedAt}) is NEWER than --as-of ${asOf}. Backtest needs a snapshot at or before the as-of date.`,
			2,
		);
	// Offline integrity: a locked backtest must have every requested ticker cached.
	if (offline && snapshot && tickers.some((t) => !cached.has(t)))
		fail(
			`Offline mode: requested tickers missing from cached snapshot: ${tickers.filter((t) => !cached.has(t)).join(", ")}. Run \`td market refresh --symbols ...\` first.`,
			2,
		);
	const stale =
		!snapshot ||
		Date.now() - new Date(snapshot.generatedAt).getTime() > 10 * 60 * 1000 ||
		tickers.some((t) => !cached.has(t));
	if (stale && !offline) {
		if (tickers.length === 0)
			fail("No tickers to analyze (no holdings and no --symbols).", 2);
		snapshot = await refreshSnapshot(tickers, {
			period: opts.period ?? "1y",
			asOf,
			leadingIndicators: proxies,
		});
	}
	if (!snapshot)
		fail(
			offline
				? "Offline/backtest mode requires a cached snapshot. Run `td market refresh` first."
				: "snapshot unavailable after refresh",
			1,
		);
	return snapshot;
}

/** Macro rates, investor flows, tax context — all skipped in offline mode (live web). */
async function fetchAncillary(
	holdings: HoldingRef[],
	tickersByYahoo: Record<string, unknown>,
	offline: boolean,
) {
	if (offline)
		return {
			macroRates: undefined,
			investorFlows: undefined,
			taxContext: undefined,
		};
	const macroRates = await fetchMacroRates(tickersByYahoo as never);
	const koreanStockEntries: Array<{ code: string; name?: string }> = [];
	for (const h of holdings) {
		const code = getKoreanCode(h.ticker);
		if (code) koreanStockEntries.push({ code, name: h.name });
	}
	const investorFlows =
		koreanStockEntries.length > 0
			? await fetchInvestorFlows(koreanStockEntries)
			: undefined;
	const { context: taxContext } = await ensureTaxContextFresh();
	return { macroRates, investorFlows, taxContext };
}

/** Assemble the full AnalysisContext: portfolio + snapshot + ancillary + memory. */
export async function buildAnalysisContext(
	opts: BuildContextOptions,
): Promise<{
	ctx: AnalysisContext;
	portfolio: AggregatedPortfolio;
	snapshot: MarketSnapshot;
}> {
	const config = loadConfig();
	const asOf = config.asOfDate ?? opts.asOf;
	const historical = Boolean(asOf);
	// Historical/blind mode ALWAYS locks the network — it cannot be bypassed by an explicit opts.offline:false.
	const offline =
		historical ||
		(opts.blind ?? false) ||
		(config.blindMode ?? false) ||
		(opts.offline ?? false);

	if (!offline && config.accounts.length === 0)
		fail(
			"No accounts enabled. Run: td auth account enable <broker> <profile>",
			2,
		);

	// Portfolio aggregation is live (broker API); skipped offline.
	const portfolio = offline
		? {
				asOf: asOf ?? new Date().toISOString(),
				cash: [],
				holdings: [],
				accounts: [],
			}
		: await aggregatePortfolio(config.accounts, { asOf });

	const { holdings, tickers, proxies } = resolveTickers(
		portfolio,
		opts.symbols,
	);
	const snapshot = await resolveSnapshot(opts, tickers, proxies, asOf, offline);

	const tickersByYahoo: Record<string, (typeof snapshot.tickers)[number]> = {};
	for (const t of snapshot.tickers) tickersByYahoo[t.ticker] = t;

	const { macroRates, investorFlows, taxContext } = await fetchAncillary(
		holdings,
		tickersByYahoo,
		offline,
	);

	const ctx: AnalysisContext = {
		objective: opts.objective,
		marketState: {
			KR: getMarketState("KR", asOf),
			US: getMarketState("US", asOf),
		},
		portfolio: opts.skipPortfolio
			? { asOf: portfolio.asOf, cash: [], holdings: [], accounts: [] }
			: portfolio,
		snapshot,
		tickersByYahoo,
		macroRates,
		investorFlows:
			investorFlows && investorFlows.size > 0 ? investorFlows : undefined,
		config,
		// Historical mode is inherently a backtest — agents must get the BLIND "no post-cutoff knowledge" note.
		blind: (opts.blind ?? config.blindMode ?? false) || offline,
		offline,
		now: offline || opts.blind ? new Date(asOf ?? Date.now()) : undefined,
		// Skip decision memory in backtest mode — future decisions must not leak into a locked prompt.
		priorDecisions: offline ? undefined : loadRelevantMemory(tickers),
		taxContext,
	};

	if (!offline && (opts.fetchNews ?? config.newsEnabled)) {
		const nr = await runNewsWithFallback(ctx, config);
		ctx.news = nr.items.length > 0 ? nr.items : undefined;
		ctx.newsReport = nr.report;
		if (nr.degraded) ctx.newsReason = nr.reason;
	}

	return { ctx, portfolio, snapshot };
}
