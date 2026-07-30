/**
 * Agent-callable tools, extracted as factories so every agent session (legacy
 * runRole, the persistent SubAgentPool, and the PM orchestrator) shares one
 * implementation. Tools take a ctx GETTER (not a snapshot) so a long-lived
 * session whose pool context is refreshed (Telegram follow-ups) always reads
 * the latest snapshot/date/offline state.
 *
 * Offline mode (ctx.offline) blocks EVERY network path — refresh, search, and
 * account aggregation all refuse and return only the locked ctx data, so a
 * backtest/E2E run cannot reach the live internet.
 */
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import YahooFinance from "yahoo-finance2";
import { refreshSnapshot } from "../market/snapshot.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
import {
	loadProxyMap,
	saveProxyMap,
	findCategory,
	addProxy,
	type ProxyEntry,
} from "../market/proxy-store.js";
import { reloadProxyMap } from "../market/proxies.js";
import type { AnalysisContext } from "./roles.js";

type CtxGetter = () => AnalysisContext;

/** Shared Yahoo client for ticker search. validation noise suppressed. */
const yahoo = new YahooFinance({
	suppressNotices: ["yahooSurvey"],
	validation: { logErrors: false, logOptionsErrors: false },
});

/** Serialize live refreshes so parallel specialists can't interleave network
 * fetches and write half-overlapping snapshots into the shared ctx. */
let refreshChain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
	const run = refreshChain.then(task, task);
	refreshChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** refresh_market_data — fetch latest fundamentals/technicals on demand. */
