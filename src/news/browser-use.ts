import { homedir } from "node:os";
import { join } from "node:path";
import { NEWS_CACHE_DIR } from "../config/paths.js";
import { newsSignalWeight } from "../market/market-state.js";
import { writeJsonFile, readJsonFile } from "../output.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assignmentFor, type AppConfig } from "../config/app-config.js";
import { newsAnalystTask, type AnalysisContext } from "../agents/roles.js";
import type { AgentReport } from "../types.js";

/**
 * News via browser-use (MCP). browser-use is the LLM-driven browser agent — it
 * needs its OWN model. We point its OpenAI-compatible client at the "news"
 * role's assigned model (opencode-go / mimo-v2.5 → https://opencode.ai/zen/go/v1).
 *
 * In MERGED mode browser-use IS the News analyst: it gets the persona +
 * investment context + priced-in rule + JSON schema, browses, and returns a
 * structured News report in one pass. Raw items are cached for reuse.
 */

export interface NewsItem {
	title: string;
	summary: string;
	url?: string;
	date: string;
	region: "KR" | "US";
	source: string;
	weight: { pricedIn: boolean; active: boolean; reason: string };
}

export interface NewsResult {
	items: NewsItem[];
	degraded: boolean;
	reason?: string;
}

export interface NewsAnalystResult {
	report?: AgentReport;
	items: NewsItem[];
	degraded: boolean;
	reason?: string;
}

let cdpLaunched = false;

/**
 * Launch a headless Chrome with remote-debugging for browser-use (if not already
 * running). Returns the CDP WebSocket URL, or undefined on failure.
 */
async function ensureHeadlessChromeCdp(): Promise<string | undefined> {
	if (cdpLaunched) return undefined; // already attempted
	cdpLaunched = true;
	const cdpPort = 9222;
	// Check if CDP is already available.
	try {
		const resp = await fetch(`http://localhost:${cdpPort}/json/version`);
		if (resp.ok) {
			const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
			if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
		}
	} catch {
		/* not running */
	}
	// Launch headless Chrome.
	const { spawn } = await import("node:child_process");
	const user_data_dir = `/tmp/bu-chrome-${process.pid}`;
	const child = spawn(
		"google-chrome",
		[
			"--headless=new",
			`--remote-debugging-port=${cdpPort}`,
			"--no-first-run",
			"--no-sandbox",
			"--disable-gpu",
			`--user-data-dir=${user_data_dir}`,
		],
		{ stdio: "ignore", detached: true, cwd: process.cwd() },
	);
	child.unref();
	// Wait for CDP to be ready.
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const resp = await fetch(`http://localhost:${cdpPort}/json/version`);
			if (resp.ok) {
				const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
				if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
			}
		} catch {
			/* keep waiting */
		}
	}
	return undefined;
}

/** Resolve browser-use env so its ChatOpenAI uses the news role's assigned model (e.g. opencode-go/mimo). */
export async function resolveBrowserUseEnv(
	config: AppConfig,
): Promise<
	{ env: Record<string, string>; modelLabel: string } | { error: string }
> {
	const assignment = assignmentFor(config, "news") ?? config.defaultModel;
	if (!assignment) return { error: "no model assigned to news role" };
	const auth = AuthStorage.create();
	const reg = ModelRegistry.create(auth);
	const model = reg.find(assignment.provider, assignment.modelId);
	if (!model)
		return {
			error: `model ${assignment.provider}/${assignment.modelId} not found`,
		};
	const api = (model as { api?: string }).api ?? "";
	const baseUrl = (model as { baseUrl?: string }).baseUrl;
	const isOpenAiCompat = [
		"openai-completions",
		"openai-responses",
		"openai",
	].includes(api);
	if (!isOpenAiCompat || !baseUrl) {
		return {
			error: `news model ${assignment.provider}/${assignment.modelId} (api=${api}) is not OpenAI-compatible; browser-use cannot use it`,
		};
	}
	const resolved = await reg.getApiKeyAndHeaders(model);
	if (!resolved.ok || !resolved.apiKey)
		return {
			error: `no API key for ${assignment.provider}/${assignment.modelId}`,
		};
	const env: Record<string, string> = {
		OPENAI_API_KEY: resolved.apiKey,
		OPENAI_BASE_URL: baseUrl,
		OPENAI_API_BASE: baseUrl,
		BROWSER_USE_LLM_MODEL: assignment.modelId,
		BROWSER_USE_HEADLESS: "true",
		ANONYMIZED_TELEMETRY: "false",
		BROWSER_USE_TELEMETRY: "false",
		BROWSER_USE_LOGGING_LEVEL: "warning",
	};
	// browser-use 0.1.x daemon needs a CDP WebSocket URL to connect to Chrome.
	// Auto-launch a headless Chrome with remote debugging if BU_CDP_WS is not set.
	const cdpWs = process.env.BU_CDP_WS ?? (await ensureHeadlessChromeCdp());
	if (cdpWs) env.BU_CDP_WS = cdpWs;
	return { env, modelLabel: `${assignment.provider}/${assignment.modelId}` };
}

