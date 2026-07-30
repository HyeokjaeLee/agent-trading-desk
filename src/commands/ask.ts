import type { Command } from "commander";
import { runOrchestrator } from "../agents/orchestrator.js";
import { recordDecision } from "../agents/memory.js";
import { ROLE_LABELS, type AnalysisContext } from "../agents/roles.js";
import { ensureTaxContextFresh } from "../agents/tax-context.js";
import { loadConfig } from "../config/app-config.js";
import { getMarketState } from "../market/market-state.js";
import {
	loadSession,
	saveExchange,
	formatConversation,
} from "../bot/session.js";
import { out, outputJson } from "../output.js";
import type { MarketSnapshot, AggregatedPortfolio } from "../types.js";

/**
 * td ask — PM 주도 오케스트레이터.
 *
 * PM이 메인 에이전트로 사용자 질문을 받아, 필요한 전문가 서브에이전트에게
 * 작업을 위임(consult_specialist / consult_specialists 병렬)하고 보고를 종합해 답한다.
 * 전문가 세션은 대화 중 유지되어 PM이 재질문할 수 있다. 빈 데이터로 시작해
 * PM/전문가가 refresh_market_data 도구로 필요 종목을 온디맨드 패칭한다.
 * CLI에서는 계좌 접근 허용 (get_portfolio 도구) — 텔레그램 봇은 차단.
 */

const SESSION_CHAT_ID = 0; // CLI 단일 세션

export function registerAskCommands(root: Command): void {
	root
		.command("ask <question>")
		.description(
			"자유로운 투자 질문을 트레이딩 데스크 에이전트들과 토론하여 답변합니다",
		)
		.option("--json", "JSON 출력")
		.option("--report", "에이전트별 보고서 포함")
		.action(async (question: string, opts) => {
			if (!opts.json) out(`▶ 질문: "${question}"`);
			if (!opts.json) out("▶ 에이전트 토론 시작…");

			// 1. 세법/ISA/IRP 신선도 체크 (30일).
			const taxResult = await ensureTaxContextFresh();
			const taxNote = taxResult.updated
				? "\n\n⚠️ 세법/ISA/IRP 정보가 방금 갱신되었습니다. 최신 내용을 반드시 확인하라."
				: "";
			const taxContext = taxResult.context;

			// 2. 대화 10분 경과 감지.
			const history = loadSession(SESSION_CHAT_ID);
			const lastTs =
				history.length > 0
					? new Date(history[history.length - 1]!.timestamp).getTime()
					: 0;
			const gapMs = Date.now() - lastTs;
			const staleNote =
				gapMs > 10 * 60 * 1000 && history.length > 0
					? "\n\n⚠️ 이전 대화에서 10분 이상 경과했습니다. 시장 데이터가 변경되었을 수 있습니다. refresh_market_data 도구를 호출하여 최신 데이터를 가져온 후 분석하라."
					: "";

			// 3. 빈 tickersByYahoo로 시작 — PM이 필요 종목을 도구로 fetch.
			const config = loadConfig();
			const emptyPortfolio: AggregatedPortfolio = {
				asOf: new Date().toISOString(),
				cash: [],
				holdings: [],
				accounts: [],
			};
			const emptySnapshot: MarketSnapshot = {
				generatedAt: new Date().toISOString(),
				requested: [],
				tickers: [],
				marketState: {},
			};

			const ctx: AnalysisContext = {
				objective: "portfolio-recommend",
				marketState: {
					KR: getMarketState("KR"),
					US: getMarketState("US"),
				},
				portfolio: emptyPortfolio,
				snapshot: emptySnapshot,
				tickersByYahoo: {}, // PM이 채움
				allowAccountAccess: true, // CLI에서는 계좌 접근 허용
				config,
				userQuestion: question,
				taxContext: taxContext + taxNote + staleNote,
			};

			// 대화 기록 주입.
			const convText = formatConversation(history);
			if (convText) {
				(
					ctx as unknown as { conversationHistory: string }
				).conversationHistory = convText;
			}

			// 4. 에이전트 토론 실행 (PM이 refresh_market_data 도구로 데이터 패칭).
			const outcome = await runOrchestrator(ctx, ctx.config);
			recordDecision(outcome.recommendation);
			const rec = outcome.recommendation;

			// 5. 결과 저장.
			const answer =
				outcome.text ||
				outcome.recommendation.strategy ||
				"답변을 생성하지 못했습니다.";
			saveExchange(SESSION_CHAT_ID, question, answer);

			// CLI 실행 시 마지막 응답을 파일로 저장 (백그라운드 실행 후 전체 읽기용)
			const outFile = `${process.env.HOME}/.agent-trading-desk/last-answer.md`;
			await import("fs/promises").then((fs) =>
				fs.writeFile(outFile, `# 질문: ${question}\n\n${answer}\n`),
			);

			if (opts.json) {
				const payload = opts.report
					? rec
					: { ...rec, reports: undefined, debate: undefined };
				outputJson({ question, answer: payload });
				return;
			}

			out(`\n═══ 트레이딩 데스크 답변 ═══`);
			out(`질문: ${question}\n`);
			out(answer);
			if (opts.report && rec.positions.length > 0) {
				out("\n관련 종목:");
				for (const p of rec.positions) {
					out(
						`• ${p.name ?? p.ticker} → ${p.action.toUpperCase()} (신뢰도 ${(p.confidence * 100).toFixed(0)}%): ${p.rationale}`,
					);
				}
			}
			if (opts.report) {
				out("\n──── 에이전트별 의견 ────");
				for (const r of outcome.reports) {
					out(`\n[${ROLE_LABELS[r.role]} — ${r.stance}] (${r.model})`);
					out(r.analysis.slice(0, 800));
				}
			}
		});
}
