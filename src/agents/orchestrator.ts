/**
 * PM-orchestrated pipeline. The Portfolio Manager is the main agent: it reads
 * the question, decides which specialists to delegate to, dispatches them
 * (in parallel where possible), reviews their reports, re-queries as needed,
 * and synthesizes the final answer.
 *
 * Specialists live in a persistent SubAgentPool — each keeps its session for
 * the whole conversation, so follow-up questions reuse accumulated context.
 * Parallel dispatch (consult_specialists) runs distinct specialists at once
 * for latency.
 *
 * Delegation is MANDATORY: after MAX_DELEGATION_ATTEMPTS re-prompts the PM must
 * have consulted at least one specialist, otherwise the run fails — an answer
 * with zero specialist input is a degradation, not a valid conclusion.
 */
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentReport, AgentRole, Recommendation } from "../types.js";
import type { AppConfig } from "../config/app-config.js";
import {
	ROLE_LABELS,
	datePreamble,
	snapshotDigest,
	portfolioDigest,
	marketStateDigest,
	userMessage,
	type AnalysisContext,
} from "./roles.js";
import { createRoleSession, runSessionTurn } from "./session-factory.js";
import {
	createRefreshTool,
	createSearchTickerTool,
	createGetPortfolioTool,
	createDiscoverProxiesTool,
} from "./agent-tools.js";
import { SubAgentPool } from "./sub-agent-pool.js";
import { normalizeRecommendation, parseRecommendation } from "./registry.js";
import type { AnalysisOutcome } from "./debate.js";

/** Specialists the PM may delegate to. */
export const SPECIALIST_ROLES: AgentRole[] = [
	"technical",
	"fundamental",
	"news",
	"bull",
	"bear",
	"risk",
	"reviewer",
];

const SPECIALIST_ROSTER = [
	"technical: 기술 분석 (추세 SMA/EMA, 모멘텀 RSI/MACD, 변동성 BB/ATR, 지지/저항)",
	"fundamental: 기본적·밸류에이션 (PER/PBR/PSR/PCR/PEG, ROE, 수익·이익 성장, 재무 건전성)",
	"news: 뉴스·센티먼트 (priced-in 원칙 — 개장 중 뉴스=반영됨, 폐장 중 방향성=ACTIVE 시그널)",
	"bull: 강세 시나리오 (모든 보고서 기반 상승 논리 steelman)",
	"bear: 약세 시나리오 (과대평가·펀더멘탈 악화·리스크 부각)",
	"risk: 리스크 관리 (집중도/사이징/FX/낙폭/유동성)",
	"reviewer: 적대적 검토 devil's advocate (데이터 노후·과신·반대 증거)",
].join("\n");

/** PM orchestrator system prompt: date/time + delegation mandate + roster. */
export function orchestratorSystemPrompt(ctx: AnalysisContext): string {
	return `${datePreamble(ctx)}

당신은 다중 에이전트 투자 데스크의 **메인 오케스트레이터(포트폴리오 매니저)**다. 스스로 모든 분석을 하지 마라 — 반드시 전문가 서브에이전트들에게 작업을 위임하고, 그 보고를 종합해 최종 결론을 내라. 전문가 위임 없이 답하는 것은 금지다.

## 전문가 서브에이전트 (도구로 호출)
${SPECIALIST_ROSTER}

### 사용 가능한 도구
- refresh_market_data: 최신 시장 데이터 조회
- search_ticker: 종목명→티커 검색
- get_portfolio: 내 계좌 조회 (CLI만)
- discover_proxies: **연관주 자동 발견** — 새 종목의 해외 연관주·선행지표를 추론하여 proxy-map에 추가. 이미 매핑된 섹터(반도체)는 자동으로 연관주가 제공되지만, 새 섹터(배터리, 바이오 등) 종목을 다룰 때 반드시 discover_proxies로 연관주를 찾아 추가하라.
- consult_specialist / consult_specialists: 전문가에게 위임
## 작동 원칙 (절대 준수)
1. **위임 필수**: 질문을 분석해 필요한 전문가를 결정하라. 단순 조회도 최소 1명, 복합 분석은 여러 명에게 위임. 전문가 보고 없는 최종 답은 무효다.
2. **병렬 활용**: 여러 전문가가 필요하면 consult_specialists(역할 배열)로 한 번에 병렬 위임하라 — 실행 시간이 크게 줄어든다.
3. **재질문**: 보고가 불충분하면 같은 전문가에게 consult_specialist로 추가 질문하라. 전문가 세션은 유지되어 이전 맥락을 기억한다.
4. **데이터 최신화**: 스냅샷이 오래되었거나 실시간 변동이 의심되면 refresh_market_data로 최신화한 뒤 위임하라. 모르는 종목은 search_ticker로 찾아라.
5. **종합**: 모든 보고를 취합해 최종 결론. 의견 충돌 시 근거가 강한 쪽을 채택하고 이유를 밝혀라.

## 숫자 표시 규칙
- 영문 약자(K/M) 금지, 정확한 숫자: 100,000
- 화폐 단위 필수: 278,000원, $217.64 (한국=원, 미국=달러)
- 백분율은 소수점 첫째 자리: 12.3%

READ-ONLY — 주문 실행 불가. 항상 한국어로 답하라.`;
}

