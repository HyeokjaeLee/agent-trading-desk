import type { Command } from "commander";
import { buildAnalysisContext } from "../agents/pipeline.js";
import { runAnalysis } from "../agents/debate.js";
import { recordDecision } from "../agents/memory.js";
import { ROLE_LABELS } from "../agents/roles.js";
import { out, outputJson } from "../output.js";

export function registerAnalyzeCommands(root: Command): void {
	const analyze = root
		.command("analyze")
		.description(
			"run the multi-agent investment desk: analysts → bull/bear debate → risk → final",
		);

	analyze
		.command("portfolio")
		.description(
			"recommend stocks to add to the portfolio (debate + synthesis)",
		)
		.option(
			"-s, --symbols <list>",
			"comma-separated extra symbols to evaluate (AAPL, 005930)",
		)
		.option("--refresh", "force a fresh yfinance fetch")
		.option("--no-news", "skip browser-use news")
		.option("--blind", "backtest mode: hide realized outcomes from models")
		.option("--as-of <date>", "ISO date / YYYY-MM-DD for backtesting")
		.option("--json", "JSON output")
		.option("--report", "include full per-agent reports in output")
		.action(async (opts) => runObjective("portfolio-recommend", opts));

	analyze
		.command("strategy")
		.description("current-time response strategy for the existing portfolio")
		.option("-s, --symbols <list>", "comma-separated extra symbols to evaluate")
		.option("--refresh", "force a fresh yfinance fetch")
		.option("--no-news", "skip browser-use news")
		.option("--blind", "backtest mode")
		.option("--as-of <date>", "ISO date / YYYY-MM-DD for backtesting")
		.option("--json", "JSON output")
		.option("--report", "include full per-agent reports in output")
		.action(async (opts) => runObjective("strategy", opts));
}

interface AnalyzeOpts {
	symbols?: string;
	refresh?: boolean;
	news?: boolean;
	blind?: boolean;
	asOf?: string;
	json?: boolean;
	report?: boolean;
}

async function runObjective(
	objective: "portfolio-recommend" | "strategy",
	opts: AnalyzeOpts,
): Promise<void> {
	const symbols = opts.symbols
		? String(opts.symbols)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;

	if (!opts.json) out("▶ assembling context (portfolio + snapshot)…");
	const { ctx } = await buildAnalysisContext({
		objective,
		symbols,
		refresh: opts.refresh,
		fetchNews: opts.news !== false,
		blind: opts.blind,
		asOf: opts.asOf,
	});

	if (!opts.json)
		out("▶ running analyst team → bull/bear debate → risk → PM synthesis…");
	const outcome = await runAnalysis(ctx, ctx.config);

	// Persist to memory for future reflection.
	recordDecision(outcome.recommendation);

	const rec = outcome.recommendation;

	if (opts.json) {
		const payload = opts.report
			? rec
			: { ...rec, reports: undefined, debate: undefined };
		outputJson(payload);
		return;
	}

	out(
		`\n═══ FINAL ${objective === "portfolio-recommend" ? "PORTFOLIO RECOMMENDATION" : "STRATEGY"} ═══`,
	);
	out(`Generated: ${rec.generatedAt}`);
	out(
		`Market: KR ${rec.marketState.KR?.session} / US ${rec.marketState.US?.session}`,
	);
	out("");
	for (const p of rec.positions) {
		out(
			`• ${p.ticker} ${p.name ?? ""} → ${p.action.toUpperCase()} (conf ${(p.confidence * 100).toFixed(0)}%${p.targetWeight !== undefined ? `, target ${(p.targetWeight * 100).toFixed(1)}%` : ""}${p.horizon ? `, ${p.horizon}` : ""})`,
		);
		if (p.rationale) out(`    ${p.rationale}`);
		if (p.keyRisks.length) out(`    risks: ${p.keyRisks.join("; ")}`);
	}
	out("");
	out("STRATEGY:");
	out(rec.strategy);
	if (rec.cashGuidance) out(`\nCASH/FX: ${rec.cashGuidance}`);
	if (rec.warnings.length) {
		out("\nWARNINGS:");
		for (const w of rec.warnings) out(`  ⚠ ${w}`);
	}

	if (opts.report) {
		out("\n──── per-agent reports ────");
		for (const r of outcome.reports) {
			out(
				`\n[${ROLE_LABELS[r.role]} — ${r.stance}, conf ${(r.confidence * 100).toFixed(0)}%] (${r.model})`,
			);
			out(r.analysis.slice(0, 1200));
		}
	}

	// Surface any agent runtime errors.
	const errs = outcome.raw.filter((r) => r.error);
	if (errs.length) {
		out("\n(agent errors):");
		for (const e of errs) out(`  ${e.role}: ${e.error}`);
	}
}
