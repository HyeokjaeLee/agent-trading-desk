/**
 * yfinance bridge wrapper.
 *
 * This is the ONLY code path that triggers Yahoo data fetching: it invokes the
 * python subprocess (`py/yfinance_fetch.py`) which calls yfinance. The result is
 * fetched ONCE per invocation and cached by the snapshot layer.
 *
 * No TS code imports yfinance or talks to Yahoo directly — all network access
 * goes through this subprocess.
 */
import { spawnSync } from "node:child_process";

import { yfinanceScriptPath } from "../config/paths.js";

/** Options forwarded to the python bridge. */
export interface FetchOptions {
	/** yfinance history period, e.g. "1y". Defaults to "1y". */
	period?: string;
	/** yfinance history interval, e.g. "1d". Defaults to "1d". */
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

/** Top-level JSON document emitted by the bridge to stdout. */
export interface BridgeOutput {
	yfinanceVersion?: string;
	tickers: BridgeTicker[];
}

/**
 * Fetch raw ticker data from the python yfinance bridge.
 *
 * Spawns `python3 py/yfinance_fetch.py --stdin`, feeds
 * `{tickers, period, interval}` on stdin, and parses stdout as JSON.
 * Throws a clear error (including stderr/stdout) on spawn failure, non-zero
 * exit, or unparsable output.
 *
 * Returns the raw bridge document; domain mapping happens in the snapshot layer.
 */
export function fetchTickers(
	tickers: string[],
	opts?: FetchOptions,
): BridgeOutput {
	const period = opts?.period ?? "1y";
	const interval = opts?.interval ?? "1d";
	const script = yfinanceScriptPath();
	const payload = JSON.stringify({ tickers, period, interval });

	const proc = spawnSync("python3", [script, "--stdin"], {
		input: payload,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});

	const stderr = proc.stderr ?? "";
	const stdout = proc.stdout ?? "";

	if (proc.error) {
		throw new Error(
			`yfinance bridge failed to spawn: ${proc.error.message}` +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}
	if (proc.status === null) {
		throw new Error(
			`yfinance bridge terminated by signal ${proc.signal ?? "unknown"}` +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}
	if (proc.status !== 0) {
		throw new Error(
			`yfinance bridge exited with code ${proc.status}` +
				(stdout ? `\n--- stdout ---\n${stdout}` : "") +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		throw new Error(
			`yfinance bridge produced non-JSON output: ${(err as Error).message}` +
				`\n--- stdout ---\n${stdout}` +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}

	return validateBridgeOutput(parsed, stderr);
}

/** Validate and narrow the parsed bridge document into BridgeOutput. */
function validateBridgeOutput(parsed: unknown, stderr: string): BridgeOutput {
	if (!parsed || typeof parsed !== "object") {
		throw new Error(
			`yfinance bridge returned a non-object document` +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}
	const doc = parsed as Record<string, unknown>;
	if (!Array.isArray(doc.tickers)) {
		const msg =
			typeof doc.error === "string" ? doc.error : "missing 'tickers' array";
		throw new Error(
			`yfinance bridge output invalid: ${msg}` +
				(stderr ? `\n--- stderr ---\n${stderr}` : ""),
		);
	}
	const version =
		typeof doc.yfinanceVersion === "string" ? doc.yfinanceVersion : undefined;
	return {
		...(version ? { yfinanceVersion: version } : {}),
		tickers: doc.tickers as BridgeTicker[],
	};
}
