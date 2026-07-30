/**
 * Legacy single-shot role runner. Each call creates a fresh isolated session,
 * runs one turn, and disposes. The persistent multi-turn equivalent lives in
 * SubAgentPool; the PM-orchestrated equivalent in orchestrator.ts.
 *
 * Parsing helpers (extractJsonBlock / parseReport / parseRecommendation) are
 * shared by all agent execution paths and live here.
 */
import type { AgentReport, AgentRole, Recommendation } from "../types.js";
import type { AppConfig } from "../config/app-config.js";
import {
	ROLE_LABELS,
	datePreamble,
	systemPrompt,
	userMessage,
	type AnalysisContext,
} from "./roles.js";
import { createRoleSession, runSessionTurn } from "./session-factory.js";
import { specialistTools } from "./agent-tools.js";

export interface RunResult {
	role: AgentRole;
	model: string;
	text: string;
	/** Parsed structured payload (report or recommendation), if parseable. */
	parsed?: AgentReport | Partial<Recommendation>;
	error?: string;
	/** Duration in ms. */
	durationMs: number;
}

/** Extract the last fenced ```json block from a model's text. */
export function extractJsonBlock(text: string): string | undefined {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
	if (fence && fence.length > 0) {
		const inner = fence[fence.length - 1]!.replace(
			/^```(?:json)?\s*/i,
			"",
		).replace(/```\s*$/i, "");
		return inner.trim();
	}
	const obj = text.match(/\{[\s\S]*\}\s*$/);
	return obj ? obj[0].trim() : undefined;
}

