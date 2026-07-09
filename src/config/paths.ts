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

/** Tax/regulatory context file (KR tax rules, ISA/IRP profile, auto-refreshed). */
export const TAX_CONTEXT_FILE = join(APP_DIR, "tax-context.md");

/** Max age (ms) before tax context is considered stale and auto-refreshed. */
export const TAX_CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Temp scratch dir (gitignored). */
export const TMP_DIR = join(process.cwd(), ".pi", "tmp");
