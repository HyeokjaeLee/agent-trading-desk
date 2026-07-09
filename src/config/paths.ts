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


/** Temp scratch dir (gitignored). */
export const TMP_DIR = join(process.cwd(), ".pi", "tmp");
