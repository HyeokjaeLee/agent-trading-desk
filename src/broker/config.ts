import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Brokerage config + credential storage.
 *
 * Reads the SHARED ~/.kis-cli/config.yaml (managed by `kis auth login` /
 * `toss auth login`) so accounts already registered on this machine work with
 * zero migration. This module reimplements the read paths natively — there is
 * NO runtime dependency on the koreainvestment-cli package.
 */

export interface Profile {
	env: "prod" | "paper";
	appKey: string;
	appSecret: string;
	/** 계좌번호 앞 8자리 (CANO). */
	accountNumber: string;
	/** 계좌상품코드 (ACNT_PRDT_CD). 종합=01, … */
	accountProductCode: string;
	htsId?: string;
}

export interface TossProfile {
	clientId: string;
	clientSecret: string;
	accountSeq?: string;
	accountNo?: string;
	accountType?: string;
}

export interface Config {
	defaultProfile: string;
	profiles: Record<string, Profile>;
	tossDefaultProfile: string;
	tossProfiles: Record<string, TossProfile>;
}

export interface CachedToken {
	accessToken: string;
	/** ISO-8601 expiry. */
	expiresAt: string;
	profile: string;
}

export type TokenCache = Record<string, CachedToken>;

export const CONFIG_DIR =
	process.env.KIS_CLI_HOME ?? join(homedir(), ".kis-cli");
export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
export const TOKEN_CACHE_FILE = join(CONFIG_DIR, "tokens.json");

function defaultConfig(): Config {
	return {
		defaultProfile: "paper",
		profiles: {},
		tossDefaultProfile: "default",
		tossProfiles: {},
	};
}

/** Load the shared brokerage config (~/.kis-cli/config.yaml). */
export function loadConfig(): Config {
	if (!existsSync(CONFIG_FILE)) return defaultConfig();
	try {
		const raw = readFileSync(CONFIG_FILE, "utf8");
		const parsed = (parseYaml(raw) ?? {}) as Partial<Config>;
		return {
			defaultProfile: parsed.defaultProfile ?? "paper",
			profiles: parsed.profiles ?? {},
			tossDefaultProfile: parsed.tossDefaultProfile ?? "default",
			tossProfiles: parsed.tossProfiles ?? {},
		};
	} catch {
		return defaultConfig();
	}
}

/** Persist config (used only by account-registration helpers). */
export function saveConfig(config: Config): void {
	if (!existsSync(CONFIG_DIR))
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(CONFIG_FILE, stringifyYaml(config), { mode: 0o600 });
	try {
		chmodSync(CONFIG_FILE, 0o600);
	} catch {
		/* ignore */
	}
}

export function getProfile(config: Config, name?: string): Profile {
	const target = name ?? config.defaultProfile;
	const profile = config.profiles[target];
	if (!profile) {
		throw new Error(
			`Profile "${target}" not found. Run 'kis auth login' to create one.`,
		);
	}
	return profile;
}

export function getTossProfile(config: Config, name?: string): TossProfile {
	const target = name ?? config.tossDefaultProfile;
	const profile = config.tossProfiles[target];
	if (!profile) {
		throw new Error(
			`Toss profile "${target}" not found. Run 'toss auth login' to create one.`,
		);
	}
	return profile;
}

/** Toss token cache key (namespaced to avoid clashing with KIS keys). */
export function tossTokenCacheKey(name: string): string {
	return `toss:${name}`;
}

export function loadTokenCache(): TokenCache {
	if (!existsSync(TOKEN_CACHE_FILE)) return {};
	try {
		return JSON.parse(readFileSync(TOKEN_CACHE_FILE, "utf8")) as TokenCache;
	} catch {
		return {};
	}
}

export function saveTokenCache(cache: TokenCache): void {
	if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), {
		mode: 0o600,
	});
	try {
		chmodSync(TOKEN_CACHE_FILE, 0o600);
	} catch {
		/* ignore */
	}
}

export function isTokenFresh(token: CachedToken, bufferSeconds = 300): boolean {
	const expiry = new Date(token.expiresAt).getTime();
	return Number.isFinite(expiry) && expiry - Date.now() > bufferSeconds * 1000;
}

// KIS responses encode expiry as "YYYY-MM-DD HH:mm:ss" (KST) — interpret as +09:00.
export function normalizeKisExpiry(raw: string): string {
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(raw)) {
		const d = new Date(raw.replace(" ", "T") + "+09:00");
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	const d = new Date(raw);
	if (!Number.isNaN(d.getTime())) return d.toISOString();
	return new Date(Date.now() + 86_400 * 1000).toISOString();
}

void dirname;
