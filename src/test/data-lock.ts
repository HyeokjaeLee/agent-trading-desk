/**
 * Data-lock + orchestrator verification — proves the "lock online info to the
 * past and control external access" guarantee holds at every agent-reachable
 * layer, AND that the PM orchestrator actually delegates to specialists that
 * persist and run in parallel.
 *
 *   bun run src/test/data-lock.ts                 # deterministic suite (no LLM)
 *   TD_E2E_LIVE=1 bun run src/test/data-lock.ts   # + real orchestrator run
 *
 * Deterministic layers verified:
 *   1. Date injection  — every system prompt carries the locked KST "now".
 *   2. Offline lock    — refresh/search/get_portfolio ALL refuse network.
 *   3. Snapshot isolation — the digest only exposes locked, dated data.
 *   4. Blind propagation — the backtest constraint reaches the agent prompt.
 *   5. Pool parallel + dedupe + persistence (fake sessions, no LLM).
 *   6. Delegation guard — runOrchestrator re-prompts when PM skips delegation.
 */
import assert from "node:assert";
import {
	systemPrompt,
	datePreamble,
	snapshotDigest,
	userMessage,
	type AnalysisContext,
} from "../agents/roles.js";
import {
	createRefreshTool,
	createSearchTickerTool,
	createGetPortfolioTool,
} from "../agents/agent-tools.js";
import {
	orchestratorSystemPrompt,
	runOrchestrator,
} from "../agents/orchestrator.js";
import { SubAgentPool } from "../agents/sub-agent-pool.js";
import { kstClock } from "../agents/now.js";
import type {
	MarketSnapshot,
	AggregatedPortfolio,
	MarketSessionState,
	AgentReport,
	AgentRole,
} from "../types.js";
import type { RoleSessionHandle } from "../agents/session-factory.js";

// 2026-03-15 14:30 KST = 2026-03-15 05:30 UTC. A locked "past" instant.
const LOCKED_NOW = new Date("2026-03-15T05:30:00.000Z");
const LOCKED_SNAP_AT = "2026-03-15T05:25:00.000Z";

function lockedSnapshot(): MarketSnapshot {
	return {
		generatedAt: LOCKED_SNAP_AT,
		requested: ["005930.KS"],
		tickers: [
			{
				ticker: "005930.KS",
				symbol: "005930",
				name: "Samsung Electronics",
				market: "KR",
				fundamentals: { price: 67_000, per: 12.5, pbr: 1.1 } as never,
			},
		],
		marketState: {},
	};
}

function lockedPortfolio(): AggregatedPortfolio {
	return {
		asOf: LOCKED_SNAP_AT,
		cash: [{ amount: 10_000_000, currency: "KRW", sources: [] }],
		holdings: [
			{
				ticker: "005930.KS",
				symbol: "005930",
				name: "Samsung Electronics",
				market: "KR",
				currency: "KRW",
				quantity: 100,
				averagePrice: 60_000,
				breakdown: [],
			},
		],
		accounts: [],
	};
}

const KR_CLOSED: MarketSessionState = {
	region: "KR",
	now: LOCKED_SNAP_AT,
	session: "closed",
	isOpen: false,
	nextOpen: "2026-03-16T00:00:00.000Z",
	tradingDay: "2026-03-13",
};

function lockedCtx(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
	const snap = lockedSnapshot();
	return {
		objective: "portfolio-recommend",
		marketState: { KR: KR_CLOSED, US: { ...KR_CLOSED, region: "US" } },
		portfolio: lockedPortfolio(),
		snapshot: snap,
		tickersByYahoo: { "005930.KS": snap.tickers[0]! },
		config: { accounts: [], debateRounds: 1, blindMode: false } as never,
		now: LOCKED_NOW,
		blind: true,
		offline: true,
		...overrides,
	};
}

type Check = { name: string; fn: () => void | Promise<void> };

