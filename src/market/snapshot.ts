/**
 * Market snapshot layer — the single source of truth.
 *
 * `refreshSnapshot()` triggers the ONE Yahoo fetch per CLI invocation (via the
 * yfinance bridge), builds a MarketSnapshot, writes it to disk (SNAPSHOT_FILE),
 * and returns it. Everything else reads the cache via `loadSnapshot()`.
 */
import { SNAPSHOT_FILE } from "../config/paths.js";
import { readJsonFile, writeJsonFile } from "../output.js";
import type {
	AggregatedPortfolio,
	Candle,
	Fundamentals,
	MarketSnapshot,
	TickerSnapshot,
	TechnicalIndicators,
} from "../types.js";
import { getMarketState } from "./market-state.js";
import { yahooToSymbol } from "./ticker-map.js";
import {
	fetchTickers,
	type BridgeCandle,
	type BridgeTicker,
} from "./yfinance.js";

/** Options for refreshing the snapshot. */
export interface RefreshOptions {
	/** yfinance history period, e.g. "1y". */
	period?: string;
	/** yfinance history interval, e.g. "1d". */
	interval?: string;
	/** Override the generatedAt timestamp (ISO). Defaults to now. */
	asOf?: string;
	/** US leading-indicator proxies per Korean ticker to attach (already fetched among tickers). */
	leadingIndicators?: Record<
		string,
		Array<{ ticker: string; name: string; relation: string }>
	>;
}

/**
 * Refresh the cached source-of-truth snapshot.
 *
 * Fetches all tickers in a single batch from the yfinance bridge, maps each into
 * a TickerSnapshot, attaches market session state for KR/US, writes the result
 * to SNAPSHOT_FILE, and returns it.
 */
export async function refreshSnapshot(
	tickers: string[],
	opts?: RefreshOptions,
): Promise<MarketSnapshot> {
	const raw = fetchTickers(tickers, {
		period: opts?.period,
		interval: opts?.interval,
	});
	const asOf = opts?.asOf ?? new Date().toISOString();

	const snapshot: MarketSnapshot = {
		generatedAt: asOf,
		yfinanceVersion: raw.yfinanceVersion,
		requested: tickers,
		tickers: raw.tickers.map(mapTicker),
		marketState: {
			KR: getMarketState("KR", asOf),
			US: getMarketState("US", asOf),
		},
		leadingIndicators: opts?.leadingIndicators,
	};

	writeJsonFile(SNAPSHOT_FILE, snapshot);
	return snapshot;
}

/** Read the cached snapshot, or undefined if missing/invalid. */
export function loadSnapshot(): MarketSnapshot | undefined {
	return readJsonFile<MarketSnapshot>(SNAPSHOT_FILE);
}

/** Age of the cached snapshot in ms (Date.now() - generatedAt), or undefined. */
export function snapshotAgeMs(): number | undefined {
	const snap = loadSnapshot();
	if (!snap) return undefined;
	const t = Date.parse(snap.generatedAt);
	if (Number.isNaN(t)) return undefined;
	return Date.now() - t;
}

/**
 * Resolve the unique list of yfinance tickers for a portfolio.
 *
 * Holdings already carry canonical yfinance tickers (e.g. "005930.KS", "AAPL");
 * this just dedupes them, preserving first-seen order.
 */
