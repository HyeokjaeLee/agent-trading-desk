import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** App config + runtime data directory. */
export const APP_DIR =
	process.env.TD_HOME ?? join(homedir(), ".agent-trading-desk");

/** User-editable app config (agent→model assignments, settings). */
export const APP_CONFIG_FILE = join(APP_DIR, "config.json");

/** Source-of-truth market snapshot (refreshed by `td market refresh`). */
export const SNAPSHOT_FILE = join(APP_DIR, "market-snapshot.json");

/** Aggregated read-only portfolio cache (refreshed by `td account summary`). */
export const PORTFOLIO_FILE = join(APP_DIR, "portfolio.json");

/** Decision memory directory (prior decisions injected into PM prompt). */
export const MEMORY_DIR = join(APP_DIR, "memory");

/** Decision memory log file. */
export const MEMORY_FILE = join(MEMORY_DIR, "decisions.md");

/** News cache directory. */
export const NEWS_CACHE_DIR = join(APP_DIR, "news-cache");

/** Path to the python yfinance bridge script. */
export function yfinanceScriptPath(): string {
	// Prefer the package-relative location (so global installs / invocations from
	// any CWD still find the bridge), then fall back to CWD/py for source runs.
	const pkgScript = join(
		import.meta.dirname,
		"..",
		"..",
		"py",
		"yfinance_fetch.py",
	);
	if (existsSync(pkgScript)) return pkgScript;
	return join(process.cwd(), "py", "yfinance_fetch.py");
}

/** Temp scratch dir (gitignored). */
export const TMP_DIR = join(process.cwd(), ".pi", "tmp");
