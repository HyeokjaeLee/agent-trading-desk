import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	APP_CONFIG_FILE,
	APP_DIR,
	MEMORY_DIR,
	NEWS_CACHE_DIR,
} from "./paths.js";
import type { AgentRole, RoleAssignment } from "../types.js";

/** User app config. */
export interface AppConfig {
	/** Which accounts are enabled for aggregation. */
	accounts: Array<{ broker: "kis" | "toss"; profile: string; label?: string }>;
	/** Model assignment per agent role. */
	assignments: RoleAssignment[];
	/** Default model used when a role has no explicit assignment. */
	defaultModel?: { provider: string; modelId: string };
	/** Number of debate rounds (bull/bear). */
	debateRounds: number;
	/** Whether to fetch news via browser-use. */
	newsEnabled: boolean;
	/** Analysis "as of" override for backtesting (ISO date or YYYY-MM-DD). */
	asOfDate?: string;
	/** Whether to ignore fresh data and use only the snapshot (backtest mode). */
	blindMode?: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
	accounts: [],
	assignments: [],
	debateRounds: 1,
	newsEnabled: true,
};

export function ensureAppDir(): void {
	if (!existsSync(APP_DIR))
		mkdirSync(APP_DIR, { recursive: true, mode: 0o700 });
	if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
	if (!existsSync(NEWS_CACHE_DIR))
		mkdirSync(NEWS_CACHE_DIR, { recursive: true });
}

export function loadConfig(): AppConfig {
	ensureAppDir();
	if (!existsSync(APP_CONFIG_FILE)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(APP_CONFIG_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<AppConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: AppConfig): void {
	ensureAppDir();
	const dir = dirname(APP_CONFIG_FILE);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(APP_CONFIG_FILE, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
	try {
		chmodSync(APP_CONFIG_FILE, 0o600);
	} catch {
		/* ignore */
	}
}

/** Get the model assignment for a role, falling back to defaultModel. */
export function assignmentFor(
	config: AppConfig,
	role: AgentRole,
): { provider: string; modelId: string } | undefined {
	const found = config.assignments.find((a) => a.role === role);
	if (found) return { provider: found.provider, modelId: found.modelId };
	return config.defaultModel;
}

export function setAssignment(
	config: AppConfig,
	role: AgentRole,
	provider: string,
	modelId: string,
): AppConfig {
	const next: AppConfig = {
		...config,
		assignments: config.assignments.filter((a) => a.role !== role),
	};
	next.assignments.push({ role, provider, modelId });
	return next;
}
