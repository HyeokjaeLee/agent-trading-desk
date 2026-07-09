import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	TAX_CONTEXT_FILE,
	TAX_CONTEXT_MAX_AGE_MS,
	APP_DIR,
} from "../config/paths.js";

/**
 * Tax/regulatory context — auto-refreshed when stale.
 *
 * No separate command needed. Every time the trading desk runs, this module
 * checks tax-context.md age. If >30 days, it fetches recent KR tax-law headlines
 * via Google News RSS and appends them. The file is injected as a SEPARATE context
 * block into agent prompts (not bloating existing analysis prompts).
 */

/** Extract the "최종 업데이트" date from the tax context file. */
function getTaxContextDate(): Date | undefined {
	if (!existsSync(TAX_CONTEXT_FILE)) return undefined;
	const raw = readFileSync(TAX_CONTEXT_FILE, "utf8");
	const m = raw.match(/최종 업데이트:\s*(\d{4}-\d{2}-\d{2})/);
	if (!m?.[1]) return undefined;
	const d = new Date(m[1]);
	return isNaN(d.getTime()) ? undefined : d;
}

/** Check if the tax context file is stale (>30 days old or missing). */
export function isTaxContextStale(): boolean {
	const d = getTaxContextDate();
	if (!d) return true;
	return Date.now() - d.getTime() > TAX_CONTEXT_MAX_AGE_MS;
}

/** Quick web fetch for recent KR tax-law headlines via Google News RSS. */
async function fetchTaxHeadlines(): Promise<string[]> {
	try {
		const url =
			"https://news.google.com/rss/search?q=" +
			encodeURIComponent("한국 투자 세법 개정 ETF ISA 양도소득세 배당소득세") +
			"&hl=ko&gl=KR&ceid=KR:ko";
		const resp = await fetch(url, {
			headers: { "user-agent": "Mozilla/5.0" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!resp.ok) return [];
		const xml = await resp.text();
		const titles: string[] = [];
		const re = /<title>(.*?)<\/title>/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(xml)) && titles.length < 10) {
			const t = m[1]!.trim();
			if (!t.startsWith("Google") && t.length > 10) titles.push(t);
		}
		return titles;
	} catch {
		return [];
	}
}

/**
 * Ensure the tax context is fresh. If stale, fetch recent KR tax headlines and
 * append them. Returns the full tax context string for agent injection.
 */
export async function ensureTaxContextFresh(): Promise<{
	context: string;
	stale: boolean;
	updated: boolean;
}> {
	const stale = isTaxContextStale();
	let updated = false;

	if (stale) {
		const headlines = await fetchTaxHeadlines();
		if (headlines.length > 0) {
			const stamp = new Date().toISOString().slice(0, 10);
			const block =
				`\n## 자동 감지된 최근 세법 관련 뉴스 (${stamp})\n` +
				headlines.map((h) => `- ${h}`).join("\n") +
				"\n";
			const existing = existsSync(TAX_CONTEXT_FILE)
				? readFileSync(TAX_CONTEXT_FILE, "utf8")
				: "";
			const updated_content = existing.replace(
				/최종 업데이트:\s*\d{4}-\d{2}-\d{2}/,
				`최종 업데이트: ${stamp}`,
			);
			if (!existsSync(dirname(TAX_CONTEXT_FILE)))
				mkdirSync(dirname(TAX_CONTEXT_FILE), { recursive: true });
			writeFileSync(TAX_CONTEXT_FILE, updated_content + block, { mode: 0o600 });
			updated = true;
		}
	}

	const context = loadTaxContext();
	return { context, stale: stale && !updated, updated };
}

/** Load the tax context file as a string (for agent injection). */
export function loadTaxContext(): string {
	if (!existsSync(TAX_CONTEXT_FILE)) {
		return [
			"⚠️ 세법 컨텍스트 파일이 없습니다. 투자 결정 전 한국 세법을 별도 확인하세요.",
			"핵심: 국내 상장 해외 ETF 매매차익=15.4% 배당소득세, 해외 직투=22% 양도소득세(250만원 공제).",
			"ISA 내 국내 상장 ETF 매매차익=비과세. ISA 매도는 신중해야 함.",
		].join("\n");
	}
	return readFileSync(TAX_CONTEXT_FILE, "utf8");
}