/** Delegate to a single specialist session (persistent across the conversation). */
function createConsultSpecialistTool(pool: SubAgentPool): ToolDefinition {
	return defineTool({
		name: "consult_specialist",
		label: "전문가 위임",
		description:
			"특정 전문가 서브에이전트에게 분석을 위임하고 보고를 받는다. 역할: technical, fundamental, news, bull, bear, risk, reviewer. 같은 전문가에게 여러 번 호출하면 세션이 유지되어 이전 맥락을 기억한다. 보고가 불충분하면 추가 질문으로 재위임하라.",
		parameters: Type.Object({
			role: Type.String({
				description:
					"전문가 역할 (technical|fundamental|news|bull|bear|risk|reviewer)",
			}),
			question: Type.String({
				description: "전문가에게 할 질문/위임 내용. 구체적일수록 좋다.",
			}),
		}),
		execute: async (_id, params: { role: string; question: string }) => {
			const role = params.role as AgentRole;
			if (!SPECIALIST_ROLES.includes(role)) {
				return textResult(
					`알 수 없는 역할: "${params.role}". 가능: ${SPECIALIST_ROLES.join(", ")}`,
				);
			}
			try {
				const report = await pool.consult(role, params.question);
				return textResult(formatReport(report));
			} catch (e) {
				return textResult(
					`위임 실패 (${role}): ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** Delegate to several specialists at once — they run in parallel. */
function createConsultSpecialistsTool(pool: SubAgentPool): ToolDefinition {
	return defineTool({
		name: "consult_specialists",
		label: "전문가 병렬 위임",
		description:
			"여러 전문가에게 동시에 위임한다. 각 전문가가 병렬로 실행되어 시간이 단축된다. 광범위한 분석이 필요할 때 사용하라. 역할 배열과 공통 질문을 받는다.",
		parameters: Type.Object({
			roles: Type.Array(Type.String(), {
				description:
					'전문가 역할 배열 (예: ["technical","fundamental","news"])',
			}),
			question: Type.String({
				description: "모든 전문가에게 할 공통 위임 내용.",
			}),
		}),
		execute: async (_id, params: { roles: string[]; question: string }) => {
			const roles = params.roles.filter((r): r is AgentRole =>
				SPECIALIST_ROLES.includes(r as AgentRole),
			);
			if (roles.length === 0) {
				return textResult(
					`유효한 역할 없음. 가능: ${SPECIALIST_ROLES.join(", ")}`,
				);
			}
			try {
				const reports = await pool.consultBatch(roles, params.question);
				return textResult(
					`${reports.length}명의 전문가 보고 (병렬 실행):\n\n${reports
						.map(formatReport)
						.join("\n\n---\n\n")}`,
				);
			} catch (e) {
				return textResult(
					`병렬 위임 실패: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** PM's first message: objective/question + data context + delegation reminder. */
function orchestratorUserMessage(ctx: AnalysisContext): string {
	const mode = ctx.userQuestion
		? `사용자 질문: "${ctx.userQuestion}"\nOBJECTIVE: 이 질문에 답하라. 매수/매도/비중 같은 포트폴리오 액션 제안이 아니다.`
		: `OBJECTIVE: ${
				ctx.objective === "portfolio-recommend"
					? "recommend stocks to add to the portfolio"
					: "current-time response strategy"
			}`;
	const conv = (ctx as unknown as { conversationHistory?: string })
		.conversationHistory;
	const outputRule = ctx.userQuestion
		? "질문 답변 모드: 자연스러운 한국어 문단으로 답하라 (표/JSON 금지)."
		: '권고 모드: 종료 시 아래 JSON 블록을 정확히 출력하라:\n```json\n{"positions":[{"ticker":"","name":"","action":"buy|hold|trim|sell|watch|avoid","confidence":0.0,"rationale":"","targetWeight":0.0,"horizon":"short|medium|long","keyRisks":[]}],"strategy":"","cashGuidance":"","warnings":[]}\n```';
	return [
		mode,
		"",
		"MARKET STATE:",
		`   ${marketStateDigest(ctx)}`,
		"",
		"CURRENT PORTFOLIO:",
		`   ${portfolioDigest(ctx.portfolio)}`,
		"",
		"TICKER DATA (source of truth, fetched once):",
		`   ${snapshotDigest(ctx)}`,
		conv ? `\nPRIOR CONVERSATION (이전 대화 맥락):\n${conv}` : "",
		"",
		"## 지시",
		"위 데이터를 참고하되, 본 분석은 스스로 하지 말고 전문가 서브에이전트에게 위임하라. 질문 성격에 맞춰 필요한 전문가를 consult_specialist (단일) 또는 consult_specialists (병렬)로 호출하라. 보고를 종합해 최종 답변/권고를 작성하라.",
		"",
		outputRule,
	]
		.filter(Boolean)
		.join("\n");
}

export interface OrchestratorOutcome {
	text: string;
	reports: AgentReport[];
	recommendation: Recommendation;
	/** Whether the PM actually delegated to at least one specialist. */
	delegated: boolean;
}

/** Options: inject a long-lived pool (Telegram cross-message reuse) and/or
 *  fake session/turn functions for tests. */
export interface OrchestratorOptions {
	pool?: SubAgentPool;
	createSession?: typeof createRoleSession;
	runTurn?: typeof runSessionTurn;
	/** Dispose the pool at the end (default true). Set false for a shared pool. */
	disposePool?: boolean;
}

const MAX_DELEGATION_ATTEMPTS = 3;

/** Run the PM-orchestrated pipeline. PM delegates to persistent specialists.
 * Throws if the PM refuses to delegate after MAX_DELEGATION_ATTEMPTS — a
 * zero-specialist answer is a degraded failure, not a valid conclusion. */
export async function runOrchestrator(
	ctx: AnalysisContext,
	config: AppConfig,
	opts?: OrchestratorOptions,
): Promise<OrchestratorOutcome> {
	const ownsPool = !opts?.pool;
	const pool =
		opts?.pool ??
		new SubAgentPool(ctx, config, {
			createSession: opts?.createSession,
			runTurn: opts?.runTurn,
		});
	const pmTools: ToolDefinition[] = [
		createConsultSpecialistTool(pool),
		createConsultSpecialistsTool(pool),
		createRefreshTool(() => ctx),
		createSearchTickerTool(() => ctx),
		...(ctx.allowAccountAccess ? [createGetPortfolioTool(() => ctx)] : []),
		// discover_proxies: PM auto-discovers overseas peers for new sectors (offline-gated inside the tool).
		createDiscoverProxiesTool(() => ctx),
	];
	// A reused (Telegram) pool must start each run fresh — don't synthesize a new
	// answer from the previous message's specialist reports.
	pool.resetForRun();
	const handle = await (opts?.createSession ?? createRoleSession)(
		"portfolio-manager",
		ctx,
		config,
		{ systemPromptBuilder: orchestratorSystemPrompt, customTools: pmTools },
	);
	const run = opts?.runTurn ?? runSessionTurn;

	try {
		let text = await run(handle.session, orchestratorUserMessage(ctx), config);
		// Delegation guard: re-prompt until the PM actually consults a specialist.
		for (let i = 0; i < MAX_DELEGATION_ATTEMPTS && !pool.delegated; i++) {
			text = await run(
				handle.session,
				"위임 없이 답했다. 반드시 consult_specialist 또는 consult_specialists 도구로 최소 한 명의 전문가에게 위임한 뒤, 그 보고를 종합해 최종 답을 다시 내라. 전문가 보고 없는 답은 무효다.",
				config,
			);
		}
		// Mandatory delegation: a zero-specialist conclusion is a degraded failure.
		if (!pool.delegated) {
			throw new Error(
				"PM이 전문가 서브에이전트에게 위임하지 않고 답을 종료했다 (재시도 한도 초과). 위임 없는 결론은 허용되지 않는다.",
			);
		}
		const pmParsed = parseRecommendation(text);
		const recommendation = normalizeRecommendation(
			pmParsed,
			text,
			ctx,
			pool.reports,
			[],
		);
		return { text, reports: pool.reports, recommendation, delegated: true };
	} finally {
		handle.session.dispose();
		if (opts?.disposePool !== false && ownsPool) pool.dispose();
	}
}

function formatReport(r: AgentReport): string {
	const head = `### ${ROLE_LABELS[r.role]} [${r.stance}, 신뢰도 ${(r.confidence * 100).toFixed(0)}%] (${r.model})`;
	const kp = r.keyPoints.length ? `\n핵심: ${r.keyPoints.join("; ")}` : "";
	const sg = r.suggestions.length ? `\n제안: ${r.suggestions.join("; ")}` : "";
	return `${head}\n${r.analysis}${kp}${sg}`;
}

function textResult(text: string): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
} {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export type { AnalysisOutcome };
export { userMessage };
