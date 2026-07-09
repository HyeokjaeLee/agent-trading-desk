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
	/** Pre-computed News analyst report (when news runs via browser-use merge). */
	newsReport?: AgentReport;
	/** Raw news items found by browser-use (for reuse / other digests). */
	newsItems?: Array<{
		title: string;
		summary: string;
		url?: string;
		date: string;
		region: "KR" | "US";
		weight: { pricedIn: boolean; active: boolean; reason: string };
	}>;
	priorReports?: AgentReport[];
	debateHistory?: Array<{ round: number; speaker: AgentRole; text: string }>;
	config: AppConfig;
	/** Backtest mode: hide anything that reveals realized outcomes. */
	blind?: boolean;
	/** Prior decision memory digest (same-ticker history) injected for reflection. */
	priorDecisions?: string;
	/** User's free-form question (for td ask). */
	userQuestion?: string;
	/** Tax/regulatory context (separate block, auto-refreshed). */
	taxContext?: string;
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
					`${h.name ?? h.ticker}(${h.ticker}) ${h.quantity}주 @${h.averagePrice ?? "?"} ${h.currency}`,
			)
			.join(", ") || "none";
	return `Cash: ${cash}\nHoldings: ${holdings}\nAccounts: ${p.accounts.map((a) => `${a.broker}/${a.profile}${a.included ? "" : "❌"}`).join(", ")}`;
}

/** Render FX (USD/KRW) data with trend + interpretation for stock analysis. */
function fxDigest(ctx: AnalysisContext): string {
	const fx = ctx.tickersByYahoo["KRW=X"];
	if (!fx || !fx.fundamentals?.price) return "";
	const tc: Partial<TechnicalIndicators> = fx.technicals ?? {};
	const rate = fx.fundamentals.price;
	const r1d = tc.return1d;
	const r5d = tc.return5d;
	const r20d = tc.return20d;
	const r60d = tc.return60d;
	const rsi = tc.rsi14;
	const pct = (v?: number) =>
		v === undefined ? "?" : (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
	// Interpretation: KRW weakening (rate rising) = negative for Korean stocks
	const trend5d =
		r5d !== undefined && r5d > 0.005
			? "원화 약세 (한국 주식 부정적)"
			: r5d !== undefined && r5d < -0.005
				? "원화 강세 (한국 주식 긍정적)"
				: "원화 보합";
	const trend20d =
		r20d !== undefined && r20d > 0.01
			? "중기 원화 약세"
			: r20d !== undefined && r20d < -0.01
				? "중기 원화 강세"
				: "중기 보합";
	return (
		`환율(USD/KRW): ${rate.toLocaleString("en-US", { maximumFractionDigits: 1 })}원 ` +
		`(1d=${pct(r1d)} 5d=${pct(r5d)} 20d=${pct(r20d)} 60d=${pct(r60d)}) ` +
		`RSI=${rsi?.toFixed(1) ?? "?"} → ${trend5d}, ${trend20d}`
	);
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
	const common = `You are a senior investment analyst operating inside a multi-agent investment desk. 항상 한국어로 답변하라. 추론 과정이나 분석 단계를 나열하지 말고, 최종 결론만 간결하게 전달하라. Be rigorous, evidence-based, and concise. Cite the specific metric you used.\n\n숫자 표시 규칙 (절대 준수):\n- 100K, 1M 같은 영문 약자 사용 금지. 정확한 숫자로 표시: 100,000\n- 모든 금액에 화폐 단위 필수 표시: 278,000원, $217.64\n- 한국 주식 = 원(원/원화/KRW), 미국 주식 = 달러($/USD). 절대 혼동 금지.\n- 백분율은 소수점 첫째 자리까지: 12.3%\n\n시장 데이터가 오래되었거나 실시간 변동(미국장/야간선물)이 감지되면 refresh_market_data 도구를 호출하여 최신 데이터를 가져온 후 분석하라.`;
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
			return `${common} You are the FINAL SYNTHESIZER. 두 가지 모드가 있다:\n1. 포트폴리오 권고 모드: 종목별 액션(buy|hold|trim|sell|watch|avoid), 신뢰도, 근거, 핵심 리스크를 JSON으로 제시하라.\n2. 질문 답변 모드: 사용자의 질문에 직접 답하라. 포트폴리오 매매 권고가 아니다. 질문이 주가 예측이면 예측 방향과 근거를, 세법 질문이면 세법 답변을, 시장 전망이면 전망을 제시하라. 어떤 모드인지는 사용자 메시지에 명시된다. READ-ONLY — no order execution.`;
		default:
			return common;
	}
}