const checks: Check[] = [
	{
		name: "KST clock formats the locked instant correctly",
		fn: () => {
			const c = kstClock(LOCKED_NOW);
			assert.equal(c.date, "2026-03-15");
			assert.equal(c.time, "14:30");
			assert.equal(c.dow, "일요일");
		},
	},
	{
		name: "datePreamble carries the locked date + snapshot cutoff",
		fn: () => {
			const p = datePreamble(lockedCtx());
			assert.match(p, /2026-03-15/);
			assert.match(p, /14:30 KST/);
			assert.match(p, /일요일/);
			assert.match(
				p,
				/2026-03-15T05:25/,
				"preamble must name the snapshot cutoff",
			);
			assert.match(p, /이후에 일어난 일은 단정 짓지 마라/);
		},
	},
	{
		name: "every specialist system prompt carries the locked date",
		fn: () => {
			const ctx = lockedCtx();
			for (const role of [
				"technical",
				"fundamental",
				"news",
				"bull",
				"bear",
				"risk",
				"reviewer",
				"portfolio-manager",
			] as const) {
				const p = systemPrompt(role, ctx);
				assert.match(p, /2026-03-15/, `${role} prompt missing locked date`);
				assert.match(p, /14:30 KST/, `${role} prompt missing locked time`);
			}
		},
	},
	{
		name: "orchestrator PM prompt carries the date + delegation mandate",
		fn: () => {
			const p = orchestratorSystemPrompt(lockedCtx());
			assert.match(p, /2026-03-15/);
			assert.match(p, /오케스트레이터/);
			assert.match(p, /consult_specialists/);
			assert.match(p, /병렬/);
		},
	},
	{
		name: "snapshotDigest exposes ONLY the locked data",
		fn: () => {
			const digest = snapshotDigest(lockedCtx());
			assert.match(digest, /005930.KS/);
			assert.match(digest, /67,000|67000/);
			assert.doesNotMatch(digest, /실시간/);
		},
	},
	{
		name: "blind constraint reaches the agent user message",
		fn: () => {
			const msg = userMessage("technical", lockedCtx({ blind: true }));
			assert.match(msg, /BACKTEST\/BLIND/);
			assert.match(msg, /after the snapshot/);
		},
	},
	{
		name: "offline blocks refresh_market_data from the network",
		fn: async () => {
			const tool = createRefreshTool(() => lockedCtx({ offline: true }));
			const res = await tool.execute(
				"t",
				{ tickers: ["005930.KS"] },
				undefined,
				undefined,
				undefined as never,
			);
			const t = JSON.stringify(res);
			assert.match(t, /오프라인 모드/);
			assert.match(t, /2026-03-15T05:25/);
		},
	},
	{
		name: "offline blocks search_ticker from the network",
		fn: async () => {
			const tool = createSearchTickerTool(() => lockedCtx({ offline: true }));
			const res = await tool.execute(
				"t",
				{ query: "삼성전자" },
				undefined,
				undefined,
				undefined as never,
			);
			assert.match(JSON.stringify(res), /오프라인 모드/);
			assert.match(JSON.stringify(res), /실시간 종목 검색이 차단/);
		},
	},
	{
		name: "offline blocks get_portfolio from the network",
		fn: async () => {
			const tool = createGetPortfolioTool(() => lockedCtx({ offline: true }));
			const res = await tool.execute(
				"t",
				{},
				undefined,
				undefined,
				undefined as never,
			);
			assert.match(JSON.stringify(res), /오프라인 모드/);
			assert.match(JSON.stringify(res), /실시간 계좌 조회가 차단/);
		},
	},
];

// ── Pool: parallel + dedupe + persistence with fake sessions (no LLM) ────────

function detectRole(message: string): AgentRole {
	if (message.includes("기술") || message.includes("technical"))
		return "technical";
	if (message.includes("기본")) return "fundamental";
	return "news";
}