export function createRefreshTool(getCtx: CtxGetter): ToolDefinition {
	return defineTool({
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
		execute: async (_id, params: { tickers?: string[] }) => {
			const ctx = getCtx();
			const allTickers = params.tickers ?? Object.keys(ctx.tickersByYahoo);
			if (allTickers.length === 0) return textResult("조회할 티커가 없습니다.");
			if (ctx.offline) {
				const locked = allTickers
					.map((tk) => ctx.tickersByYahoo[tk])
					.filter(Boolean)
					.map(
						(t) =>
							`${t!.name ?? t!.ticker} (${t!.ticker}): 오프라인 — 잠긴 스냅샷만 사용 가능`,
					);
				return textResult(
					`오프라인 모드: 실시간 조회가 차단되었다. 잠긴 스냅샷(시점 ${ctx.snapshot?.generatedAt ?? "?"}) 데이터만 사용하라.\n${locked.join("\n")}`,
				);
			}
			try {
				const snap = await serialized(() =>
					refreshSnapshot(allTickers, { period: "1y" }),
				);
				for (const t of snap.tickers) ctx.tickersByYahoo[t.ticker] = t;
				const lines = snap.tickers.map((t) => {
					const f = t.fundamentals;
					const tc = t.technicals;
					return `${t.name ?? t.ticker} (${t.ticker}): 가격=${f?.price ?? "?"} 1d=${tc?.return1d !== undefined ? (tc.return1d * 100).toFixed(2) + "%" : "?"} 5d=${tc?.return5d !== undefined ? (tc.return5d * 100).toFixed(2) + "%" : "?"} RSI=${tc?.rsi14?.toFixed(1) ?? "?"}`;
				});
				return textResult(
					`최신 시장 데이터 (${snap.generatedAt}):\n${lines.join("\n")}`,
				);
			} catch (e) {
				return textResult(
					`데이터 갱신 실패: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** search_ticker — resolve a company name to its ticker symbol. */
export function createSearchTickerTool(getCtx: CtxGetter): ToolDefinition {
	return defineTool({
		name: "search_ticker",
		label: "종목 검색",
		description:
			"회사명이나 키워드로 주식 티커를 검색한다. 한국 주식(삼성전자→005930.KS)과 미국 주식(Apple→AAPL) 모두 검색 가능. refresh_market_data로 데이터를 가져오기 전에 티커를 확인해야 할 때 사용.",
		parameters: Type.Object({
			query: Type.String({
				description: "회사명 또는 키워드 (예: 삼성전자, 카카오, Apple, NVIDIA)",
			}),
		}),
		execute: async (_id, params: { query: string }) => {
			const ctx = getCtx();
			if (ctx.offline) {
				return textResult(
					`오프라인 모드: 실시간 종목 검색이 차단되었다. 잠긴 스냅샷의 종목만 사용 가능: ${Object.keys(ctx.tickersByYahoo).join(", ") || "없음"}`,
				);
			}
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
				if (lines.length === 0)
					return textResult(`검색 결과 없음: "${params.query}"`);
				return textResult(`검색 결과 (${params.query}):\n${lines.join("\n")}`);
			} catch (e) {
				return textResult(
					`검색 실패: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** get_portfolio — read-only aggregated account snapshot (CLI only). */
export function createGetPortfolioTool(getCtx: CtxGetter): ToolDefinition {
	return defineTool({
		name: "get_portfolio",
		label: "내 계좌 조회",
		description:
			"사용자의 실제 보유 종목, 현금(원화/달러), 평가 금액을 조회한다. 질문이 포트폴리오 분석, 집중도, 비중 조정과 관련된 경우에만 사용하라. READ-ONLY — 주문/매매 불가.",
		parameters: Type.Object({}),
		execute: async () => {
			const ctx = getCtx();
			if (ctx.offline) {
				return textResult(
					`오프라인 모드: 실시간 계좌 조회가 차단되었다. 잠긴 포트폴리오(시점 ${ctx.portfolio?.asOf ?? "?"})만 사용 가능.`,
				);
			}
			try {
				const portfolio = await aggregatePortfolio(ctx.config.accounts);
				ctx.portfolio = portfolio;
				const cashLines = portfolio.cash.map(
					(c) =>
						`${c.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${c.currency}`,
				);
				const holdingLines = portfolio.holdings.map(
					(h) =>
						`${h.name ?? h.ticker}: ${h.quantity}주 @${h.averagePrice ?? "?"} ${h.currency} (${h.breakdown.length} accounts)`,
				);
				return textResult(
					`계좌 현황 (${portfolio.asOf}):\n현금: ${cashLines.join(", ") || "없음"}\n보유 종목:\n${holdingLines.join("\n") || "없음"}`,
				);
			} catch (e) {
				return textResult(
					`계좌 조회 실패: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** Lowercase a category description into a slug id (ascii/digits/hyphens only). */
function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** discover_proxies — PM reasons about a new sector's overseas peers/leaders,
 *  validates them via yfinance search, and persists a new proxy-map category.
 *  Skips tickers already mapped; refuses offline. */
export function createDiscoverProxiesTool(getCtx: CtxGetter): ToolDefinition {
	return defineTool({
		name: "discover_proxies",
		label: "연관주 자동 발견",
		description:
			"특정 종목의 해외 연관주·선행지표를 추론하고 검색하여 proxy-map에 자동 추가한다. 새 섹터(배터리, 바이오, 자동차 등) 종목을 분석할 때 사용하라. 이미 매핑된 종목은 재검색하지 않는다.",
		parameters: Type.Object({
			ticker: Type.String({
				description: "분석 대상 종목 (예: 373220.KS = LG에너지솔루션)",
			}),
			categoryDescription: Type.String({
				description: "카테고리 설명 (예: Korean battery stocks)",
			}),
			suggestions: Type.Array(
				Type.Object({
					keyword: Type.String({
						description:
							"yfinance 검색 키워드 (예: lithium battery ETF, Tesla, CATL)",
					}),
					relation: Type.String({
						description: "왜 연관있는지 (예: Global EV battery peer)",
					}),
				}),
			),
		}),
		execute: async (
			_id,
			params: {
				ticker: string;
				categoryDescription: string;
				suggestions: Array<{ keyword: string; relation: string }>;
			},
		) => {
			const ctx = getCtx();
			if (ctx.offline) {
				return textResult(
					"오프라인 모드: discover_proxies 실시간 검색이 차단되었다. 잠긴 스냅샷 데이터만 사용하라.",
				);
			}
			const { ticker, categoryDescription, suggestions } = params;
			try {
				const map = loadProxyMap();
				// Skip if already mapped AND refreshed within 7 days.
				const existingCat = findCategory(map, ticker, undefined, undefined);
				const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
				if (existingCat) {
					const lastRefresh = existingCat.lastRefreshedAt
						? new Date(existingCat.lastRefreshedAt).getTime()
						: 0;
					const ageMs = Date.now() - lastRefresh;
					if (ageMs < REFRESH_INTERVAL_MS) {
						const daysLeft = Math.ceil((REFRESH_INTERVAL_MS - ageMs) / (24 * 60 * 60 * 1000));
						return textResult(
							`${ticker}는 이미 proxy-map에 매핑되어 있다 (카테고리: ${existingCat.id}). 마지막 갱신으로부터 ${Math.ceil(ageMs / (24 * 60 * 60 * 1000))}일 경과. ${daysLeft}일 후 재검색 가능.`,
						);
					}
					// 7일 경과 — 기존 매핑에 새 제안 추가 (기존 것 유지)
				}
				const categoryId = slugify(categoryDescription) || "discovered";
				// Validate each suggestion via yfinance search; pick the best result.
				const discovered: ProxyEntry[] = [];
				for (const s of suggestions) {
					try {
						const res = await yahoo.search(s.keyword, {
							quotesCount: 5,
							newsCount: 0,
						});
						const quotes = (res.quotes ?? []).filter((q) => {
							const qt = (q as { quoteType?: string }).quoteType;
							return qt === "EQUITY" || qt === "ETF";
						});
						const pool = quotes.length > 0 ? quotes : (res.quotes ?? []);
						const best = pool[0] as
							| { symbol?: string; shortname?: string; longname?: string }
							| undefined;
						if (best?.symbol) {
							discovered.push({
								ticker: best.symbol,
								name: best.shortname ?? best.longname ?? best.symbol,
								relation: s.relation,
							});
						}
					} catch {
						/* skip a suggestion that fails to resolve */
					}
				}
				if (discovered.length === 0) {
					return textResult(
						`${ticker}의 연관주를 검색하지 못했다. 제안 키워드를 다시 확인하라.`,
					);
				}
				// Create the category if absent; ensure the ticker is a match member.
				let cat = map.categories.find((c) => c.id === categoryId);
				if (!cat) {
					cat = {
						id: categoryId,
						description: categoryDescription,
						matchTickers: [ticker],
						matchKeywords: [],
						proxies: [],
					};
					map.categories.push(cat);
				} else if (!cat.matchTickers.includes(ticker)) {
					cat.matchTickers.push(ticker);
				}
				for (const d of discovered) addProxy(map, categoryId, d);
				// Stamp the refresh time so the 7-day cooldown timer resets.
				const refreshedCat = map.categories.find((c) => c.id === categoryId);
				if (refreshedCat) refreshedCat.lastRefreshedAt = new Date().toISOString();
				saveProxyMap(map);
				reloadProxyMap(); // refresh the in-memory cache (proxies.ts cachedMap)
				const lines = discovered.map(
					(d) => `${d.ticker} — ${d.name} (${d.relation})`,
				);
				return textResult(
					`${ticker} 연관주 ${discovered.length}개를 발견해 카테고리 "${categoryId}"에 추가했다:\n${lines.join("\n")}`,
				);
			} catch (e) {
				return textResult(
					`연관주 발견 실패: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		},
	});
}

/** Standard data + account tools for a specialist session. Account tool gated.
 *  Takes a getter so a refreshed pool context propagates to live tool calls. */
export function specialistTools(getCtx: CtxGetter): ToolDefinition[] {
	const base = [createRefreshTool(getCtx), createSearchTickerTool(getCtx)];
	const ctx = getCtx();
	return ctx.allowAccountAccess
		? [...base, createGetPortfolioTool(getCtx)]
		: base;
}

function textResult(text: string): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
} {
	return { content: [{ type: "text" as const, text }], details: {} };
}