export function resolveTickers(portfolio: AggregatedPortfolio): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const h of portfolio.holdings) {
		const t = h?.ticker;
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

/** Map a raw bridge ticker entry into the domain TickerSnapshot. */
function mapTicker(t: BridgeTicker): TickerSnapshot {
	const { symbol, market } = yahooToSymbol(t.ticker);
	const result: TickerSnapshot = { ticker: t.ticker, symbol, market };

	const name = typeof t.name === "string" && t.name ? t.name : undefined;
	const fundamentals = mapFundamentals(t.ticker, t.fundamentals);
	const technicals = mapTechnicals(t.ticker, t.technicals);

	if (name) result.name = name;
	if (fundamentals) result.fundamentals = fundamentals;
	if (technicals) result.technicals = technicals;
	if (t.error) result.error = t.error;
	return result;
}

/** Map raw bridge fundamentals into the domain Fundamentals type. */
function mapFundamentals(
	ticker: string,
	f: BridgeTicker["fundamentals"],
): Fundamentals | undefined {
	if (!f) return undefined;
	const rest = compact<Partial<Fundamentals>>({
		price: toNum(f.currentPrice) ?? toNum(f.price),
		currency: typeof f.currency === "string" ? f.currency : undefined,
		marketCap: toNum(f.marketCap),
		per: toNum(f.trailingPE),
		forwardPer: toNum(f.forwardPE),
		pegRatio: toNum(f.pegRatio),
		pbr: toNum(f.priceToBook),
		psr: toNum(f.priceToSalesTrailing12Months),
		pcr: toNum(f.priceToCashflow),
		dividendYield: toNum(f.dividendYield),
		profitMargin: toNum(f.profitMargins),
		operatingMargin: toNum(f.operatingMargins),
		roe: toNum(f.returnOnEquity),
		roa: toNum(f.returnOnAssets),
		revenueGrowth: toNum(f.revenueGrowth),
		earningsGrowth: toNum(f.earningsGrowth),
		totalRevenue: toNum(f.totalRevenue),
		totalCash: toNum(f.totalCash),
		totalDebt: toNum(f.totalDebt),
		beta: toNum(f.beta),
		fiftyTwoWeekHigh: toNum(f.fiftyTwoWeekHigh),
		fiftyTwoWeekLow: toNum(f.fiftyTwoWeekLow),
	});
	const result: Fundamentals = { ticker, ...rest };
	return result;
}

/** Map raw bridge technicals into the domain TechnicalIndicators type. */
function mapTechnicals(
	ticker: string,
	t: BridgeTicker["technicals"],
): TechnicalIndicators | undefined {
	if (!t) return undefined;
	const rest = compact<Partial<TechnicalIndicators>>({
		sma20: toNum(t.sma20),
		sma50: toNum(t.sma50),
		sma200: toNum(t.sma200),
		ema12: toNum(t.ema12),
		ema26: toNum(t.ema26),
		rsi14: toNum(t.rsi14),
		macd: toNum(t.macd),
		macdSignal: toNum(t.macdSignal),
		macdHist: toNum(t.macdHist),
		bbUpper: toNum(t.bbUpper),
		bbMiddle: toNum(t.bbMiddle),
		bbLower: toNum(t.bbLower),
		atr14: toNum(t.atr14),
		return1d: toNum(t.return1d),
		return5d: toNum(t.return5d),
		return20d: toNum(t.return20d),
		return60d: toNum(t.return60d),
		support: toNum(t.support),
		resistance: toNum(t.resistance),
	});
	const result: TechnicalIndicators = {
		ticker,
		recent: mapCandles(t.recent),
		...rest,
	};
	return result;
}

/** Map raw bridge candles into domain Candle[], dropping rows lacking OHLC/date. */
function mapCandles(candles: BridgeCandle[] | undefined): Candle[] {
	if (!Array.isArray(candles) || candles.length === 0) return [];
	const out: Candle[] = [];
	for (const c of candles) {
		if (!c || typeof c !== "object") continue;
		const date = typeof c.date === "string" ? c.date : undefined;
		const open = toNum(c.open);
		const high = toNum(c.high);
		const low = toNum(c.low);
		const close = toNum(c.close);
		if (
			!date ||
			open === undefined ||
			high === undefined ||
			low === undefined ||
			close === undefined
		) {
			continue;
		}
		out.push({ date, open, high, low, close, volume: toNum(c.volume) ?? 0 });
	}
	return out;
}

/** Coerce a bridge value to a finite number, else undefined. */
function toNum(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	return undefined;
}

/** Return a copy of an object with all `undefined`-valued keys dropped. */
function compact<T extends object>(o: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (v !== undefined) out[k] = v;
	}
	return out as Partial<T>;
}