function fakePoolDeps() {
	const created: AgentRole[] = [];
	const turns: Array<{ role: AgentRole; msg: string }> = [];
	const createSession = async (role: AgentRole): Promise<RoleSessionHandle> => {
		created.push(role);
		return {
			role,
			session: { dispose() {} } as never,
			modelLabel: `fake/${role}`,
		};
	};
	const runTurn = async (
		_session: unknown,
		message: string,
	): Promise<string> => {
		const roleMatch = message.match(/\[포트폴리오 매니저 위임\] (.*)/s);
		const role = detectRole(message);
		turns.push({ role, msg: roleMatch?.[1] ?? message });
		return fakeReportText(role);
	};
	return { created, turns, createSession, runTurn };
}

function fakeReportText(role: AgentRole): string {
	return `\`\`\`json\n{"stance":"bullish","confidence":0.8,"keyPoints":["${role} kp"],"suggestions":["${role} sg"]}\n\`\`\``;
}

const poolChecks: Check[] = [
	{
		name: "pool consultBatch dedupes roles (no same-role session race)",
		fn: async () => {
			const ctx = lockedCtx();
			const deps = fakePoolDeps();
			const pool = new SubAgentPool(ctx, ctx.config, {
				createSession: deps.createSession as never,
				runTurn: deps.runTurn as never,
			});
			// Duplicate technical must not create two sessions.
			const reports = await pool.consultBatch(
				["technical", "fundamental", "technical"],
				"분석해줘",
			);
			assert.equal(reports.length, 2, "deduped: one report per UNIQUE role");
			assert.equal(deps.created.length, 2, "deduped: only 2 sessions created");
			assert.deepEqual(
				[...new Set(deps.created)],
				["technical", "fundamental"],
			);
			pool.dispose();
		},
	},
	{
		name: "pool persists a specialist session across consults (re-query)",
		fn: async () => {
			const ctx = lockedCtx();
			const deps = fakePoolDeps();
			const pool = new SubAgentPool(ctx, ctx.config, {
				createSession: deps.createSession as never,
				runTurn: deps.runTurn as never,
			});
			await pool.consult("technical", "1차 질문");
			await pool.consult("technical", "2차 질문 (재질문)");
			assert.equal(deps.created.length, 1, "second consult reuses the session");
			assert.equal(pool.reports.length, 2, "both consults produced reports");
			assert.equal(pool.delegated, true);
			pool.dispose();
		},
	},
	{
		name: "pool consultBatch runs specialists in parallel",
		fn: async () => {
			const ctx = lockedCtx();
			const deps = fakePoolDeps();
			let active = 0;
			let maxActive = 0;
			const runTurn = async (_s: unknown, message: string): Promise<string> => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 20));
				active--;
				const role = "technical";
				deps.turns.push({ role, msg: message });
				return fakeReportText(role);
			};
			const pool = new SubAgentPool(ctx, ctx.config, {
				createSession: deps.createSession as never,
				runTurn: runTurn as never,
			});
			await pool.consultBatch(
				["technical", "fundamental", "news"],
				"병렬 분석",
			);
			assert.ok(
				maxActive >= 2,
				`expected concurrent execution, maxActive=${maxActive}`,
			);
			pool.dispose();
		},
	},
];

// ── Delegation guard: runOrchestrator re-prompts when PM skips delegation ────