function tryParseJson(text: string): unknown | undefined {
	const block = extractJsonBlock(text);
	const candidate = block ?? text;
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

/** Normalize a parsed analyst JSON into an AgentReport. */
export function parseReport(
	role: AgentRole,
	model: string,
	text: string,
): AgentReport {
	const raw = tryParseJson(text) as
		| {
				stance?: string;
				confidence?: number;
				keyPoints?: unknown;
				suggestions?: unknown;
		  }
		| undefined;
	const stance = (raw?.stance as AgentReport["stance"]) ?? "neutral";
	const confidence =
		typeof raw?.confidence === "number" && isFinite(raw.confidence)
			? Math.max(0, Math.min(1, raw.confidence))
			: 0.5;
	const keyPoints = Array.isArray(raw?.keyPoints)
		? (raw!.keyPoints as unknown[]).map((x) => String(x))
		: [];
	const suggestions = Array.isArray(raw?.suggestions)
		? (raw!.suggestions as unknown[]).map((x) => String(x))
		: [];
	return {
		role,
		model,
		analysis: stripJsonBlock(text).trim(),
		stance,
		confidence,
		keyPoints,
		suggestions,
	};
}

/** Parse the portfolio-manager's structured output. */
export function parseRecommendation(text: string): Partial<Recommendation> {
	const raw = tryParseJson(text) as Partial<Recommendation> | undefined;
	return raw ?? {};
}

function stripJsonBlock(text: string): string {
	return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
}

const VALID_ACTIONS = [
	"buy",
	"hold",
	"trim",
	"sell",
	"watch",
	"avoid",
] as const;
const VALID_HORIZONS = ["short", "medium", "long"] as const;

type DebateEntry = { round: number; speaker: AgentRole; text: string };

/** Normalize a parsed PM payload into a validated Recommendation. Clamps
 * confidence, normalizes targetWeight (PM sometimes emits 25 for 0.25),
 * drops hallucinated empty-ticker positions. Shared by debate + orchestrator. */
export function normalizeRecommendation(
	pmParsed: Partial<Recommendation>,
	pmText: string,
	ctx: AnalysisContext,
	reports: AgentReport[],
	debate: DebateEntry[],
): Recommendation {
	const positions = (
		Array.isArray(pmParsed.positions) ? pmParsed.positions : []
	).filter((p) => String(p?.ticker ?? "").trim().length > 0);
	return {
		generatedAt: ctx.snapshot.generatedAt,
		objective: ctx.objective,
		marketState: ctx.marketState,
		positions: positions.map((p) => ({
			ticker: String(p?.ticker ?? ""),
			name: p?.name ? String(p.name) : undefined,
			action: (VALID_ACTIONS.includes(
				String(p?.action) as (typeof VALID_ACTIONS)[number],
			)
				? (String(p?.action) as (typeof VALID_ACTIONS)[number])
				: "hold") as Recommendation["positions"][number]["action"],
			confidence:
				typeof p?.confidence === "number" && isFinite(p.confidence)
					? Math.max(0, Math.min(1, p.confidence))
					: 0.5,
			rationale: String(p?.rationale ?? ""),
			targetWeight: (() => {
				const v = p?.targetWeight;
				if (typeof v !== "number" || !isFinite(v)) return undefined;
				return v > 1 ? v / 100 : v;
			})(),
			horizon: (VALID_HORIZONS.includes(
				String(p?.horizon) as (typeof VALID_HORIZONS)[number],
			)
				? (String(p?.horizon) as "short" | "medium" | "long")
				: undefined) as "short" | "medium" | "long" | undefined,
			keyRisks: Array.isArray(p?.keyRisks) ? p.keyRisks.map(String) : [],
		})),
		strategy: String(pmParsed.strategy ?? pmText),
		cashGuidance: pmParsed.cashGuidance
			? String(pmParsed.cashGuidance)
			: undefined,
		warnings: Array.isArray(pmParsed.warnings)
			? pmParsed.warnings.map(String)
			: [],
		reports,
		debate,
		snapshotGeneratedAt: ctx.snapshot.generatedAt,
		portfolioAsOf: ctx.portfolio.asOf,
	};
}

/**
 * Legacy PM question-answering system prompt (used by runRole when a
 * userQuestion is set). The orchestrator uses its own orchestrator prompt.
 */
export function legacyPmQuestionPrompt(ctx: AnalysisContext): string {
	return `${datePreamble(ctx)}\n\n당신은 투자 분석 종합자입니다. 항상 한국어로 답변하라.

## 사용자 소통 원칙 (가장 중요)

당신의 답변은 일반 투자자가 Telegram에서 읽는 것입니다. 반드시 지켜라:

1. **처음 3줄에 핵심 결론** — 사용자가 가장 궁금한 것에 대한 직접 답변. 돌려 말하지 마라.
2. **초등학생도 이해할 수 있는 말** — 주식을 처음 접하는 사람이라고 상상하고 설명하라. 전문 용어 대신 일상적인 비유와 쉬운 표현을 써라.
   - "RSI 46.24" → "힘의 균형 상태. 너무 많이 올린 것도, 너무 많이 떨어진 것도 아니에요"
   - "MACD 히스토그램 음수" → "지금은 내리막 추세예요. 주가가 약해지고 있다는 뜻입니다"
   - "SMA20 이탈" → "최근 20일간 평균보다 가격이 낮아졌어요. 단기적으로 약세라는 뜻이죠"
   - "볼린저밴드 하단" → "가격이 충분히 내려온 구간이라, 더 떨어지기엔 바닥에 가까워요"
3. **요약 먼저, 상세 분석은 뒤에** — "### 핵심 요약" 섹션으로 시작하고, 상세 분석은 별도 섹션.
4. **숫자는 의미와 함께** — 중요한 수치(가격대, 등락률, RSI 등)는 반드시 포함하되, 숫자만 덩그러니 놓지 말고 그 수치가 무슨 의미인지 한 문장으로 풀어 설명하라.
5. **표(table), JSON 금지** — 자연스러운 한국어 문단과 불릿 포인트 사용.
6. **적절한 길이** — 핵심만 간결하게. 분석이 길어지면 사용자가 읽지 않는다.

분석 전 필수 단계 (refresh_market_data 도구 사용):
1. 질문에 언급된 종목의 최신 데이터를 가져와라.
2. 관련 시장 지표를 반드시 함께 가져와라:
   - 한국 주식이면: SOXX(필라델피아 반도체지수), MU(마이크론), NVDA, ^IXIC(나스닥), ^GSPC(S&P500), KRW=X(환율)
   - 미국 주식이면: ^IXIC(나스닥), ^GSPC(S&P500), 관련 섹터 ETF
3. search_ticker로 모르는 종목을 찾아라.

분석 시 반드시 고려할 것 (기술적 분석만으로는 부족):
- 미국 시장 당일/야간 움직임이 한국장 다음날 개장에 미치는 영향 (크로스마켓 시그널)
- 섹터 전체의 방향성 (동종 업종 ETF, 선행지표)
- 환율 방향 (원화 강세=한국 주식 긍정, 약세=부정)
- 시장 심리 (나스닥/S&P 지수 방향, 리스크 온오프)
- 최근 호재/악재 (ADR 상장, 실리 발표, 신제품, 규제 변화 등)
- 밸류에이션 (PER, PBR, PEG 등 기본적 가치)
- 기술적 지표 (RSI, MACD, BB, SMA)는 참고용이며 단독으로 판단 근거로 삼지 마라

절대 금지:
- 매수/매도/트림/홀드/관망 등의 포트폴리오 액션 제안
- 종목 추천, 편입, 비중, 현금 비중 제안
- "포트폴리오", "신규 진입", "분할 매수" 용어
- 표(table), 실행 계획, 단계별 플랜

반드시 할 것:
- 사용자 질문에 대한 종합적 분석 답변 (기술적+기본적+거시적+센티먼트)
- 주가 예측이면: 방향(상승/하락/횡보) + 예상 가격대 + 다각적 근거
- 왜 그렇게 예측했는지 논리적으로 설명 (지표만 나열하지 말고 해석을 곁들여라)
- 자연스러운 한국어 문단`;
}

/**
 * Run a single role's agent session with its assigned model and return the
 * assistant text. Data is passed in-prompt from the cached snapshot — agents
 * fetch on demand via tools. One-shot: session is created and disposed per call.
 */
export async function runRole(
	role: AgentRole,
	ctx: AnalysisContext,
	config: AppConfig,
): Promise<RunResult> {
	const start = Date.now();
	const isQuestionPm =
		role === "portfolio-manager" && Boolean(ctx.userQuestion);
	const handle = await createRoleSession(role, ctx, config, {
		systemPromptBuilder: isQuestionPm
			? legacyPmQuestionPrompt
			: (c: AnalysisContext) => systemPrompt(role, c),
		customTools: specialistTools(() => ctx),
	});
	try {
		let text = await runSessionTurn(
			handle.session,
			userMessage(role, ctx),
			config,
		);
		if (!text) {
			// Reasoning models under load can return null content when throttled — retry once.
			await new Promise((r) => setTimeout(r, 2000));
			text = await runSessionTurn(
				handle.session,
				userMessage(role, ctx),
				config,
			);
		}
		const parsed =
			role === "portfolio-manager"
				? parseRecommendation(text)
				: parseReport(role, handle.modelLabel, text);
		return {
			role,
			model: handle.modelLabel,
			text,
			parsed,
			durationMs: Date.now() - start,
		};
	} finally {
		handle.session.dispose();
	}
}

export { ROLE_LABELS };
