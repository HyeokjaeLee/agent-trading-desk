/**
 * Map broker-native symbols to yfinance tickers and detect market region.
 *
 * KIS domestic codes are 6-digit (e.g. 005930 = Samsung Electronics).
 *   - KOSPI → ".KS", KOSDAQ → ".KQ"
 *   - Heuristic: KOSPI/KOSDAQ distinction requires a lookup, but for analysis
 *     purposes the exchange suffix rarely changes yfinance data availability.
 *     We default to .KS and fall back to .KQ on error.
 * Overseas symbols (US/HK/JP/CN) are passed through; market detected by pattern.
 */

export interface MappedTicker {
	/** yfinance ticker, e.g. "005930.KS", "AAPL". */
	ticker: string;
	/** Original broker symbol. */
	symbol: string;
	market: "KR" | "US" | "HK" | "JP" | "CN";
	/** Alternate yfinance ticker to try if the first fails (KR .KS↔.KQ). */
	altTicker?: string;
}

/** Classify a symbol into a market region. */
export function detectMarket(symbol: string): MappedTicker["market"] {
	const s = symbol.trim().toUpperCase();
	// US tickers: 1-5 letters, no dot, no digits (mostly)
	if (/^[A-Z.]{1,6}$/.test(s) && !s.includes(".")) {
		return "US";
	}
	// 6-digit numeric → Korean domestic
	if (/^\d{6}$/.test(symbol)) {
		return "KR";
	}
	// HK: 4-5 digits; JP: 4 digits; CN: 6 digits with .SS/.SZ — these come qualified.
	return "US";
}

/** Map a broker symbol + market to a yfinance ticker. */
export function mapToYahoo(symbol: string, market?: string): MappedTicker {
	const m = (
		market ?? detectMarket(symbol)
	).toUpperCase() as MappedTicker["market"];
	switch (m) {
		case "KR": {
			// 6-digit Korean code → .KS primary, .KQ fallback
			const code = symbol.padStart(6, "0");
			return {
				ticker: `${code}.KS`,
				symbol: code,
				market: "KR",
				altTicker: `${code}.KQ`,
			};
		}
		case "US":
			return {
				ticker: symbol.toUpperCase(),
				symbol: symbol.toUpperCase(),
				market: "US",
			};
		case "HK": {
			const num = symbol.replace(/\.HK$/i, "").padStart(4, "0");
			return { ticker: `${num}.HK`, symbol, market: "HK" };
		}
		case "JP": {
			const num = symbol.replace(/\.T$/i, "");
			return { ticker: `${num}.T`, symbol, market: "JP" };
		}
		case "CN": {
			// Shanghai .SS, Shenzhen .SZ — caller should pass qualified symbol
			if (
				symbol.toUpperCase().endsWith(".SS") ||
				symbol.toUpperCase().endsWith(".SZ")
			) {
				return { ticker: symbol.toUpperCase(), symbol, market: "CN" };
			}
			return { ticker: `${symbol}.SS`, symbol, market: "CN" };
		}
		default:
			return { ticker: symbol, symbol, market: "US" };
	}
}

/** Convert a yfinance ticker back to a broker symbol. */
export function yahooToSymbol(ticker: string): {
	symbol: string;
	market: string;
} {
	if (ticker.endsWith(".KS") || ticker.endsWith(".KQ")) {
		return { symbol: ticker.replace(/\.(KS|KQ)$/, ""), market: "KR" };
	}
	if (ticker.endsWith(".HK"))
		return { symbol: ticker.replace(/\.HK$/, ""), market: "HK" };
	if (ticker.endsWith(".T"))
		return { symbol: ticker.replace(/\.T$/, ""), market: "JP" };
	return { symbol: ticker, market: ticker.includes(".") ? "CN" : "US" };
}

export const MARKET_FOR_REGION: Record<"KR" | "US", MappedTicker["market"][]> =
	{
		KR: ["KR"],
		US: ["US"],
	};
