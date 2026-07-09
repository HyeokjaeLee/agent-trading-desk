import type {
	AgentReport,
	AgentRole,
	AggregatedPortfolio,
	Fundamentals,
	MarketSnapshot,
	MarketSessionState,
	TechnicalIndicators,
	TickerSnapshot,
} from "../types.js";
import type { AppConfig } from "../config/app-config.js";

export const ROLE_LABELS: Record<AgentRole, string> = {
	technical: "Technical Analyst",
	fundamental: "Fundamental Analyst",
	news: "News & Sentiment Analyst",
	bull: "Bull Researcher",
	bear: "Bear Researcher",
	risk: "Risk Manager",
	reviewer: "Judgment Reviewer",
	"portfolio-manager": "Portfolio Manager",
};

/** Shared analysis context passed to every role. */
export interface AnalysisContext {
	objective: "portfolio-recommend" | "strategy";
	marketState: Record<string, MarketSessionState>;
	portfolio: AggregatedPortfolio;
	snapshot: MarketSnapshot;
	/** Ticker lookup from the snapshot. */
	tickersByYahoo: Record<string, TickerSnapshot>;
	news?: Array<{
		title: string;
		summary: string;
		url?: string;
		date: string;
		region: "KR" | "US";
		weight: { pricedIn: boolean; active: boolean; reason: string };
	}>;
	/** Why news was unavailable (degraded mode), so the news analyst can explain it. */
	newsReason?: string;
	priorReports?: AgentReport[];
	debateHistory?: Array<{ round: number; speaker: AgentRole; text: string }>;
	config: AppConfig;
	/** Backtest mode: hide anything that reveals realized outcomes. */
	blind?: boolean;
	/** Prior decision memory digest (same-ticker history) injected for reflection. */
	priorDecisions?: string;
}

/** Render a compact portfolio digest. */
function portfolioDigest(p: AggregatedPortfolio): string {
	const cash =
		p.cash
			.map(
				(c) =>
					`${c.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${c.currency}`,
			)
			.join(", ") || "none";
	const holdings =
		p.holdings
			.map(
				(h) =>
					`${h.ticker}(${h.symbol}) ${h.quantity}@${h.averagePrice ?? "?"} ${h.currency}`,
			)
			.join(", ") || "none";
	return `Cash: ${cash}\nHoldings: ${holdings}\nAccounts: ${p.accounts.map((a) => `${a.broker}/${a.profile}${a.included ? "" : "❌"}`).join(", ")}`;
}

/** Render a compact per-ticker data digest (fundamentals + technicals). */
function tickerDigest(t: TickerSnapshot): string {
	const f: Partial<Fundamentals> = t.fundamentals ?? {};
	const tc: Partial<TechnicalIndicators> = t.technicals ?? {};
	const fv = (v?: number) =>
		v === undefined ? "n/a" : Number.isFinite(v) ? v.toFixed(2) : "n/a";
	const rows = [
		`price=${fv(f.price)} mcap=${fv((f.marketCap ?? 0) / 1e9)}B`,
		`PER=${fv(f.per)}/${fv(f.forwardPer)} PBR=${fv(f.pbr)} PSR=${fv(f.psr)} PCR=${fv(f.pcr)} PEG=${fv(f.pegRatio)}`,
		`margin: net=${fv(f.profitMargin)} op=${fv(f.operatingMargin)} ROE=${fv(f.roe)}`,
		`growth: rev=${fv(f.revenueGrowth)} eps=${fv(f.earningsGrowth)}`,
		`52w: ${fv(f.fiftyTwoWeekLow)}-${fv(f.fiftyTwoWeekHigh)} beta=${fv(f.beta)}`,
		`TA: RSI=${fv(tc.rsi14)} MACD=${fv(tc.macd)}/${fv(tc.macdSignal)} (hist ${fv(tc.macdHist)})`,
		`SMA20/50/200=${fv(tc.sma20)}/${fv(tc.sma50)}/${fv(tc.sma200)}`,
		`BB[${fv(tc.bbLower)},${fv(tc.bbMiddle)},${fv(tc.bbUpper)}] ATR=${fv(tc.atr14)}`,
		`ret 1d/5d/20d/60d=${fv(tc.return1d)}/${fv(tc.return5d)}/${fv(tc.return20d)}/${fv(tc.return60d)}`,
		`S/R=${fv(tc.support)}/${fv(tc.resistance)}`,
	];
	return rows.join("\n      ");
}

