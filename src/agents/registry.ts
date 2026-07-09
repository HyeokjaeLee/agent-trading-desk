import {
	createAgentSession,
	defineTool,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import YahooFinance from "yahoo-finance2";
import { refreshSnapshot } from "../market/snapshot.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
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

const yahoo = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

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
				return `당신은 투자 분석 종합자입니다. 항상 한국어로 답변하라.\n\n분석 전 필수 단계 (refresh_market_data 도구 사용):\n1. 질문에 언급된 종목의 최신 데이터를 가져와라.\n2. 관련 시장 지표를 반드시 함께 가져와라:\n   - 한국 주식이면: SOXX(필라델피아 반도체지수), MU(마이크론), NVDA, ^IXIC(나스닥), ^GSPC(S&P500), KRW=X(환율)\n   - 미국 주식이면: ^IXIC(나스닥), ^GSPC(S&P500), 관련 섹터 ETF\n3. search_ticker로 모르는 종목을 찾아라.\n\n분석 시 반드시 고려할 것 (기술적 분석만으로는 부족):\n- 미국 시장 당일/야간 움직임이 한국장 다음날 개장에 미치는 영향 (크로스마켓 시그널)\n- 섹터 전체의 방향성 (동종 업종 ETF, 선행지표)\n- 환율 방향 (원화 강세=한국 주식 긍정, 약세=부정)\n- 시장 심리 (나스닥/S&P 지수 방향, 리스크 온오프)\n- 최근 호재/악재 (ADR 상장, 실리 발표, 신제품, 규제 변화 등)\n   ↑ 이런 정보를 알아보려면 search_ticker로 관련 종목을 찾고 refresh_market_data로 데이터를 가져와 분석하라\n- 밸류에이션 (PER, PBR, PEG 등 기본적 가치)\n- 기술적 지표 (RSI, MACD, BB, SMA)는 참고용이며 단독으로 판단 근거로 삼지 마라\n\n절대 금지:\n- 매수/매도/트림/홀드/관망 등의 포트폴리오 액션 제안\n- 종목 추천, 편입, 비중, 현금 비중 제안\n- "포트폴리오", "신규 진입", "분할 매수" 용어\n- 표(table), 실행 계획, 단계별 플랜\n\n반드시 할 것:\n- 사용자 질문에 대한 종합적 분석 답변 (기술적+기본적+거시적+센티먼트)\n- 주가 예측이면: 방향(상승/하락/횡보) + 예상 가격대 + 다각적 근거\n- 왜 그렇게 예측했는지 논리적으로 설명 (지표만 나열하지 말고 해석을 곁들여라)\n- 자연스러운 한국어 문단 (표/JSON 금지)`;
			}
			return systemPrompt(role);
		},
	});

	// Note: snapshot staleness is already checked in buildAnalysisContext (pipeline.ts).
	// The refresh_market_data tool is available for agents to fetch on demand.
	void refreshSnapshot;
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

	// Agent-callable tool: search ticker by company name.
	const searchTickerTool = defineTool({
		name: "search_ticker",
		label: "종목 검색",
		description:
			"회사명이나 키워드로 주식 티커를 검색한다. 한국 주식(삼성전자→005930.KS)과 미국 주식(Apple→AAPL) 모두 검색 가능. refresh_market_data로 데이터를 가져오기 전에 티커를 확인해야 할 때 사용.",
		parameters: Type.Object({
			query: Type.String({
				description: "회사명 또는 키워드 (예: 삼성전자, 카카오, Apple, NVIDIA)",
			}),
		}),
		execute: async (_id: string, params: { query: string }) => {
			try {
				const results = await yahoo.search(params.query, {
					quotesCount: 5,
					newsCount: 0,
				});
				const lines = (results.quotes ?? []).map((q) => {
					const qy = q as {
						symbol?: string;
						shortname?: string;
						longname?: string;
						exchange?: string;
						quoteType?: string;
					};
					return `${qy.shortname ?? qy.longname ?? "?"} → ${qy.symbol} [${qy.exchange ?? "?"}] (${qy.quoteType ?? "?"})`;
				});
				if (lines.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `검색 결과 없음: "${params.query}"`,
							},
						],
						details: {},
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `검색 결과 (${params.query}):
${lines.join("\n")}`,
						},
					],
					details: {},
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text" as const,
							text: `검색 실패: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: {},
				};
			}
		},
	});

	// Agent-callable tool: get user portfolio (CLI only, blocked in Telegram bot).
	const getPortfolioTool = defineTool({
		name: "get_portfolio",
		label: "내 계좌 조회",
		description: "사용자의 실제 보유 종목, 현금(원화/달러), 평가 금액을 조회한다. 질문이 포트폴리오 분석, 집중도, 비중 조정과 관련된 경우에만 사용하라. READ-ONLY — 주문/매매 불가.",
		parameters: Type.Object({}),
		execute: async () => {
			try {
				const portfolio = await aggregatePortfolio(ctx.config.accounts);
				ctx.portfolio = portfolio;
				const cashLines = portfolio.cash.map((c) => `${c.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${c.currency}`);
				const holdingLines = portfolio.holdings.map((h) =>
					`${h.name ?? h.ticker}: ${h.quantity}주 @${h.averagePrice ?? "?"} ${h.currency} (${h.broker}/${h.breakdown.length}계좌)`);
				return {
					content: [{ type: "text" as const, text: `계좌 현황 (${portfolio.asOf}):\n현금: ${cashLines.join(", ") || "없음"}\n보유 종목:\n${holdingLines.join("\n") || "없음"}` }],
					details: {} as Record<string, unknown>,
				};
			} catch (e) {
				return { content: [{ type: "text" as const, text: `계좌 조회 실패: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
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
		customTools: ctx.allowAccountAccess
			? [refreshTool, searchTickerTool, getPortfolioTool]
			: [refreshTool, searchTickerTool],
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
