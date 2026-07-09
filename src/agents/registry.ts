import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "off",
		authStorage,
		modelRegistry,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
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
		150_000;
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
