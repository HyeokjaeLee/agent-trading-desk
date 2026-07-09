import { existsSync } from "node:fs";
import { NEWS_CACHE_DIR } from "../config/paths.js";
import { newsSignalWeight } from "../market/market-state.js";
import { writeJsonFile, readJsonFile } from "../output.js";

/**
 * News via browser-use (MCP). Primary path spawns the browser-use MCP server:
 *   uvx --from 'browser-use[cli]' browser-use --mcp
 * and drives its autonomous agent tool to find recent news for a query.
 *
 * browser-use needs Playwright + an LLM key (OPENAI_API_KEY by default) and is
 * heavy/slow. When it is unavailable, this module degrades gracefully and
 * returns an empty news set with `degraded:true` so the investment pipeline
 * still runs (the news analyst simply notes "no fresh news available").
 */

export interface NewsItem {
	title: string;
	summary: string;
	url?: string;
	date: string; // ISO
	region: "KR" | "US";
	source: string;
	weight: { pricedIn: boolean; active: boolean; reason: string };
}

export interface NewsResult {
	items: NewsItem[];
	degraded: boolean;
	reason?: string;
}

function findUvx(): string | undefined {
	if (process.env.TD_UVX && existsSync(process.env.TD_UVX))
		return process.env.TD_UVX;
	// browser-use MCP server is invoked via uvx on PATH; assume available.
	return "uvx";
}

/**
 * Drive browser-use to find recent news for each query. Returns structured
 * items. On any failure (not installed, timeout, missing LLM key) degrades.
 */
export async function fetchNews(
	queries: Array<{ query: string; region: "KR" | "US"; ticker?: string }>,
	opts: { nowIso?: string; timeoutMs?: number; llmApiKey?: string } = {},
): Promise<NewsResult> {
	const nowIso = opts.nowIso ?? new Date().toISOString();
	const timeoutMs = opts.timeoutMs ?? 90_000;

	const uvx = findUvx();
	if (!uvx) {
		return {
			items: [],
			degraded: true,
			reason: "uvx not found; install uv to use browser-use news",
		};
	}

	// Lazily import the MCP client so non-news commands stay light.
	let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
	let StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
	try {
		const idx = await import("@modelcontextprotocol/sdk/client/index.js");
		const stdio = await import("@modelcontextprotocol/sdk/client/stdio.js");
		Client = idx.Client;
		StdioClientTransport = stdio.StdioClientTransport;
	} catch (err) {
		return {
			items: [],
			degraded: true,
			reason: `@modelcontextprotocol/sdk not loadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const items: NewsItem[] = [];
	const env: Record<string, string | undefined> = { ...process.env };
	if (opts.llmApiKey) env.OPENAI_API_KEY = opts.llmApiKey;

	let transport: InstanceType<typeof StdioClientTransport> | undefined;
	let client: InstanceType<typeof Client> | undefined;
	try {
		transport = new StdioClientTransport({
			command: uvx,
			args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
			env: env as Record<string, string>,
		});
		client = new Client({ name: "agent-trading-desk", version: "0.1.0" });

		const connectWithTimeout = new Promise<{ ok: boolean; error?: string }>(
			(resolve) => {
				const t = setTimeout(
					() => resolve({ ok: false, error: "MCP connect timeout" }),
					timeoutMs,
				);
				client!
					.connect(transport!)
					.then(() => {
						clearTimeout(t);
						resolve({ ok: true });
					})
					.catch((e: unknown) => {
						clearTimeout(t);
						resolve({
							ok: false,
							error: e instanceof Error ? e.message : String(e),
						});
					});
			},
		);
		const connected = await connectWithTimeout;
		if (!connected.ok) {
			return { items: [], degraded: true, reason: connected.error };
		}

		for (const q of queries) {
			try {
				const res = (await client!.callTool({
					name: "retry_with_browser_use_agent",
					arguments: {
						task: `Find the 3-5 most recent (last 7 days) market-moving news about: ${q.query}. For each, return JSON array of {title, summary, url, date(ISO), source}. Only items that could move the stock price. Today is ${nowIso}.`,
					},
				})) as { content?: Array<{ type: string; text?: string }> };
				const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
				const parsed = parseNewsArray(text, q, nowIso);
				items.push(...parsed);
			} catch {
				// Per-query failure: continue with others.
			}
		}
	} catch (err) {
		return {
			items: [],
			degraded: true,
			reason: err instanceof Error ? err.message : String(err),
		};
	} finally {
		// Always tear down the MCP client + subprocess so a failed connect or a
		// per-query error never leaks the browser-use uvx process.
		try {
			await client?.close?.();
		} catch {
			/* ignore */
		}
		try {
			await transport?.close?.();
		} catch {
			/* ignore */
		}
	}

	if (items.length === 0) {
		return {
			items: [],
			degraded: true,
			reason: "browser-use returned no parseable news",
		};
	}
	return { items, degraded: false };
}

function parseNewsArray(
	text: string,
	q: { query: string; region: "KR" | "US" },
	nowIso: string,
): NewsItem[] {
	// Extract a JSON array from the model/browser output.
	const match = text.match(/\[[\s\S]*\]/);
	if (!match) return [];
	let arr: unknown;
	try {
		arr = JSON.parse(match[0]);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	return arr
		.filter(
			(x): x is Record<string, unknown> => typeof x === "object" && x !== null,
		)
		.slice(0, 5)
		.map((it) => {
			const title = String(it.title ?? it.headline ?? q.query);
			const summary = String(it.summary ?? it.snippet ?? "");
			const url =
				typeof it.url === "string"
					? it.url
					: typeof it.link === "string"
						? it.link
						: undefined;
			const date = normalizeDate(String(it.date ?? nowIso));
			const source = String(it.source ?? "browser-use");
			const weight = newsSignalWeight(q.region, date, nowIso);
			return { title, summary, url, date, region: q.region, source, weight };
		});
}

function normalizeDate(s: string): string {
	const d = new Date(s);
	return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Cache news items to disk for the current run (avoids re-fetching). */
export function cacheNews(key: string, result: NewsResult): void {
	writeJsonFile(`${NEWS_CACHE_DIR}/${key}.json`, result);
}

export function loadCachedNews(key: string): NewsResult | undefined {
	return readJsonFile<NewsResult>(`${NEWS_CACHE_DIR}/${key}.json`);
}
