/**
 * Shared domain types for agent-trading-desk.
 * These are the stable schemas consumed by agent consumers (Openclaw, Hermes, etc.).
 */

/** A single brokerage credential profile as stored in ~/.kis-cli/config.yaml. */
export interface BrokerageAccountRef {
	/** Broker: "kis" (Korea Investment) or "toss" (Toss Securities). */
	broker: "kis" | "toss";
	/** Profile name within that broker's config. */
	profile: string;
	/** Display label, e.g. "KIS main (실전)". */
	label?: string;
	/** Whether this is a real (prod) account. */
	paper?: boolean;
}

/** Cash position in a single currency. */
export interface CashPosition {
	currency: "KRW" | "USD" | "HKD" | "JPY" | "CNY" | string;
	/** Cash + buying power amount. */
	amount: number;
	/** Source accounts contributing to this total. */
	sources: Array<{ broker: string; profile: string }>;
}

/** A holding (stock position) aggregated across accounts. */
export interface Holding {
	/** Canonical ticker usable on yfinance, e.g. "005930.KS", "AAPL". */
	ticker: string;
	/** Broker-native symbol, e.g. "005930" (KIS domestic) or "AAPL". */
	symbol: string;
	name?: string;
	market: "KR" | "US" | "HK" | "JP" | "CN" | string;
	currency: "KRW" | "USD" | string;
	/** Total quantity across all accounts. */
	quantity: number;
	/** Average purchase price (per share, in position currency). */
	averagePrice?: number;
	/** Last close / current price if known. */
	lastPrice?: number;
	/** Aggregate cost basis (avgPrice * qty). */
	costBasis?: number;
	/** Per-account breakdown. */
	breakdown: Array<{
		broker: string;
		profile: string;
		quantity: number;
		averagePrice?: number;
	}>;
}

/** Unified read-only portfolio across all linked accounts. */
export interface AggregatedPortfolio {
	/** ISO timestamp the snapshot was taken. */
	asOf: string;
	cash: CashPosition[];
	holdings: Holding[];
	/** Optional valuation totals (when market data present). */
	totals?: {
		/** Sum of cash + holdings market value, per currency. */
		byCurrency: Record<string, number>;
	};
	/** Per-account raw inclusion list. */
	accounts: Array<{
		broker: string;
		profile: string;
		included: boolean;
		error?: string;
	}>;
}