const orchestratorChecks: Check[] = [
	{
		name: "delegation guard hard-fails when PM never delegates after retries",
		fn: async () => {
			const ctx = lockedCtx({ userQuestion: "삼성전자 분석" });
			let pmCalls = 0;
			// PM fake: never delegates on any turn → guard retries, then hard-fails.
			const pmRunTurn = async (): Promise<string> => {
				pmCalls++;
				return "삼성전자는 기술적으로 강세입니다.";
			};
			const specialistDeps = fakePoolDeps();
			let threw = false;
			try {
				await runOrchestrator(ctx, ctx.config, {
					runTurn: pmRunTurn as never,
					createSession: specialistDeps.createSession as never,
				});
			} catch (e) {
				threw = true;
				assert.match(
					String(e),
					/위임하지 않고/,
					"must fail with the delegation error",
				);
			}
			assert.ok(threw, "orchestrator must throw when PM never delegates");
			assert.ok(
				pmCalls >= 1 + 3,
				`guard must retry up to MAX attempts (calls=${pmCalls})`,
			);
		},
	},
	{
		name: "orchestrator reports delegated=true when the PM consults (simulated)",
		fn: async () => {
			const ctx = lockedCtx({ userQuestion: "삼성전자 분석" });
			// Simulate a PM that delegates by having the PM turn directly push a
			// report into the pool via consult before answering.
			const specialistDeps = fakePoolDeps();
			let delegated = false;
			const pool = new SubAgentPool(ctx, ctx.config, {
				createSession: specialistDeps.createSession as never,
				runTurn: specialistDeps.runTurn as never,
			});
			const pmRunTurn = async (): Promise<string> => {
				if (!delegated) {
					await pool.consult("technical", "삼성전자 기술 분석");
					delegated = true;
				}
				return "전문가 보고를 종합: 삼성전자 강세.";
			};
			const outcome = await runOrchestrator(ctx, ctx.config, {
				pool,
				runTurn: pmRunTurn as never,
				createSession: specialistDeps.createSession as never,
			});
			assert.equal(outcome.delegated, true);
			assert.ok(outcome.reports.length >= 1);
		},
	},
];

async function runLive(): Promise<void> {
	const { loadConfig } = await import("../config/app-config.js");
	const ctx = lockedCtx({
		userQuestion: "삼성전자 현재 상황과 전망을 분석해줘",
	});
	const cfg = loadConfig();
	if (!cfg.defaultModel && cfg.accounts.length === 0) {
		console.log("  ⚠ live run skipped (no models/accounts configured)");
		return;
	}
	// Bounded: live LLM runs must not hang the test suite.
	const LIVE_TIMEOUT_MS = Number(process.env.TD_E2E_LIVE_MS ?? 120_000);
	const outcome = await Promise.race([
		runOrchestrator(ctx, cfg),
		new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(new Error(`live E2E timed out after ${LIVE_TIMEOUT_MS}ms`)),
				LIVE_TIMEOUT_MS,
			),
		),
	]);
	const text = outcome.text;
	assert.ok(text.length > 0, "PM produced empty answer");
	// Strict alignment: the answer must reference the locked date...
	assert.match(
		text,
		/2026-03-15|3월 15|03-15/,
		"PM must anchor its answer to the locked date",
	);
	// ...and must not assert knowledge of events AFTER the snapshot cutoff.
	const FUTURE_MARKERS =
		/2026-0[4-9]|2026-1[0-2]|2027|내일 모레|아직 일어나지 않은|예정인/;
	const futureClaims = text.match(new RegExp(FUTURE_MARKERS, "g"));
	assert.ok(
		!futureClaims || futureClaims.length === 0,
		`PM leaked post-cutoff claims: ${futureClaims?.slice(0, 5).join(", ")}`,
	);
	// Delegation must have happened (guard enforces it).
	assert.equal(
		outcome.delegated,
		true,
		"PM must have consulted specialists (guard)",
	);
	assert.ok(outcome.reports.length >= 1, "at least one specialist report");
	console.log(
		`  ✓ live orchestrator: ${text.length} chars, delegated=${outcome.delegated}, reports=${outcome.reports.length}`,
	);
	console.log("  head:", text.slice(0, 200).replace(/\n/g, " "));
}

async function main(): Promise<void> {
	let failures = 0;
	const all = [...checks, ...poolChecks, ...orchestratorChecks];
	for (const c of all) {
		try {
			await c.fn();
			console.log(`  ✓ ${c.name}`);
		} catch (e) {
			failures++;
			console.error(
				`  ✗ ${c.name}\n      ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	if (process.env.TD_E2E_LIVE === "1") {
		console.log("\n— live E2E (TD_E2E_LIVE=1) —");
		try {
			await runLive();
			console.log("  ✓ live data-lock E2E passed");
		} catch (e) {
			failures++;
			console.error(
				`  ✗ live E2E failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	console.log(`\n${all.length} checks, ${failures} failure(s)`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();

// Suppress unused-import warnings for re-exported types kept for clarity.
export type { AgentReport };
