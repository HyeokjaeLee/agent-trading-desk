import type { AgentReport, AgentRole, Recommendation } from "../types.js";
import type { AppConfig } from "../config/app-config.js";
import type { AnalysisContext } from "./roles.js";
import { parseRecommendation, runRole, type RunResult } from "./registry.js";

export interface AnalysisOutcome {
	reports: AgentReport[];
	debate: Array<{ round: number; speaker: AgentRole; text: string }>;
	recommendation: Recommendation;
	/** Raw run results with timing/errors for debugging. */
	raw: RunResult[];
}

const ANALYST_ROLES: AgentRole[] = ["technical", "fundamental"];

function trace(msg: string): void {
	process.stderr.write(`  • ${msg}\n`);
}
async function runLogged(
	role: AgentRole,
	ctx: AnalysisContext,
	config: AppConfig,
): Promise<RunResult> {
	trace(`start ${role}…`);
	const r = await runRole(role, ctx, config);
	trace(
		`${role} done (${r.durationMs}ms${r.error ? `, ERR: ${r.error}` : ""})`,
	);
	return r;
}

/** Run the full multi-agent analysis pipeline and return a recommendation. */
export async function runAnalysis(
	baseCtx: AnalysisContext,
	config: AppConfig,
): Promise<AnalysisOutcome> {
	const raw: RunResult[] = [];
	const reports: AgentReport[] = [];
	const debate: Array<{ round: number; speaker: AgentRole; text: string }> = [];

	// Phase 1 — analysts run in parallel (independent views).
	const analystResults = await Promise.all(
		ANALYST_ROLES.map((role) => runLogged(role, baseCtx, config)),
	);
	for (const r of analystResults) {
		raw.push(r);
		if (r.parsed && r.role !== "portfolio-manager") {
			reports.push(r.parsed as AgentReport);
		}
	}
	// Pre-computed merged News report (browser-use, if enabled & available).
	if (baseCtx.newsReport) {
		reports.push(baseCtx.newsReport);
		raw.push({
			role: "news",
			model: baseCtx.newsReport.model,
			text: baseCtx.newsReport.analysis,
			parsed: baseCtx.newsReport,
			durationMs: 0,
		});
	}

	// Phase 2 — adversarial bull/bear debate over N rounds.

	for (let round = 1; round <= Math.max(1, config.debateRounds); round++) {
		for (const speaker of ["bull", "bear"] as const) {
			const ctx: AnalysisContext = {
				...baseCtx,
				priorReports: reports,
				debateHistory: debate,
			};
			const res = await runLogged(speaker, ctx, config);
			raw.push(res);
			if (res.parsed) reports.push(res.parsed as AgentReport);
			debate.push({
				round,
				speaker,
				text: res.text.slice(0, 1600),
			});
		}
	}

	// Phase 3 — risk + reviewer assess the synthesis (parallel).
	const assessCtx: AnalysisContext = {
		...baseCtx,
		priorReports: reports,
		debateHistory: debate,
	};
	const assessResults = await Promise.all(
		(["risk", "reviewer"] as const).map((role) =>
			runLogged(role, assessCtx, config),
		),
	);
	for (const r of assessResults) {
		raw.push(r);
		if (r.parsed) reports.push(r.parsed as AgentReport);
	}

	// Phase 4 — portfolio manager synthesizes the final decision.
	const pmCtx: AnalysisContext = {
		...baseCtx,
		priorReports: reports,
		debateHistory: debate,
	};
	const pm = await runLogged("portfolio-manager", pmCtx, config);
	raw.push(pm);

	const pmParsed = (pm.parsed ?? {}) as Partial<Recommendation>;

	// Validate/normalize positions; drop any hallucinated empty-ticker entries.
	const positions = (
		Array.isArray(pmParsed.positions) ? pmParsed.positions : []
	).filter((p) => String(p?.ticker ?? "").trim().length > 0);

	const recommendation: Recommendation = {
		generatedAt: baseCtx.snapshot.generatedAt,
		objective: baseCtx.objective,
		marketState: baseCtx.marketState,
		positions: positions.map((p) => ({
			ticker: String(p?.ticker ?? ""),
			name: p?.name ? String(p.name) : undefined,
			action: (["buy", "hold", "trim", "sell", "watch", "avoid"].includes(
				String(p?.action),
			)
				? String(p?.action)
				: "hold") as Recommendation["positions"][number]["action"],
			confidence:
				typeof p?.confidence === "number" && isFinite(p.confidence)
					? Math.max(0, Math.min(1, p.confidence))
					: 0.5,
			rationale: String(p?.rationale ?? ""),
			targetWeight:
				typeof p?.targetWeight === "number" ? p.targetWeight : undefined,
			horizon: (["short", "medium", "long"].includes(String(p?.horizon))
				? String(p?.horizon)
				: undefined) as "short" | "medium" | "long" | undefined,
			keyRisks: Array.isArray(p?.keyRisks) ? p.keyRisks.map(String) : [],
		})),
		strategy: String(pmParsed.strategy ?? pm.text.slice(0, 4000)),
		cashGuidance: pmParsed.cashGuidance
			? String(pmParsed.cashGuidance)
			: undefined,
		warnings: Array.isArray(pmParsed.warnings)
			? pmParsed.warnings.map(String)
			: [],
		reports,
		debate,
		snapshotGeneratedAt: baseCtx.snapshot.generatedAt,
		portfolioAsOf: baseCtx.portfolio.asOf,
	};

	return { reports, debate, recommendation, raw };
}

export { parseRecommendation };