/** Render the data digest for all tickers in the snapshot. */
export function snapshotDigest(
	ctx: AnalysisContext,
	onlyTickers?: string[],
): string {
	const targets = onlyTickers ?? Object.keys(ctx.tickersByYahoo);
	if (targets.length === 0) return "(no ticker data — run `td market refresh`)";
	const parts = targets.map((ticker) => {
		const t = ctx.tickersByYahoo[ticker];
		if (!t) return `${ticker}: (missing)`;
		const head = `${t.ticker} ${t.name ?? ""} [${t.market}]${t.error ? ` ERROR:${t.error}` : ""}`;
		if (t.error) return head;
		return `${head}\n      ${tickerDigest(t)}`;
	});
	const li = leadingIndicatorsDigest(ctx);
	return parts.join("\n   ") + (li ? `\n   ${li}` : "");
}

/** Render US leading-indicator proxies for Korean tickers (overnight forward signal). */
function leadingIndicatorsDigest(ctx: AnalysisContext): string | undefined {
	const map = ctx.snapshot.leadingIndicators;
	if (!map) return undefined;
	const krClosed = !ctx.marketState.KR?.isOpen;
	const lines: string[] = [];
	for (const [krTicker, proxies] of Object.entries(map)) {
		const moves = proxies
			.map((p) => {
				const s = ctx.tickersByYahoo[p.ticker];
				if (!s) return `${p.ticker}(n/a)`;
				const tc = s.technicals;
				return `${p.ticker} ${fmtPct(tc?.return1d)}1d/${fmtPct(tc?.return5d)}5d@${s.fundamentals?.price ?? "?"}`;
			})
			.join(", ");
		const note = krClosed
			? `KR market CLOSED → these US overnight moves are an ACTIVE forward signal for ${krTicker}'s next open`
			: `reference (KR open: US moves largely priced in for ${krTicker})`;
		lines.push(`${krTicker} leading indicators (US): ${moves} — ${note}`);
	}
	return lines.length
		? "LEADING INDICATORS (cross-market):\n      " + lines.join("\n      ")
		: undefined;
}

function fmtPct(v: number | undefined): string {
	if (v === undefined || !isFinite(v)) return "?";
	return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}

function marketStateDigest(ctx: AnalysisContext): string {
	return Object.values(ctx.marketState)
		.map(
			(s) =>
				`${s.region}: ${s.session}${s.isOpen ? "(OPEN)" : "(closed)"} tradingDay=${s.tradingDay ?? "?"}${s.nextOpen ? ` nextOpen=${s.nextOpen}` : ""}`,
		)
		.join("\n   ");
}

function newsDigest(ctx: AnalysisContext): string {
	if (!ctx.news || ctx.news.length === 0) {
		return ctx.newsReason
			? `(no news fetched — ${ctx.newsReason})`
			: "(no news fetched)";
	}
	return ctx.news
		.map(
			(n, i) =>
				`[${i + 1}] (${n.date}, ${n.region}, ${n.weight.active ? "ACTIVE" : "pricedIn"}) ${n.title}\n      ${n.summary}${n.weight.reason ? `\n      → ${n.weight.reason}` : ""}`,
		)
		.join("\n   ");
}

/** Common output-format instruction appended to every analyst. */
export const REPORT_FORMAT = `Respond with a concise analysis, then finish with a fenced JSON block EXACTLY matching:
\`\`\`json
{"stance":"bullish"|"bearish"|"neutral","confidence":0.0-1.0,"keyPoints":[...],"suggestions":[...]}
\`\`\`
Do not request tools you do not have. Base every claim ONLY on the provided snapshot/account/news data. Never invent prices, ratios, or dates.`;