/** Build the user message (context) for a role. */
export function userMessage(role: AgentRole, ctx: AnalysisContext): string {
	const memory = ctx.priorDecisions
		? `\n\nPRIOR DECISIONS (for reflection — do not blindly repeat):\n   ${ctx.priorDecisions}`
		: "";
	const tax = ctx.taxContext
		? `\n\n세법/규제 컨텍스트 (별도 블록 — 세금·계좌 관련 결정 시 반드시 참고):\n${ctx.taxContext}`
		: "";
	const conv = (ctx as unknown as { conversationHistory?: string })
		.conversationHistory;
	const convBlock = conv ? `\n\nPRIOR CONVERSATION:\n${conv}` : "";
	const fx = fxDigest(ctx);
	const fxBlock = fx
		? `\n\n환율 정보 (투자 분석에 반드시 참고):\n   ${fx}`
		: "";
	const koreanName = `\n\nIMPORTANT: 사용자에게 결과를 전달할 때는 종목 코드(ticker)보다 해당 상품의 이름(예: 삼성전자, KODEX 미국나스닥100)을 우선 사용하라.`;

	let head: string;

	// Question-answering mode: put the QUESTION first, skip empty portfolio.
	if (ctx.userQuestion) {
		const portfolioSection =
			ctx.portfolio.holdings.length > 0
				? `\n\nCURRENT PORTFOLIO:\n   ${portfolioDigest(ctx.portfolio)}`
				: "";
		head = `사용자 질문: "${ctx.userQuestion}"\n\nOBJECTIVE: 이 질문에 직접 답변하라. 포트폴리오 권고가 목표가 아니라, 사용자의 질문에 최선의 답을 제시하는 것이 목표다.\n\nMARKET STATE:\n   ${marketStateDigest(ctx)}\n\nTICKER DATA:\n   ${snapshotDigest(ctx)}${portfolioSection}${fxBlock}${BLIND_NOTE(ctx)}${memory}${tax}${convBlock}${koreanName}`;
	}

	// Portfolio mode (original): objective + full context.
	const obj =
		ctx.objective === "portfolio-recommend"
			? "recommend stocks to add to the portfolio"
			: "current-time response strategy";
	head = `OBJECTIVE: ${obj}\n\nMARKET STATE:\n   ${marketStateDigest(ctx)}\n\nCURRENT PORTFOLIO:\n   ${portfolioDigest(ctx.portfolio)}\n\nTICKER DATA (source of truth, fetched once):\n   ${snapshotDigest(ctx)}${fxBlock}${BLIND_NOTE(ctx)}${memory}${tax}${convBlock}${koreanName}`;

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
		if (ctx.userQuestion) {
			return `${head}\n\n분석가 보고서:\n${reports}\n\n토론:\n${debate}\n\n위 보고서를 참고하여 다음 질문에 ONLY 답변하라:\n"${ctx.userQuestion}"\n\n규칙:\n1. 매수/매도/트림/비중/현금/편입/추천 등의 포트폴리오 관리 답변 절대 금지\n2. 표(table), JSON, 실행 계획 금지\n3. 주가 예측이면: 방향(상승/하락/횡보) + 예상 가격대 + 근거 지표만 답변\n4. 한국어 자연스러운 문단으로 작성`;
		}
		return `${head}\n\nFINAL SYNTHESIS INPUTS:\n${reports}\n\nDEBATE:\n${debate}\n\nProduce the FINAL portfolio decision. End with a fenced JSON block EXACTLY matching:\n\`\`\`json\n{"positions":[{"ticker":"","name":"","action":"buy|hold|trim|sell|watch|avoid","confidence":0.0,"rationale":"","targetWeight":0.0,"horizon":"short|medium|long","keyRisks":[]}],"strategy":"","cashGuidance":"","warnings":[]}\n\`\`\``;
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

/**
 * Merged News-analyst task for browser-use: persona + investment context +
 * priced-in principle + JSON schema. browser-use browses, applies the
 * priced-in rule, and returns a structured News report in one pass.
 */
export function newsAnalystTask(ctx: AnalysisContext): string {
	const kr = ctx.marketState.KR;
	const us = ctx.marketState.US;
	const holdings =
		ctx.portfolio.holdings
			.map(
				(h) =>
					`${h.ticker} (${h.name ?? h.symbol}, ${h.market}, ${h.currency})`,
			)
			.join(", ") || "(none)";
	return [
		systemPrompt("news"),
		"",
		`TODAY: ${ctx.snapshot.generatedAt}`,
		`MARKET STATE: KR ${kr?.session}${kr?.isOpen ? " (OPEN)" : " (closed)"} | US ${us?.session}${us?.isOpen ? " (OPEN)" : " (closed)"}`,
		`HOLDINGS: ${holdings}`,
		"",
		"TASK: Use the browser to find the 3-8 most recent (last 7 days) market-moving news for these holdings. For Korean names, also check US overnight leaders (e.g. SOXX/SMH/MU/NVDA for Samsung/SK Hynix).",
		"Apply the priced-in principle strictly: if the relevant market is OPEN on the news date, mark pricedIn=true (reference only); if the market is CLOSED and the news is directional, mark pricedIn=false, active=true (forward signal for the next open).",
		ctx.blind
			? "[BLIND/BACKTEST] Do not claim knowledge of outcomes after the snapshot date."
			: "",
		"",
		"Return ONLY a single JSON object (no prose outside it) with EXACTLY this shape:",
		"```json",
		JSON.stringify(
			{
				analysis: "<your news & sentiment analysis, concise>",
				stance: "bullish|bearish|neutral",
				confidence: 0.0,
				keyPoints: ["..."],
				suggestions: ["..."],
				newsItems: [
					{
						title: "",
						summary: "",
						url: "",
						date: "ISO",
						region: "KR|US",
						pricedIn: true,
						active: false,
					},
				],
			},
			null,
			2,
		),
		"```",
	]
		.filter(Boolean)
		.join("\n");
}
