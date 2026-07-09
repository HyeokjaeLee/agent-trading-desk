/**
 * Yahoo Finance bridge (TypeScript-native).
 *
 * This is the ONLY code path that talks to Yahoo: it fetches fundamentals +
 * OHLCV via `yahoo-finance2` and computes technical indicators (SMA/EMA/RSI/
 * MACD/Bollinger/ATR, returns, support/resistance) in TypeScript. The TA math
 * is ported faithfully from the former `py/yfinance_fetch.py`. The result is
 * fetched ONCE per invocation and cached by the snapshot layer.
 *
 * No subprocess / Python is involved.
 */
import YahooFinance from "yahoo-finance2";

/** Options forwarded to the Yahoo fetch. */
export interface FetchOptions {
	/** History lookback, e.g. "1y". Defaults to "1y". */
	period?: string;
	/** Bar interval, e.g. "1d". Defaults to "1d". */
	interval?: string;
}

/** A single OHLCV bar from the bridge. */
export interface BridgeCandle {
	date: string;
	open?: number;
	high?: number;
	low?: number;
	close?: number;
	volume?: number;
}

/** Raw technical indicator object emitted by the bridge (snake-free, pre-mapping). */
export interface BridgeTechnicals {
	sma20?: number;
	sma50?: number;
	sma200?: number;
	ema12?: number;
	ema26?: number;
	rsi14?: number;
	macd?: number;
	macdSignal?: number;
	macdHist?: number;
	bbUpper?: number;
	bbMiddle?: number;
	bbLower?: number;
	atr14?: number;
	return1d?: number;
	return5d?: number;
	return20d?: number;
	return60d?: number;
	support?: number;
	resistance?: number;
	recent?: BridgeCandle[];
}

/** Raw fundamentals object emitted by the bridge (yfinance key names). */
export interface BridgeFundamentals {
	symbol?: string;
	currency?: string;
	currentPrice?: number;
	price?: number;
	marketCap?: number;
	trailingPE?: number;
	forwardPE?: number;
	pegRatio?: number;
	priceToBook?: number;
	priceToSalesTrailing12Months?: number;
	priceToCashflow?: number;
	dividendYield?: number;
	profitMargins?: number;
	operatingMargins?: number;
	returnOnEquity?: number;
	returnOnAssets?: number;
	revenueGrowth?: number;
	earningsGrowth?: number;
	totalRevenue?: number;
	totalCash?: number;
	totalDebt?: number;
	beta?: number;
	fiftyTwoWeekHigh?: number;
	fiftyTwoWeekLow?: number;
	name?: string;
}

/** One per-ticker entry emitted by the bridge. */
export interface BridgeTicker {
	ticker: string;
	name?: string;
	fundamentals?: BridgeFundamentals;
	technicals?: BridgeTechnicals;
	error?: string;
}

/** Top-level JSON document emitted by the bridge. */
export interface BridgeOutput {
	yfinanceVersion?: string;
	tickers: BridgeTicker[];
}

// ---------------------------------------------------------------------------
// yahoo-finance2 client (single shared instance).
// ---------------------------------------------------------------------------

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const QUOTE_MODULES = [
	"summaryDetail",
	"price",
	"financialData",
	"defaultKeyStatistics",
	"summaryProfile",
] as const;

/** Chart interval literals accepted by yahoo-finance2. */
const CHART_INTERVALS = new Set([
	"1m",
	"2m",
	"5m",
	"15m",
	"30m",
	"60m",
	"90m",
	"1h",
	"1d",
	"5d",
	"1wk",
	"1mo",
	"3mo",
]);

type ChartInterval =
	| "1m"
	| "2m"
	| "5m"
	| "15m"
	| "30m"
	| "60m"
	| "90m"
	| "1h"
	| "1d"
	| "5d"
	| "1wk"
	| "1mo"
	| "3mo";

/** Validate a caller-supplied interval string, defaulting to "1d". */
function resolveInterval(interval: string): ChartInterval {
	return CHART_INTERVALS.has(interval) ? (interval as ChartInterval) : "1d";
}

const DAY_MS = 86_400_000;

/**
 * Convert a yfinance-style period string ("1y", "6mo", "5d", "ytd", ...) into a
 * start Date for the chart call. Unknown strings default to one year.
 */
