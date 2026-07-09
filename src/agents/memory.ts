import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { MEMORY_FILE, MEMORY_DIR } from "../config/paths.js";
import type { Recommendation } from "../types.js";

/** Append a decision to the persistent memory log (for future reflection). */
export function recordDecision(rec: Recommendation): void {
	if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
	const date = rec.snapshotGeneratedAt ?? new Date().toISOString();
	const positions = rec.positions
		.map((p) => `${p.ticker}:${p.action}@${p.confidence.toFixed(2)}`)
		.join(" ");
	const line = `- ${date} [${rec.objective}] ${positions} :: ${rec.strategy.replace(/\s+/g, " ").slice(0, 200)}\n`;
	appendFileSync(MEMORY_FILE, line, { encoding: "utf8" });
}

/** Return prior decisions mentioning any of the given tickers (compact digest). */
export function loadRelevantMemory(
	tickers: string[],
	limit = 12,
): string | undefined {
	if (!existsSync(MEMORY_FILE)) return undefined;
	const raw = readFileSync(MEMORY_FILE, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().startsWith("-"));
	if (lines.length === 0) return undefined;
	const matched = lines.filter((l) => tickers.some((t) => l.includes(t)));
	const chosen = (matched.length > 0 ? matched : lines).slice(-limit);
	return chosen.join("\n   ");
}
