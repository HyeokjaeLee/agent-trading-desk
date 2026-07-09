import { http, safeJson } from "./http.js";
import {
	type CachedToken,
	type TossProfile,
	isTokenFresh,
	loadTokenCache,
	saveTokenCache,
	tossTokenCacheKey,
} from "./config.js";

/**
 * Native Toss Securities Open API client — READ-ONLY.
 * Ported from koreainvestment-cli's toss/client.ts + auth.ts; no package dep.
 * Only account-read methods are implemented (getAccounts/getHoldings/getBuyingPower).
 */

export const TOSS_BASE_URL = "https://openapi.tossinvest.com";

/** Read-only account/holding/buying-power shapes consumed by the aggregator. */
export interface TossAccount {
	accountSeq: string;
	accountNo?: string;
	accountType?: string;
}
export interface TossHolding {
	symbol: string;
	name?: string;
	quantity: number | string;
	averagePurchasePrice?: number | string;
	lastPrice?: number | string;
	currency?: string;
	marketCountry?: string;
	profitLoss?: { rate?: number | string };
}
export interface TossBuyingPower {
	currency: string;
	cashBuyingPower: number | string;
}

interface TossEnvelope<T> {
	result: T;
}

/** Issue a Toss OAuth2 client-credentials token (POST /oauth2/token). */
export async function issueTossAccessToken(
	profile: TossProfile,
): Promise<CachedToken> {
	const url = `${TOSS_BASE_URL}/oauth2/token`;
	const form = new URLSearchParams();
	form.set("grant_type", "client_credentials");
	form.set("client_id", profile.clientId);
	form.set("client_secret", profile.clientSecret);
	const { status, text } = await http(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: form.toString(),
	});
	if (status !== 200)
		throw new Error(`토스 접근 토큰 발급 실패 (HTTP ${status}): ${text}`);
	const data = JSON.parse(text) as {
		access_token: string;
		expires_in?: number;
	};
	if (!data.access_token)
		throw new Error(`접근 토큰 발급 응답에 access_token 이 없습니다: ${text}`);
	const expiresAt = new Date(
		Date.now() + (data.expires_in ?? 86_399) * 1000,
	).toISOString();
	return { accessToken: data.access_token, expiresAt, profile: "__pending__" };
}

/** Reuse a cached Toss token if fresh, else issue + cache it (key: toss:<name>). */
export async function getOrIssueTossToken(
	profileName: string,
	profile: TossProfile,
	options: { forceRefresh?: boolean } = {},
): Promise<string> {
	const cache = loadTokenCache();
	const key = tossTokenCacheKey(profileName);
	const cached = cache[key];
	if (!options.forceRefresh && cached && isTokenFresh(cached))
		return cached.accessToken;
	const record: CachedToken = {
		...(await issueTossAccessToken(profile)),
		profile: profileName,
	};
	cache[key] = record;
	saveTokenCache(cache);
	return record.accessToken;
}

export interface TossClientOptions {
	profileName: string;
	profile: TossProfile;
}

type QueryValue = string | number | boolean | undefined;

export class TossClient {
	readonly profileName: string;
	readonly profile: TossProfile;

	constructor(opts: TossClientOptions) {
		this.profileName = opts.profileName;
		this.profile = opts.profile;
	}

	async call<T>(options: {
		method: "GET" | "POST";
		path: string;
		query?: Record<string, QueryValue>;
		body?: unknown;
		account?: string;
	}): Promise<T> {
		const url = new URL(options.path, TOSS_BASE_URL);
		if (options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				if (value === undefined) continue;
				url.searchParams.set(key, String(value));
			}
		}

		const headers: Record<string, string> = {
			authorization: `Bearer ${await getOrIssueTossToken(this.profileName, this.profile)}`,
		};
		if (options.account) headers["x-tossinvest-account"] = options.account;

		const init: RequestInit & { method: string } = {
			method: options.method,
			headers,
		};
		if (options.method === "POST") {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(options.body ?? {});
		}

		const { status, text } = await http(url.toString(), init);
		if (status < 200 || status >= 300) {
			const parsed = safeJson(text) as
				| { error?: { code?: string; message?: string } }
				| undefined;
			const message =
				parsed?.error?.message ?? `${options.path} 호출 실패 (HTTP ${status})`;
			throw new Error(message);
		}
		return safeJson(text) as T;
	}

	/** GET /api/v1/accounts (no account header). */
	async getAccounts<T = TossAccount>(): Promise<T[]> {
		const body = await this.call<TossEnvelope<T[]>>({
			method: "GET",
			path: "/api/v1/accounts",
		});
		return body.result;
	}

	/** GET /api/v1/holdings (account header). */
	async getHoldings<T = TossHolding>(opts: {
		accountSeq: string;
		symbol?: string;
	}): Promise<T[]> {
		const body = await this.call<TossEnvelope<{ items: T[] }>>({
			method: "GET",
			path: "/api/v1/holdings",
			account: opts.accountSeq,
			query: { symbol: opts.symbol },
		});
		return body.result.items;
	}

	/** GET /api/v1/buying-power (account header). */
	async getBuyingPower<T = TossBuyingPower>(opts: {
		accountSeq: string;
		currency: string;
	}): Promise<T> {
		const body = await this.call<TossEnvelope<T>>({
			method: "GET",
			path: "/api/v1/buying-power",
			account: opts.accountSeq,
			query: { currency: opts.currency },
		});
		return body.result;
	}
}