/** Low-level: run browser-use Agent (via dedicated venv) with CDP-connected browser + Mimo LLM. */
export async function callBrowserUseAgent(
	task: string,
	opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const timeoutMs = opts.timeoutMs ?? 240_000;
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...opts.env,
	};
	const cdpWs = env.BU_CDP_WS;
	if (!cdpWs) return { ok: false, error: "BU_CDP_WS not set" };

	// Python script: create BrowserSession with CDP URL, Agent with Mimo LLM.
	const pyScript = [
		"import asyncio, os, sys",
		"from browser_use import Agent",
		"from browser_use.browser.session import BrowserSession",
		"from browser_use.llm.openai.chat import ChatOpenAI",
		"",
		"session = BrowserSession(cdp_url=os.environ['BU_CDP_WS'], headless=True)",
		"llm = ChatOpenAI(model=os.environ['BROWSER_USE_LLM_MODEL'])",
		"",
		"async def main():",
		"    agent = Agent(task=sys.argv[1], llm=llm, browser_session=session)",
		"    result = await agent.run()",
		"    fr = result.final_result() if hasattr(result, 'final_result') else str(result)",
		"    print(fr)",
		"",
		"asyncio.run(main())",
	].join("\n");

	return new Promise((resolve) => {
		const { spawn } = require("node:child_process");
		const venvPython = join(homedir(), ".bu-venv", "bin", "python3");
		const child = spawn(venvPython, ["-c", pyScript, task], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (err: Error) =>
			resolve({ ok: false, error: err.message }),
		);
		child.on("close", (code: number) => {
			if (code === 0) resolve({ ok: true, text: stdout });
			else
				resolve({
					ok: false,
					error: `exit ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`,
				});
		});
	});
}

/**
 * MERGED News analyst: browser-use browses WITH the analyst persona + investment
 * context + priced-in rule and returns a structured News report. Raw items are
 * cached for reuse. Degrades gracefully on any failure.
 */
export async function runNewsAnalyst(
	ctx: AnalysisContext,
	config: AppConfig,
): Promise<NewsAnalystResult> {
	const envRes = await resolveBrowserUseEnv(config);
	if ("error" in envRes) {
		return { items: [], degraded: true, reason: envRes.error };
	}
	const task = newsAnalystTask(ctx);
	const res = await callBrowserUseAgent(task, {
		env: envRes.env,
		timeoutMs: 300_000,
	});
	if (!res.ok) {
		return { items: [], degraded: true, reason: res.error };
	}
	const parsed = parseNewsReport(res.text, envRes.modelLabel, ctx);
	if (!parsed.report) {
		return {
			items: parsed.items,
			degraded: true,
			reason: "browser-use returned no parseable report",
		};
	}
	cacheNews(`news-${Date.now()}`, { items: parsed.items, degraded: false });
	return { report: parsed.report, items: parsed.items, degraded: false };
}

/** Parse browser-use output into an AgentReport + tagged NewsItems. */
function parseNewsReport(
	text: string,
	modelLabel: string,
	ctx: AnalysisContext,
): { report?: AgentReport; items: NewsItem[] } {
	const obj = extractJsonObject(text);
	if (!obj) return { items: [] };
	const raw = obj as {
		analysis?: unknown;
		stance?: unknown;
		confidence?: unknown;
		keyPoints?: unknown;
		suggestions?: unknown;
		newsItems?: unknown;
	};
	const nowIso = ctx.snapshot.generatedAt;
	const items: NewsItem[] = Array.isArray(raw.newsItems)
		? (raw.newsItems as unknown[])
				.filter(
					(x): x is Record<string, unknown> =>
						typeof x === "object" && x !== null,
				)
				.slice(0, 8)
				.map((it) => {
					const region = (
						String(it.region ?? "US").toUpperCase() === "KR" ? "KR" : "US"
					) as "KR" | "US";
					const date = normalizeDate(String(it.date ?? nowIso));
					const pricedIn = Boolean(it.pricedIn);
					const active = Boolean(it.active);
					const weight =
						pricedIn && !active
							? {
									pricedIn: true,
									active: false,
									reason: "model flagged priced-in (market open on news date)",
								}
							: !pricedIn && active
								? {
										pricedIn: false,
										active: true,
										reason:
											"model flagged active forward signal (market closed)",
									}
								: newsSignalWeight(region, date, nowIso);
					return {
						title: String(it.title ?? it.headline ?? "(untitled)"),
						summary: String(it.summary ?? ""),
						url:
							typeof it.url === "string"
								? it.url
								: typeof it.link === "string"
									? it.link
									: undefined,
						date,
						region,
						source: String(it.source ?? "browser-use"),
						weight,
					};
				})
		: [];
	const stance = (
		["bullish", "bearish", "neutral"].includes(String(raw.stance))
			? String(raw.stance)
			: "neutral"
	) as AgentReport["stance"];
	const report: AgentReport = {
		role: "news",
		model: modelLabel,
		analysis:
			stripJson(text).trim().slice(0, 2000) || String(raw.analysis ?? ""),
		stance,
		confidence:
			typeof raw.confidence === "number"
				? Math.max(0, Math.min(1, raw.confidence))
				: 0.5,
		keyPoints: Array.isArray(raw.keyPoints)
			? (raw.keyPoints as unknown[]).map(String)
			: [],
		suggestions: Array.isArray(raw.suggestions)
			? (raw.suggestions as unknown[]).map(String)
			: [],
	};
	return { report, items };
}

function extractJsonObject(text: string): unknown | undefined {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fence?.[1] ?? text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

function stripJson(text: string): string {
	return text.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
}

function normalizeDate(s: string): string {
	const d = new Date(s);
	return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function cacheNews(key: string, result: NewsResult): void {
	writeJsonFile(`${NEWS_CACHE_DIR}/${key}.json`, result);
}

export function loadCachedNews(key: string): NewsResult | undefined {
	return readJsonFile<NewsResult>(`${NEWS_CACHE_DIR}/${key}.json`);
}
