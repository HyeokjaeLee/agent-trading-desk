import { http, safeJson } from "./http.js";
import {
	type CachedToken,
	type Profile,
	isTokenFresh,
	loadTokenCache,
	normalizeKisExpiry,
	saveTokenCache,
} from "./config.js";

/**
 * Native Korea Investment & Securities (KIS) Open API client — read-only.
 * Ported from koreainvestment-cli's kis/client.ts + auth.ts; no package dep.
 */

export type KisEnv = "prod" | "paper";

export const BASE_URLS: Record<KisEnv, string> = {
	prod: "https://openapi.koreainvestment.com:9443",
	paper: "https://openapivts.koreainvestment.com:29443",
};

/** Issue a KIS access token (POST /oauth2/tokenP). */
export async function issueAccessToken(profile: Profile): Promise<CachedToken> {
	const url = `${BASE_URLS[profile.env]}/oauth2/tokenP`;
	const { status, text } = await http(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			grant_type: "client_credentials",
			appkey: profile.appKey,
			appsecret: profile.appSecret,
		}),
	});
	if (status !== 200)
		throw new Error(`접근 토큰 발급 실패 (HTTP ${status}): ${text}`);
	const data = JSON.parse(text) as {
		access_token: string;
		access_token_token_expired?: string;
		expires_in?: number;
	};
	if (!data.access_token)
		throw new Error(`접근 토큰 발급 응답에 access_token 이 없습니다: ${text}`);
	const expiresAt = data.access_token_token_expired
		? normalizeKisExpiry(data.access_token_token_expired)
		: new Date(Date.now() + (data.expires_in ?? 86_400) * 1000).toISOString();
	return { accessToken: data.access_token, expiresAt, profile: "__pending__" };
}

/** Reuse a cached token if fresh, else issue + cache it. */
export async function getOrIssueToken(
	profileName: string,
	profile: Profile,
	options: { forceRefresh?: boolean } = {},
): Promise<string> {
	const cache = loadTokenCache();
	const cached = cache[profileName];
	if (!options.forceRefresh && cached && isTokenFresh(cached))
		return cached.accessToken;
	const record: CachedToken = {
		...(await issueAccessToken(profile)),
		profile: profileName,
	};
	cache[profileName] = record;
	saveTokenCache(cache);
	return record.accessToken;
}

/** Paper-trading swaps T/J-prefix TR_IDs to their V counterpart. */
export function resolveTrId(prodTrId: string, env: KisEnv): string {
	if (
		env === "paper" &&
		(prodTrId.startsWith("T") || prodTrId.startsWith("J"))
	) {
		return `V${prodTrId.slice(1)}`;
	}
	return prodTrId;
}

/** Polite delay between calls (paper has stricter rate limits). */
export function smartSleepMs(env: KisEnv): number {
	return env === "prod" ? 50 : 500;
}

export type TrCont = "" | "N" | "F" | "M" | "D" | "E";

export interface KisRequestOptions {
	method: "GET" | "POST";
	path: string;
	trId: string;
	query?: Record<string, string | number | undefined>;
	body?: Record<string, unknown>;
	trCont?: TrCont;
	skipAuth?: boolean;
}

export interface KisBaseResponse<T = unknown> {
	rt_cd: string;
	msg_cd?: string;
	msg1?: string;
	output?: T;
	output1?: unknown;
	output2?: unknown;
	ctx_area_fk100?: string;
	ctx_area_nk100?: string;
	[key: string]: unknown;
}

export interface KisClientOptions {
	profileName: string;
	profile: Profile;
}

let lastCallAt = 0;

async function smartSleep(env: KisEnv): Promise<void> {
	const gap = smartSleepMs(env);
	const since = Date.now() - lastCallAt;
	if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
	lastCallAt = Date.now();
}

export class KisClient {
	readonly profileName: string;
	readonly profile: Profile;

	constructor(opts: KisClientOptions) {
		this.profileName = opts.profileName;
		this.profile = opts.profile;
	}

	async call<T = unknown>(
		options: KisRequestOptions,
	): Promise<KisBaseResponse<T>> {
		await smartSleep(this.profile.env);

		const trId = resolveTrId(options.trId, this.profile.env);
		const headers: Record<string, string> = {
			"content-type": "application/json; charset=utf-8",
			appkey: this.profile.appKey,
			appsecret: this.profile.appSecret,
			tr_id: trId,
			custtype: "P",
			tr_cont: options.trCont ?? "",
		};
		if (!options.skipAuth) {
			headers.authorization = `Bearer ${await getOrIssueToken(this.profileName, this.profile)}`;
		}

		const baseUrl = BASE_URLS[this.profile.env];
		const url = new URL(options.path, baseUrl);
		if (options.method === "GET" && options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				if (value === undefined) continue;
				url.searchParams.set(key, String(value));
			}
		}

		const init: RequestInit & { method: string } = {
			method: options.method,
			headers,
		};
		if (options.method === "POST") {
			init.body = JSON.stringify(options.body ?? {});
		}

		const { status, text } = await http(url.toString(), init);
		if (status < 200 || status >= 300) {
			throw new Error(`${options.path} 호출 실패 (HTTP ${status}): ${text}`);
		}
		const parsed = safeJson(text) as KisBaseResponse<T> | undefined;
		if (!parsed) {
			throw new Error(`KIS 응답을 JSON 으로 파싱하지 못했습니다: ${text}`);
		}
		if (parsed.rt_cd && parsed.rt_cd !== "0") {
			throw new Error(
				`${parsed.msg_cd ?? "KIS_ERR"}: ${parsed.msg1 ?? "알 수 없는 오류"}`,
			);
		}
		return parsed;
	}
}
