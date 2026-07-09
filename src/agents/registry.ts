import {
	createAgentSession,
	defineTool,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { refreshSnapshot } from "../market/snapshot.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentReport, AgentRole, Recommendation } from "../types.js";
import { getAuthStorage, resolveModel } from "../auth/providers.js";
import { assignmentFor, type AppConfig } from "../config/app-config.js";
import { APP_DIR } from "../config/paths.js";
import {
	ROLE_LABELS,
	systemPrompt,
	userMessage,
	type AnalysisContext,
} from "./roles.js";

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
	// Fallback: last {...} balanced object on its own.
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

/**
 * Run a single role's agent session with its assigned model and return the
 * assistant text. Data is passed in-prompt from the cached snapshot — agents
 * never fetch market data themselves.
 */
/** Extract the last assistant message's text from a session's message history (non-streaming fallback). */
function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | undefined;
		if (m?.role !== "assistant") continue;
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			const texts = c
				.filter(
					(p): p is { type: string; text?: string } =>
						typeof p === "object" &&
						p !== null &&
						(p as { type?: string }).type === "text",
				)
				.map((p) => p.text ?? "");
			if (texts.length) return texts.join("");
		}
	}
	return "";
}

export async function runRole(
	role: AgentRole,
	ctx: AnalysisContext,
	config: AppConfig,
): Promise<RunResult> {
	const start = Date.now();
	const assignment = assignmentFor(config, role) ?? config.defaultModel;
	if (!assignment) {
		throw new Error(
			`No model assigned to role "${role}" and no defaultModel set. Run: td agent assign ${role} <provider> <modelId>`,
		);
	}
	const model = resolveModel(assignment.provider, assignment.modelId);
	if (!model) {
		throw new Error(
			`Model "${assignment.provider}/${assignment.modelId}" (role ${role}) not available. Check: td auth provider list`,
		);
	}

	const authStorage = getAuthStorage();
	const modelRegistry = ModelRegistry.create(authStorage);
	// Isolated agent dir: load NO user extensions/skills so analyst sessions stay clean.
	const isolatedAgentDir = join(APP_DIR, "agent");
	if (!existsSync(isolatedAgentDir))
		mkdirSync(isolatedAgentDir, { recursive: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: isolatedAgentDir,
		systemPromptOverride: () => {
			if (role === "portfolio-manager" && ctx.userQuestion) {
				return `당신은 투자 분석 종합자입니다. 항상 한국어로 답변하라.\n\n절대 금지:\n- 매수/매도/트림/홀드/관망 등의 포트폴리오 액션 제안\n- 종목 추천, 편입, 비중, 현금 비중 제안\n- "포트폴리오", "신규 진입", "분할 매수" 용어\n- 표(table), 실행 계획, 단계별 플랜\n\n반드시 할 것:\n- 사용자 질문에 대한 분석적 답변만 작성\n- 주가 예측이면: 방향(상승/하락/횡보) + 예상 가격대 + 근거 지표\n- 자연스러운 한국어 문단 (표/JSON 금지)`;
			}
			return systemPrompt(role);
		},
	});

	// Auto-refresh if snapshot is stale (>10 min).
	const FRESH_MS = 10 * 60 * 1000;
	const snapAge = Date.now() - new Date(ctx.snapshot.generatedAt).getTime();
	if (snapAge > FRESH_MS) {
		try {
			const fresh = await refreshSnapshot([...Object.keys(ctx.tickersByYahoo), "KRW=X"], {
				period: "1y",
			});
			for (const t of fresh.tickers) ctx.tickersByYahoo[t.ticker] = t;
			ctx.snapshot = fresh;
		} catch {
			/* keep cached */
		}
	}
	await resourceLoader.reload();

	// Agent-callable tool: refresh market data on demand.
	const refreshTool = defineTool({
		name: "refresh_market_data",
		label: "최신 시장 데이터 조회",
		description:
			"시장 데이터가 오래되었거나 실시간 변동이 의심되면 호출하여 최신 주가/기술지표를 가져옵니다. 한국장 폐장 후 미국장/야간선물 움직임, 급변 상황 등에서 사용하세요.",
		parameters: Type.Object({
			tickers: Type.Optional(
				Type.Array(Type.String(), {
					description: "조회할 티커 (생략 시 전체)",
				}),
			),
		}),
		execute: async (_id: string, params: { tickers?: string[] }) => {
			try {
				const allTickers = params.tickers ?? Object.keys(ctx.tickersByYahoo);
				if (allTickers.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "조회할 티커가 없습니다." },
						],
						details: {},
					};
				}
				const snap = await refreshSnapshot(allTickers, { period: "1y" });
				for (const t of snap.tickers) ctx.tickersByYahoo[t.ticker] = t;
				const lines = snap.tickers.map((t) => {
					const f = t.fundamentals;
					const tc = t.technicals;
					return `${t.name ?? t.ticker} (${t.ticker}): 가격=${f?.price ?? "?"} 1d=${tc?.return1d !== undefined ? (tc.return1d * 100).toFixed(2) + "%" : "?"} 5d=${tc?.return5d !== undefined ? (tc.return5d * 100).toFixed(2) + "%" : "?"} RSI=${tc?.rsi14?.toFixed(1) ?? "?"}`;
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `최신 시장 데이터 (${snap.generatedAt}):\n${lines.join("\n")}`,
						},
					],
					details: {} as Record<string, unknown>,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `데이터 갱신 실패: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: {},
				};
			}
		},
	});

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "medium",
		authStorage,
		modelRegistry,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		customTools: [refreshTool],
	});

	let text = "";
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
	});

	// Per-call timeout guard: a single slow/stuck model must not sink the run.
	const perCallTimeoutMs =
		(config as AppConfig & { perCallTimeoutMs?: number }).perCallTimeoutMs ??
		300_000; // 5 min — thinking models need more time
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			session.abort();
		} catch {
			/* ignore */
		}
	}, perCallTimeoutMs);
	try {
		await session.prompt(userMessage(role, ctx));
	} catch (err) {
		clearTimeout(timer);
		unsubscribe();
		session.dispose();
		return {
			role,
			model: `${assignment.provider}/${assignment.modelId}`,
			text,
			error: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - start,
		};
	}
	clearTimeout(timer);
	// Fallback: if no text_delta events fired (non-streaming completion), pull
	// the final assistant text from the session message history.
	if (!text) text = lastAssistantText(session.messages);
	unsubscribe();
	session.dispose();
	if (timedOut) {
		return {
			role,
			model: `${assignment.provider}/${assignment.modelId}`,
			text,
			error: `timed out after ${perCallTimeoutMs}ms`,
			durationMs: Date.now() - start,
		};
	}

	const modelLabel = `${assignment.provider}/${assignment.modelId}`;
	const parsed =
		role === "portfolio-manager"
			? parseRecommendation(text)
			: parseReport(role, modelLabel, text);

	return {
		role,
		model: modelLabel,
		text,
		parsed,
		durationMs: Date.now() - start,
	};
}

export { ROLE_LABELS };