const BLIND_NOTE = (ctx: AnalysisContext) =>
	ctx.blind
		? `\n\n[BACKTEST/BLIND MODE] You do NOT have access to any market data after the snapshot date. Reason strictly from the snapshot provided. Do not claim knowledge of outcomes that occurred after the snapshot timestamp.`
		: "";

/** Build the system prompt for a role. */
export function systemPrompt(role: AgentRole): string {
	const common = `You are a senior investment analyst operating inside a multi-agent investment desk. You are ONE specialist on a team that will debate to a consensus. Be rigorous, evidence-based, and concise. Cite the specific metric you used (e.g. "RSI14=72 → overbought"). Use the data given; if data is missing, say so rather than guessing.`;
	switch (role) {
		case "technical":
			return `${common} Your specialty: TECHNICAL ANALYSIS. Use every available method — trend (SMA20/50/200, EMA), momentum (RSI14, MACD/hist, rate-of-change via return windows), volatility (Bollinger Band position & width, ATR), volume, support/resistance, and chart structure from the recent candles. Identify trend direction, key levels, and momentum divergences. Translate signals into a directional view.`;
		case "fundamental":
			return `${common} Your specialty: FUNDAMENTAL & VALUATION ANALYSIS. Use PBR, PER (trailing & forward), PSR, PCR, PEG, profitability margins, ROE/ROA, revenue & earnings growth, balance-sheet strength (cash, debt, debt-to-equity), and dividend yield. Assess intrinsic value vs market price and whether the stock is cheap/expensive relative to quality and growth.`;
		case "news":
			return `${common} Your specialty: NEWS & SENTIMENT and MARKET TIMING. Apply the priced-in principle strictly: if a market is OPEN on the news date, treat the news as already reflected (reference only); if a market is CLOSED (overnight/weekend/pre-open) and the news is directional, weight it as an ACTIVE signal likely to move the next open. Each news item is tagged ACTIVE or pricedIn — honor that tag.`;
		case "bull":
			return `${common} Your specialty: the BULL CASE. Argue the strongest evidence-based bullish thesis for the portfolio/additions using ALL analyst reports. Steelman the upside. Acknowledge but counter bear points. Be specific about catalysts and price targets.`;
		case "bear":
			return `${common} Your specialty: the BEAR CASE. Argue the strongest evidence-based bearish thesis using ALL analyst reports. Surface overvaluation, deteriorating fundamentals, breakdowns, crowding, and macro/FX risks. Challenge overconfidence.`;
		case "risk":
			return `${common} Your specialty: RISK MANAGEMENT. Evaluate concentration (single-name, sector), position sizing vs the cash available (KRW & USD), FX exposure, drawdown risk (ATR, beta, distance to support), liquidity, and correlation. Translate risk into sizing guardrails. Never recommend exceeding sensible single-position and total-equity limits. You may veto reckless proposals.`;
		case "reviewer":
			return `${common} Your specialty: ADVERSARIAL JUDGMENT REVIEW (devil's advocate). Challenge the team's synthesis for: stale data, assumptions contradicted by the snapshot, news that is actually priced-in but treated as active (or vice-versa), overnight gaps already moved, overconfidence, and missing contrary evidence. Flag specifically what would invalidate the thesis.`;
		case "portfolio-manager":
			return `${common} You are the PORTFOLIO MANAGER and moderator. Synthesize the analyst reports, the bull/bear debate, the risk assessment, and the judgment review into a FINAL decision for the current time and market state. For each relevant ticker give: action (buy|hold|trim|sell|watch|avoid), confidence (0-1), rationale, optional targetWeight (fraction of portfolio) and horizon, and keyRisks. Then give an overall strategy narrative + cash/FX guidance for the current session. This is READ-ONLY advice — no order execution.`;
		default:
			return common;
	}
}

