/**
 * Persistent specialist session pool. Each role gets ONE session, created
 * lazily on first consult and reused for every follow-up — so the specialist
 * accumulates context across the whole conversation and the PM can re-question
 * it cheaply. Parallel consults (consultBatch) fan out to distinct roles at
 * once for latency.
 *
 * Sessions are independent pi AgentSession instances; nesting a specialist's
 * prompt inside a PM tool-call works because each runs its own agent loop on
 * its own agent instance. (Abort does not propagate across nested sessions —
 * each specialist has its own per-call timeout as a safety net.)
 */
import type { AgentReport, AgentRole } from "../types.js";
import type { AppConfig } from "../config/app-config.js";
import { datePreamble, userMessage, type AnalysisContext } from "./roles.js";
import {
	createRoleSession,
	runSessionTurn,
	type RoleSessionHandle,
} from "./session-factory.js";
import { specialistTools } from "./agent-tools.js";
import { parseReport } from "./registry.js";

const RETRY_BACKOFF_MS = 2000;

/** Injectable session creation/turn execution — lets tests run the pool with
 * fake sessions (no LLM, no network). Defaults wire to the real factory. */
export interface PoolDeps {
	createSession?: typeof createRoleSession;
	runTurn?: typeof runSessionTurn;
}

export class SubAgentPool {
	private readonly handles = new Map<AgentRole, RoleSessionHandle>();
	/** In-flight creation promises — prevents a same-role race when two parallel
	 *  consults for one role arrive before the session is cached. */
	private readonly inflight = new Map<AgentRole, Promise<RoleSessionHandle>>();
	private readonly seeded = new Set<AgentRole>();
	/** Reports collected across all consults, in arrival order. */
	readonly reports: AgentReport[] = [];

	constructor(
		private ctx: AnalysisContext,
		private readonly config: AppConfig,
		private readonly deps: PoolDeps = {},
	) {}

	/** Refresh the shared context (called per Telegram message so specialist
	 *  follow-up turns carry the latest snapshot/date/question). Sessions persist. */
	updateContext(ctx: AnalysisContext): void {
		this.ctx = ctx;
	}

	/** True once at least one specialist has been consulted. */
	get delegated(): boolean {
		return this.reports.length > 0;
	}

	/** Consult one specialist. The first call seeds the full role context
	 * (snapshot/portfolio/news digest); later calls are short follow-ups that
	 * reuse the accumulated session. Returns the parsed report. */
	async consult(role: AgentRole, instruction: string): Promise<AgentReport> {
		const handle = await this.ensure(role);
		const firstTime = !this.seeded.has(role);
		this.seeded.add(role);
		const message = firstTime
			? `${userMessage(role, this.ctx)}\n\n[포트폴리오 매니저 위임] ${instruction}`
			: `${datePreamble(this.ctx)}\n\n[포트폴리오 매니저 추가 질문] ${instruction}`;
		const report = await this.runWithRetry(handle, message, role);
		this.reports.push(report);
		return report;
	}

	/** Consult several specialists at once. Each runs in its own session, so
	 * they execute in parallel. Returns reports keyed to the input order. */
	async consultBatch(
		roles: AgentRole[],
		instruction: string,
	): Promise<AgentReport[]> {
		// Dedupe so a repeated role can't trigger two session creations.
		const unique = [...new Set(roles)];
		return Promise.all(unique.map((r) => this.consult(r, instruction)));
	}

	/** Roles that have been consulted at least once. */
	consultedRoles(): AgentRole[] {
		return [...this.seeded];
	}

	/** Dispose every live session. Call when the conversation/orchestration ends. */
	dispose(): void {
		for (const h of this.handles.values()) {
			try {
				h.session.dispose();
			} catch {
				/* dispose must not throw */
			}
		}
		this.handles.clear();
	}

	/** Reset per-run state (reports/delegated) so a reused Telegram pool starts
	 *  each message fresh — a new question must not synthesize from stale reports. */
	resetForRun(): void {
		this.reports.length = 0;
	}

	private async ensure(role: AgentRole): Promise<RoleSessionHandle> {
		const cached = this.handles.get(role);
		if (cached) return cached;
		let p = this.inflight.get(role);
		if (!p) {
			const create = this.deps.createSession ?? createRoleSession;
			p = create(role, this.ctx, this.config, {
				customTools: specialistTools(() => this.ctx),
			}).then(
				(h) => {
					this.handles.set(role, h);
					this.inflight.delete(role);
					return h;
				},
				(err) => {
					// Clear the in-flight slot on rejection so a later retry can recreate.
					this.inflight.delete(role);
					throw err;
				},
			);
			this.inflight.set(role, p);
		}
		return p;
	}

	private async runWithRetry(
		handle: RoleSessionHandle,
		message: string,
		role: AgentRole,
	): Promise<AgentReport> {
		const run = this.deps.runTurn ?? runSessionTurn;
		let text = await run(handle.session, message, this.config);
		if (!text) {
			await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
			text = await run(handle.session, message, this.config);
		}
		return parseReport(role, handle.modelLabel, text);
	}
}