function periodToStartDate(period: string): Date {
	const now = Date.now();
	if (period === "ytd") {
		const d = new Date();
		d.setMonth(0, 1);
		d.setHours(0, 0, 0, 0);
		return d;
	}
	if (period === "max") {
		return new Date(now - 20 * 365 * DAY_MS);
	}
	const m = /^(\d+)(mo|d|y)$/.exec(period);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2];
		if (unit === "d") return new Date(now - n * DAY_MS);
		if (unit === "mo") return new Date(now - n * 30 * DAY_MS);
		return new Date(now - n * 365 * DAY_MS);
	}
	return new Date(now - 365 * DAY_MS);
}

// ---------------------------------------------------------------------------
// Numeric helpers.
// ---------------------------------------------------------------------------

/** Coerce a value to a finite number, else undefined (mirrors python _to_float). */
function toFloat(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	return v;
}

/** Return the first non-empty string among the arguments, else undefined. */
function firstString(...vals: unknown[]): string | undefined {
	for (const v of vals) {
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Technical-analysis math (ported from py/yfinance_fetch.py).
// ---------------------------------------------------------------------------

/** Simple moving average of the last n values (undefined if not enough data). */
function sma(values: number[], n: number): number | undefined {
	if (values.length < n) return undefined;
	const window = values.slice(values.length - n);
	let sum = 0;
	for (const v of window) sum += v;
	return sum / n;
}

/**
 * Full EWM (adjust=false) series for the given alpha. Leading NaN values are
 * skipped (matching pandas seeding at the first non-NaN). Interior NaN values
 * are skipped without resetting the recursion. Returns NaN-filled where no
 * value could be produced (so indexing stays aligned with the input).
 */
function ewmSeries(values: number[], alpha: number): number[] {
	const out: number[] = [];
	let i = 0;
	while (i < values.length && !Number.isFinite(values[i]!)) {
		out.push(NaN);
		i++;
	}
	if (i >= values.length) return out;
	let prev = values[i]!;
	out.push(prev);
	for (i += 1; i < values.length; i++) {
		const v = values[i]!;
		if (!Number.isFinite(v)) {
			out.push(NaN);
			continue;
		}
		prev = alpha * v + (1 - alpha) * prev;
		out.push(prev);
	}
	return out;
}

/** Last value of an EWM (adjust=false) series seeded at the first finite value. */
function ewmLast(values: number[], alpha: number): number | undefined {
	const series = ewmSeries(values, alpha);
	for (let i = series.length - 1; i >= 0; i--) {
		const v = series[i]!;
		if (Number.isFinite(v)) return v;
	}
	return undefined;
}

/** EMA(span=n, adjust=false) last value (undefined if fewer than n points). */
function ema(values: number[], n: number): number | undefined {
	if (values.length < n) return undefined;
	return ewmLast(values, 2 / (n + 1));
}

/** RSI(n) via ewm(alpha=1/n, adjust=false) of gains/losses. */
function rsi(values: number[], n: number): number | undefined {
	if (values.length < n + 1) return undefined;
	const gains: number[] = [NaN];
	const losses: number[] = [NaN];
	for (let i = 1; i < values.length; i++) {
		const d = values[i]! - values[i - 1]!;
		gains.push(d > 0 ? d : 0);
		losses.push(d < 0 ? -d : 0);
	}
	const alpha = 1 / n;
	const avgGain = ewmLast(gains, alpha);
	const avgLoss = ewmLast(losses, alpha);
	if (avgGain === undefined || avgLoss === undefined) return undefined;
	// avg_loss == 0 -> rs undefined (mirrors python replace(0, NaN) -> None).
	if (avgLoss === 0) return undefined;
	const rs = avgGain / avgLoss;
	return 100 - 100 / (1 + rs);
}

/** MACD(line, signal, hist) from EMA12/EMA26 and a 9-period signal. */
function macd(
	values: number[],
): [number | undefined, number | undefined, number | undefined] {
	if (values.length < 35) return [undefined, undefined, undefined];
	const e12 = ewmSeries(values, 2 / 13);
	const e26 = ewmSeries(values, 2 / 27);
	const line = e12.map((v, i) => v - e26[i]!);
	const signal = ewmSeries(line, 2 / 10);
	const li = line.length - 1;
	const lastLine = line[li];
	const lastSignal = signal[li];
	if (lastLine === undefined || lastSignal === undefined) {
		return [undefined, undefined, undefined];
	}
	return [lastLine, lastSignal, lastLine - lastSignal];
}

/** Bollinger bands (n, k): [upper, middle, lower] with population std (ddof=0). */
function bollinger(
	values: number[],
	n: number,
	k: number,
): [number | undefined, number | undefined, number | undefined] {
	if (values.length < n) return [undefined, undefined, undefined];
	const window = values.slice(values.length - n);
	let sum = 0;
	for (const v of window) sum += v;
	const mean = sum / window.length;
	let varSum = 0;
	for (const v of window) varSum += (v - mean) ** 2;
	const sd = Math.sqrt(varSum / window.length);
	return [mean + k * sd, mean, mean - k * sd];
}

/** ATR(n): mean true range over the last n bars (needs n+1 points). */
function atr(
	highs: number[],
	lows: number[],
	closes: number[],
	n: number,
): number | undefined {
	const len = closes.length;
	if (len < n + 1) return undefined;
	let sum = 0;
	for (let i = len - n; i < len; i++) {
		const prevClose = closes[i - 1]!;
		const tr = Math.max(
			highs[i]! - lows[i]!,
			Math.abs(highs[i]! - prevClose),
			Math.abs(lows[i]! - prevClose),
		);
		sum += tr;
	}
	return sum / n;
}

/** [support, resistance] = [min(low last n), max(high last n)]. */
function supportResistance(
	highs: number[],
	lows: number[],
	n: number,
): [number | undefined, number | undefined] {
	if (highs.length === 0) return [undefined, undefined];
	const winH = highs.slice(Math.max(0, highs.length - n));
	const winL = lows.slice(Math.max(0, lows.length - n));
	return [Math.min(...winL), Math.max(...winH)];
}

/** Percentage return over `days` (undefined if not enough data or zero base). */
function pctReturn(values: number[], days: number): number | undefined {
	if (values.length <= days) return undefined;
	const last = values[values.length - 1]!;
	const prev = values[values.length - 1 - days]!;
	if (prev === 0 || !Number.isFinite(prev)) return undefined;
	return (last - prev) / prev;
}

// ---------------------------------------------------------------------------
// Fetching + mapping.
// ---------------------------------------------------------------------------

/** A cleaned OHLCV bar (all OHLC finite; volume may be null). */
interface CleanBar {
	date: Date;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number | null;
}

/**
 * Fetch raw ticker data from Yahoo and compute indicators.
 *
 * For each ticker it calls `quoteSummary` (fundamentals) and `chart` (OHLCV) in
 * parallel, drops NaN rows from the chart quotes, then derives the technical
 * indicators. Per-ticker failures are captured in the `error` field; the call
 * never throws for an individual symbol.
 */
export async function fetchTickers(
	tickers: string[],
	opts?: FetchOptions,
): Promise<BridgeOutput> {
	const period = opts?.period ?? "1y";
	const interval = opts?.interval ?? "1d";
	const period1 = periodToStartDate(period);
	const chartInterval = resolveInterval(interval);

	const results: BridgeTicker[] = [];
	for (const ticker of tickers) {
		results.push(await fetchOne(ticker, period1, chartInterval));
	}
	return { yfinanceVersion: "yahoo-finance2", tickers: results };
}

/** Fetch + map a single ticker. Never throws; records failures in `error`. */
async function fetchOne(
	ticker: string,
	period1: Date,
	interval: ChartInterval,
): Promise<BridgeTicker> {
	const out: BridgeTicker = { ticker };
	try {
		const [summary, chart] = await Promise.all([
			yahoo.quoteSummary(ticker, { modules: [...QUOTE_MODULES] }),
			yahoo.chart(ticker, { period1, interval, return: "array" }),
		]);

		const price = summary.price;
		const detail = summary.summaryDetail;
		const fin = summary.financialData;
		const keys = summary.defaultKeyStatistics;

		// Clean OHLCV: drop rows where open/high/low/close is null.
		const bars: CleanBar[] = [];
		for (const q of chart.quotes ?? []) {
			if (
				q.open == null ||
				q.high == null ||
				q.low == null ||
				q.close == null
			) {
				continue;
			}
			bars.push({
				date: q.date,
				open: q.open,
				high: q.high,
				low: q.low,
				close: q.close,
				volume: q.volume,
			});
		}

		const closes = bars.map((b) => b.close);
		const highs = bars.map((b) => b.high);
		const lows = bars.map((b) => b.low);
		const lastClose = closes.length > 0 ? closes[closes.length - 1] : undefined;

		// ---- Fundamentals ------------------------------------------------
		const marketCap = toFloat(price?.marketCap) ?? toFloat(detail?.marketCap);
		const operatingCashflow = toFloat(fin?.operatingCashflow);
		const freeCashflow = toFloat(fin?.freeCashflow);
		let priceToCashflow: number | undefined;
		if (marketCap && operatingCashflow && operatingCashflow !== 0) {
			priceToCashflow = marketCap / Math.abs(operatingCashflow);
		} else if (marketCap && freeCashflow && freeCashflow !== 0) {
			priceToCashflow = marketCap / Math.abs(freeCashflow);
		}

		const currentPrice = toFloat(price?.regularMarketPrice) ?? lastClose;
		const name = firstString(price?.longName, price?.shortName);

		out.name = name;
		out.fundamentals = {
			symbol: firstString(price?.symbol),
			currency: firstString(price?.currency, detail?.currency),
			currentPrice,
			price: lastClose,
			marketCap,
			trailingPE: toFloat(detail?.trailingPE),
			forwardPE: toFloat(detail?.forwardPE) ?? toFloat(keys?.forwardPE),
			pegRatio: toFloat(detail?.pegRatio) ?? toFloat(keys?.pegRatio),
			priceToBook: toFloat(detail?.priceToBook) ?? toFloat(keys?.priceToBook),
			priceToSalesTrailing12Months: toFloat(
				detail?.priceToSalesTrailing12Months,
			),
			priceToCashflow,
			dividendYield: toFloat(detail?.dividendYield),
			profitMargins:
				toFloat(fin?.profitMargins) ?? toFloat(keys?.profitMargins),
			operatingMargins: toFloat(fin?.operatingMargins),
			returnOnEquity: toFloat(fin?.returnOnEquity),
			returnOnAssets: toFloat(fin?.returnOnAssets),
			revenueGrowth: toFloat(fin?.revenueGrowth),
			earningsGrowth: toFloat(fin?.earningsGrowth),
			totalRevenue: toFloat(fin?.totalRevenue),
			totalCash: toFloat(fin?.totalCash),
			totalDebt: toFloat(fin?.totalDebt),
			beta: toFloat(detail?.beta) ?? toFloat(keys?.beta),
			fiftyTwoWeekHigh: toFloat(detail?.fiftyTwoWeekHigh),
			fiftyTwoWeekLow: toFloat(detail?.fiftyTwoWeekLow),
			name,
		};

		// ---- Technicals --------------------------------------------------
		const [bbUpper, bbMiddle, bbLower] = bollinger(closes, 20, 2);
		const [macdLine, macdSignal, macdHist] = macd(closes);
		const [support, resistance] = supportResistance(highs, lows, 60);

		const recent: BridgeCandle[] = bars.slice(-30).map((b) => ({
			date: b.date.toISOString(),
			open: b.open,
			high: b.high,
			low: b.low,
			close: b.close,
			volume: b.volume ?? undefined,
		}));

		out.technicals = {
			sma20: sma(closes, 20),
			sma50: sma(closes, 50),
			sma200: sma(closes, 200),
			ema12: ema(closes, 12),
			ema26: ema(closes, 26),
			rsi14: rsi(closes, 14),
			macd: macdLine,
			macdSignal,
			macdHist,
			bbUpper,
			bbMiddle,
			bbLower,
			atr14: atr(highs, lows, closes, 14),
			return1d: pctReturn(closes, 1),
			return5d: pctReturn(closes, 5),
			return20d: pctReturn(closes, 20),
			return60d: pctReturn(closes, 60),
			support,
			resistance,
			recent,
		};

		return out;
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		out.error = `${e.name}: ${e.message}`;
		return out;
	}
}
