import type { Command } from "commander";
import { buildAnalysisContext } from "../agents/pipeline.js";
import { runAnalysis } from "../agents/debate.js";
import { recordDecision } from "../agents/memory.js";
import { ROLE_LABELS } from "../agents/roles.js";
import { out, outputJson } from "../output.js";

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

			const { ctx } = await buildAnalysisContext({
				objective: "question" as "portfolio-recommend" | "strategy",
				fetchNews: true,
			} as never);

			// Inject the user's question into the context as the focal point.
			(ctx as unknown as { userQuestion: string }).userQuestion = question;

			const outcome = await runAnalysis(ctx, ctx.config);
			recordDecision(outcome.recommendation);
			const rec = outcome.recommendation;

			if (opts.json) {
				const payload = opts.report
					? rec
					: { ...rec, reports: undefined, debate: undefined };
				outputJson({ question, answer: payload });
				return;
			}

			out(`\n═══ 트레이딩 데스크 답변 ═══`);
			out(`질문: ${question}\n`);
			out("전략:");
			out(rec.strategy);
			if (rec.cashGuidance) out(`\n현금/세금: ${rec.cashGuidance}`);
			if (rec.warnings.length) {
				out("\n주의사항:");
				for (const w of rec.warnings) out(`  ⚠ ${w}`);
			}
			if (rec.positions.length > 0) {
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