/** Build the user message (context) for a role. */
export function userMessage(role: AgentRole, ctx: AnalysisContext): string {
	const memory = ctx.priorDecisions
		? `\n\nPRIOR DECISIONS (for reflection — do not blindly repeat):\n   ${ctx.priorDecisions}`
		: "";
	const head = `OBJECTIVE: ${ctx.objective === "portfolio-recommend" ? "recommend stocks to add to the portfolio" : "current-time response strategy"}\n\nMARKET STATE:\n   ${marketStateDigest(ctx)}\n\nCURRENT PORTFOLIO:\n   ${portfolioDigest(ctx.portfolio)}\n\nTICKER DATA (source of truth, fetched once):\n   ${snapshotDigest(ctx)}${BLIND_NOTE(ctx)}${memory}`;

	if (role === "news") {
		return `${head}\n\nNEWS:\n   ${newsDigest(ctx)}\n\nProduce your news & sentiment report.\n${REPORT_FORMAT}`;
	}

	if (role === "bull" || role === "bear") {
		const reports = (ctx.priorReports ?? [])
			.map(
				(r) =>
					`### ${ROLE_LABELS[r.role]} [${r.stance}, conf ${r.confidence}]\n${r.analysis.slice(0, 700)}\nkey: ${r.keyPoints.join("; ")}\nsuggest: ${r.suggestions.join("; ")}`,
			)
			.join("\n\n");
		return `${head}\n\nANALYST REPORTS:\n${reports}\n\nProduce your ${role.toUpperCase()} case referencing the reports above. Run ${ctx.config.debateRounds} rounds mentally; here is the prior debate if any:\n${(ctx.debateHistory ?? []).map((d) => `[R${d.round} ${d.speaker}] ${d.text}`).join("\n") || "(first round)"}\n${REPORT_FORMAT}`;
	}

	if (role === "risk" || role === "reviewer") {
		const reports = (ctx.priorReports ?? [])
			.map(
				(r) => `### ${ROLE_LABELS[r.role]} [${r.stance}, conf ${r.confidence}]`,
			)
			.join("\n");
		const debate = (ctx.debateHistory ?? [])
			.map((d) => `[R${d.round} ${d.speaker}] ${d.text}`)
			.join("\n");
		return `${head}\n\nTEAM OUTPUT:\n${reports}\n\nDEBATE:\n${debate}\n\nProduce your ${ROLE_LABELS[role]} assessment.\n${REPORT_FORMAT}`;
	}

	if (role === "portfolio-manager") {
		const reports = (ctx.priorReports ?? [])
			.map(
				(r) =>
					`### ${ROLE_LABELS[r.role]} [${r.stance}, conf ${r.confidence}]\n${r.analysis.slice(0, 700)}\nsuggest: ${r.suggestions.join("; ")}`,
			)
			.join("\n\n");
		const debate = (ctx.debateHistory ?? [])
			.map((d) => `[R${d.round} ${d.speaker}] ${d.text}`)
			.join("\n");
		return `${head}\n\nFINAL SYNTHESIS INPUTS:\n${reports}\n\nDEBATE:\n${debate}\n\nProduce the FINAL portfolio decision. End with a fenced JSON block EXACTLY matching:
\`\`\`json
{"positions":[{"ticker":"","name":"","action":"buy|hold|trim|sell|watch|avoid","confidence":0.0,"rationale":"","targetWeight":0.0,"horizon":"short|medium|long","keyRisks":[]}],"strategy":"","cashGuidance":"","warnings":[]}
\`\`\``;
	}

	// technical / fundamental
	return `${head}\n\nProduce your ${ROLE_LABELS[role]} report.\n${REPORT_FORMAT}`;
}

export const ALL_ROLES: AgentRole[] = [
	"technical",
	"fundamental",
	"news",
	"bull",
	"bear",
	"risk",
	"reviewer",
	"portfolio-manager",
];