/** Single OHLCV bar. */
export interface Candle {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

/** Fundamental + valuation snapshot for one ticker from yfinance. */
export interface Fundamentals {
	ticker: string;
	/** Current/last price. */
	price?: number;
	currency?: string;
	marketCap?: number;
	/** Valuation multiples. */
	per?: number; // trailingPE
	forwardPer?: number;
	pegRatio?: number;
	pbr?: number; // priceToBook
	psr?: number; // priceToSalesTrailing12Months
	pcr?: number; // priceToCashflow? (approx via freeCashflow when available)
	dividendYield?: number;
	/** Profitability. */
	profitMargin?: number;
	operatingMargin?: number;
	roe?: number;
	roa?: number;
	/** Growth. */
	revenueGrowth?: number;
	earningsGrowth?: number;
	totalRevenue?: number;
	totalCash?: number;
	totalDebt?: number;
	beta?: number;
	fiftyTwoWeekHigh?: number;
	fiftyTwoWeekLow?: number;
}

/** Technical indicator snapshot computed from OHLCV. */
export interface TechnicalIndicators {
	ticker: string;
	/** Moving averages. */
	sma20?: number;
	sma50?: number;
	sma200?: number;
	ema12?: number;
	ema26?: number;
	/** Oscillators. */
	rsi14?: number;
	macd?: number;
	macdSignal?: number;
	macdHist?: number;
	/** Bollinger Bands (20, 2). */
	bbUpper?: number;
	bbMiddle?: number;
	bbLower?: number;
	/** Volatility. */
	atr14?: number;
	/** Recent return windows. */
	return1d?: number;
	return5d?: number;
	return20d?: number;
	return60d?: number;
	/** Support/resistance from recent swing. */
	support?: number;
	resistance?: number;
	/** Last N candles for chart inspection. */
	recent: Candle[];
}

/** Full market snapshot for one ticker — the source of truth. */
export interface TickerSnapshot {
	ticker: string;
	symbol: string;
	name?: string;
	market: "KR" | "US" | "HK" | "JP" | "CN" | string;
	fundamentals?: Fundamentals;
	technicals?: TechnicalIndicators;
	/** When yfinance had no data. */
	error?: string;
}

/** The complete source-of-truth snapshot, fetched once per CLI invocation. */
export interface MarketSnapshot {
	/** ISO timestamp the snapshot was generated. */
	generatedAt: string;
	/** yfinance library version, for traceability. */
	yfinanceVersion?: string;
	/** Tickers requested. */
	requested: string[];
	/** Per-ticker data. */
	tickers: TickerSnapshot[];
	/** Market session state per region. */
	marketState: Record<string, MarketSessionState>;
	/** Cross-market US leading-indicator proxies per Korean ticker (overnight forward signal). */
	leadingIndicators?: Record<
		string,
		Array<{ ticker: string; name: string; relation: string }>
	>;
}

export interface MarketSessionState {
	region: "KR" | "US";
	/** Current local time (ISO). */
	now: string;
	/** "pre" | "open" | "after" | "closed" */
	session: "pre" | "open" | "after" | "closed";
	/** Whether the regular session is currently trading. */
	isOpen: boolean;
	/** Next open (ISO) if currently closed. */
	nextOpen?: string;
	/** Trading day in YYYY-MM-DD. */
	tradingDay?: string;
}

/** Agent role identifiers. */
export type AgentRole =
	| "technical"
	| "fundamental"
	| "news"
	| "bull"
	| "bear"
	| "risk"
	| "reviewer"
	| "portfolio-manager";

/** Assignment of a model (provider+id) to an agent role. */
export interface RoleAssignment {
	role: AgentRole;
	provider: string;
	modelId: string;
}

/** A single agent's structured report. */
export interface AgentReport {
	role: AgentRole;
	model: string;
	/** Free-form analysis the model produced. */
	analysis: string;
	/** The model's stance. */
	stance: "bullish" | "bearish" | "neutral";
	/** Confidence 0..1. */
	confidence: number;
	/** Key concerns or signals. */
	keyPoints: string[];
	/** Suggested action(s). */
	suggestions: string[];
}

/** Final synthesized portfolio recommendation. */
export interface Recommendation {
	/** ISO timestamp. */
	generatedAt: string;
	/** What the user asked for. */
	objective: "portfolio-recommend" | "strategy";
	/** Market state context. */
	marketState: Record<string, MarketSessionState>;
	/** Per-ticker final view with action + sizing. */
	positions: Array<{
		ticker: string;
		name?: string;
		/** "buy" | "hold" | "trim" | "sell" | "watch" | "avoid" */
		action: "buy" | "hold" | "trim" | "sell" | "watch" | "avoid";
		confidence: number;
		rationale: string;
		/** Suggested % of portfolio (0..1) for new adds. */
		targetWeight?: number;
		horizon?: "short" | "medium" | "long";
		keyRisks: string[];
	}>;
	/** Overall strategy narrative for the current time. */
	strategy: string;
	/** Cash / FX guidance. */
	cashGuidance?: string;
	/** Warnings surfaced by risk/reviewer agents. */
	warnings: string[];
	/** Full agent reports (debate trace). */
	reports: AgentReport[];
	/** Rounds of debate captured. */
	debate: Array<{ round: number; speaker: AgentRole; text: string }>;
	/** Data freshness. */
	snapshotGeneratedAt: string;
	portfolioAsOf?: string;
}
