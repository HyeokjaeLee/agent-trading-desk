/**
 * Read-only Toss Securities account fetcher.
 *
 * Pulls linked accounts, holdings, and buying power (cash) for a single Toss
 * profile. Only account/holdings/buying-power reads — never any order/trade
 * endpoint.
 *
 * NOTE: `getTossProfile` exists in koreainvestment-cli's config/storage.ts but
 * is NOT re-exported from the package entrypoint. Its (trivial) resolution is
 * inlined here so the public import surface stays to what the package exports.
 */
import { TossClient } from "koreainvestment-cli";
import type { Config, TossProfile } from "koreainvestment-cli";

import { num } from "./kis.js";
import type { AccountFetchResult } from "./aggregate.js";

/** Resolve a Toss profile by name, mirroring the package's getTossProfile. */
export function resolveTossProfile(config: Config, name?: string): TossProfile {
	const target = name ?? config.tossDefaultProfile;
	const profile = config.tossProfiles[target];
	if (!profile) {
		throw new Error(
			`Toss profile "${target}" not found. Run 'toss auth login' to create one.`,
		);
	}
	return profile;
}

/** Resolve the accountSeq: explicit profile value, else the first linked account. */
async function resolveAccountSeq(
	client: TossClient,
	profile: TossProfile,
): Promise<string> {
	const explicit = profile.accountSeq;
	if (explicit) return explicit;
	const accounts = await client.getAccounts();
	const first = accounts[0];
	if (!first) {
		throw new Error(
			"Toss profile has no accountSeq and no linked accounts were found.",
		);
	}
	return String(first.accountSeq);
}

/** Map marketCountry (e.g. "KR"/"US") to a canonical market region. */
function marketOf(marketCountry: string): string {
	const up = marketCountry.trim().toUpperCase();
	return up || "KR";
}

/**
 * Fetch a single Toss profile's read-only holdings + cash.
 * Never throws — failures are captured in `error` and the result is still returned.
 */
export async function fetchTossAccount(
	config: Config,
	profileName: string,
): Promise<AccountFetchResult> {
	try {
		const profile = resolveTossProfile(config, profileName);
		const client = new TossClient({ profileName, profile });

		const accountSeq = await resolveAccountSeq(client, profile);

		const holdings: AccountFetchResult["holdings"] = [];
		const cash: AccountFetchResult["cash"] = [];

		// Holdings.
		const tossHoldings = await client.getHoldings({ accountSeq });
		for (const h of tossHoldings) {
			const symbol = String(h.symbol ?? "").trim();
			const quantity = num(h.quantity);
			if (!symbol || quantity === undefined || quantity <= 0) continue;
			holdings.push({
				broker: "toss",
				profile: profileName,
				symbol,
				name: h.name || undefined,
				market: marketOf(h.marketCountry),
				currency: h.currency,
				quantity,
				averagePrice: num(h.averagePurchasePrice),
				lastPrice: num(h.lastPrice),
			});
		}

		// Buying power (cash) per currency.
		const krw = await client.getBuyingPower({ accountSeq, currency: "KRW" });
		cash.push({
			broker: "toss",
			profile: profileName,
			currency: krw.currency || "KRW",
			amount: num(krw.cashBuyingPower) ?? 0,
		});

		const usd = await client.getBuyingPower({ accountSeq, currency: "USD" });
		cash.push({
			broker: "toss",
			profile: profileName,
			currency: usd.currency || "USD",
			amount: num(usd.cashBuyingPower) ?? 0,
		});

		return {
			broker: "toss",
			profile: profileName,
			included: true,
			holdings,
			cash,
		};
	} catch (err) {
		return {
			broker: "toss",
			profile: profileName,
			included: false,
			error: err instanceof Error ? err.message : String(err),
			cash: [],
			holdings: [],
		};
	}
}
