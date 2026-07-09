import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	renameSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";

/**
 * Agent-friendly output. Every command prints either a human table or
 * stable JSON (with --json). JSON output goes to stdout, errors to stderr.
 * Exit codes: 0 success, 1 runtime error, 2 usage error.
 */

export interface OutputOptions {
	json: boolean;
}

/** Print a value as JSON to stdout. */
export function outputJson(value: unknown): void {
	process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Print a plain message (human mode). */
export function out(text: string): void {
	process.stdout.write(text + "\n");
}

/** Print an error to stderr and exit. */
export function fail(message: string, code = 1): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(code);
}

/** Render a simple ASCII table from an array of records. */
export function printTable(
	rows: Array<Record<string, unknown>>,
	columns?: string[],
): void {
	if (rows.length === 0) {
		out("(no rows)");
		return;
	}
	const cols = columns ?? Object.keys(rows[0]!);
	const header = cols.join(" | ");
	const sep = cols.map((c) => "-".repeat(Math.max(c.length, 4))).join("-+-");
	out(header);
	out(sep);
	for (const row of rows) {
		out(cols.map((c) => fmtCell(row[c])).join(" | "));
	}
}

function fmtCell(v: unknown): string {
	if (v === undefined || v === null) return "";
	if (typeof v === "number") {
		if (!isFinite(v)) return "";
		if (Number.isInteger(v)) return String(v);
		return v.toFixed(2);
	}
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

/** Format a number as currency-ish. */
export function fmtMoney(n: number | undefined, currency = ""): string {
	if (n === undefined || !isFinite(n)) return "-";
	const s =
		Math.abs(n) >= 1_000_000
			? (n / 1_000_000).toFixed(2) + "M"
			: Math.abs(n) >= 1_000
				? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
				: n.toFixed(2);
	return currency ? `${s} ${currency}` : s;
}

/** Format a ratio/percent. */
export function fmtPct(n: number | undefined): string {
	if (n === undefined || !isFinite(n)) return "-";
	return (n * 100).toFixed(1) + "%";
}

/** Read a JSON file, returning undefined if missing/invalid. */
export function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Write a JSON file (0600), atomically (temp + rename) to avoid corruption. */
export function writeJsonFile(path: string, value: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, path);
}
