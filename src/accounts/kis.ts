/**
 * Read-only KIS (Korea Investment & Securities) account fetcher.
 *
 * Pulls domestic + overseas balances and the domestic cash deposit for a single
 * KIS profile. Only balance/account/holdings reads are performed — never any
 * order, trade, orderable, or price endpoint.
 */
import { getProfile, KisClient } from "koreainvestment-cli";
import type { Config, Profile } from "koreainvestment-cli";

import type { AccountFetchResult } from "./aggregate.js";

/** Domestic + overseas exchange codes scanned for overseas holdings. */
const OVERSEAS_EXCHANGES = ["NASD", "NYS", "AMEX"] as const;
/** Currencies scanned for overseas holdings (matches TR_CRCY_CD). */
const OVERSEAS_CURRENCIES = ["USD"] as const;

/** Candidate KRW-cash field names in the CTRP6548R `output2` summary. */
const KRW_CASH_FIELDS = [
	"dnca_cash", // 예수금현금 (preferred)
	"prvs_rcdl_excc_amt", // 전일대고객예수금
	"nxdy_excc_amt", // 익일정산금액
] as const;

/** Candidate USD-cash field names in the overseas balance `output2` summary. */
const OVERSEAS_CASH_FIELDS = [
	"frcr_buy_amt_psbl_amt", // 외화매수가능금액
	"ovrs_buy_psbl_amt", // 해외매수가능금액
] as const;

// ---------- numeric helpers ----------

/** Coerce a KIS/Toss numeric value (often comma-padded string) to a finite number. */
export function num(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") {
		const n = Number(value.replace(/[\s,]/g, ""));
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

/** First candidate field that is present and parseable (may be 0). */
function firstNum(
	rec: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const k of keys) {
		const raw = rec[k];
		if (raw === undefined || raw === null || raw === "") continue;
		const n = num(raw);
		if (n !== undefined) return n;
	}
	return undefined;
}

function asSummary(output2: unknown): Record<string, unknown> | undefined {
	if (Array.isArray(output2)) {
		const head = output2[0];
		return typeof head === "object" && head !== null
			? (head as Record<string, unknown>)
			: undefined;
	}
	return typeof output2 === "object" && output2 !== null
		? (output2 as Record<string, unknown>)
		: undefined;
}

function acct(profile: Profile): { CANO: string; ACNT_PRDT_CD: string } {
	return {
		CANO: profile.accountNumber,
		ACNT_PRDT_CD: profile.accountProductCode,
	};
}

// ---------- KIS reads ----------

/** Domestic stock balance (TTTC8434R), paginated up to 10 pages via tr_cont. */
async function fetchDomesticHoldings(
	client: KisClient,
	profile: Profile,
): Promise<{
	rows: Record<string, unknown>[];
	summary?: Record<string, unknown>;
}> {
	const rows: Record<string, unknown>[] = [];
	let summary: Record<string, unknown> | undefined;
	let fk = "";
	let nk = "";
	let trCont: "" | "N" = "";
	for (let page = 0; page < 10; page++) {
		const res = await client.call({
			method: "GET",
			path: "/uapi/domestic-stock/v1/trading/inquire-balance",
			trId: "TTTC8434R",
			trCont,
			query: {
				...acct(profile),
				AFHR_FLPR_YN: "N",
				OFL_YN: "",
				INQR_DVSN: "02",
				UNPR_DVSN: "01",
				FUND_STTL_ICLD_YN: "N",
				FNCG_AMT_AUTO_RDPT_YN: "N",
				PRCS_DVSN: "00",
				CTX_AREA_FK100: fk,
				CTX_AREA_NK100: nk,
			},
		});
		const chunk = (res.output1 as Record<string, unknown>[] | undefined) ?? [];
		rows.push(...chunk);
		if (!summary) summary = asSummary(res.output2);
		fk = String(res.ctx_area_fk100 ?? "").trim();
		nk = String(res.ctx_area_nk100 ?? "").trim();
		if (!nk) break;
		trCont = "N";
	}
	return { rows, summary };
}

/** Domestic account asset status (CTRP6548R) — source of KRW cash. */
async function fetchDomesticAccountBalance(
	client: KisClient,
	profile: Profile,
): Promise<Record<string, unknown> | undefined> {
	const res = await client.call({
		method: "GET",
		path: "/uapi/domestic-stock/v1/trading/inquire-account-balance",
		trId: "CTRP6548R",
		query: {
			...acct(profile),
			INQR_DVSN_1: "",
			BSPR_BF_DT_APLY_YN: "",
		},
	});
	return asSummary(res.output2);
}

/** Overseas stock balance (TTTS3012R) across US exchanges + USD. */
async function fetchOverseasHoldings(
	client: KisClient,
	profile: Profile,
): Promise<{
	rows: Record<string, unknown>[];
	summary?: Record<string, unknown>;
}> {
	const rows: Record<string, unknown>[] = [];
	let summary: Record<string, unknown> | undefined;
	for (const exch of OVERSEAS_EXCHANGES) {
		for (const ccy of OVERSEAS_CURRENCIES) {
			let fk = "";
			let nk = "";
			let trCont: "" | "N" = "";
			for (let page = 0; page < 10; page++) {
				const res = await client.call({
					method: "GET",
					path: "/uapi/overseas-stock/v1/trading/inquire-balance",
					trId: "TTTS3012R",
					trCont,
					query: {
						...acct(profile),
						OVRS_EXCG_CD: exch,
						TR_CRCY_CD: ccy,
						CTX_AREA_FK200: fk,
						CTX_AREA_NK200: nk,
					},
				});
				const chunk =
					(res.output1 as Record<string, unknown>[] | undefined) ?? [];
				rows.push(...chunk);
				if (!summary) summary = asSummary(res.output2);
				fk = String(res.ctx_area_fk200 ?? "").trim();
				nk = String(res.ctx_area_nk200 ?? "").trim();
				if (!nk) break;
				trCont = "N";
			}
		}
	}
	return { rows, summary };
}

// ---------- contribution mapping ----------

/** Map one domestic KIS balance row to a holding contribution. */
function domesticRowToContribution(
	row: Record<string, unknown>,
	profileName: string,
) {
	const symbol = String(row.pdno ?? "").trim();
	const quantity = num(row.hldg_qty);
	if (!symbol || quantity === undefined || quantity <= 0) return undefined;
	return {
		broker: "kis" as const,
		profile: profileName,
		symbol,
		name: typeof row.prdt_name === "string" ? row.prdt_name : undefined,
		market: "KR",
		currency: "KRW",
		quantity,
		averagePrice: num(row.pchs_avg_pric),
		lastPrice: num(row.prpr),
	};
}

/** Map one overseas KIS balance row to a holding contribution. */
function overseasRowToContribution(
	row: Record<string, unknown>,
	profileName: string,
	currency: string,
) {
	const symbol = String(row.ovrs_pdno ?? "").trim();
	const quantity = firstNum(row, ["ovrs_cblc_qty", "hldg_qty"]);
	if (!symbol || quantity === undefined || quantity <= 0) return undefined;
	return {
		broker: "kis" as const,
		profile: profileName,
		symbol,
		name:
			typeof row.ovrs_item_name === "string"
				? row.ovrs_item_name
				: typeof row.prdt_name === "string"
					? row.prdt_name
					: undefined,
		market: "US",
		currency,
		quantity,
		averagePrice: firstNum(row, [
			"frcr_pchs_avg_pric1",
			"pchs_avg_pric",
			"ovrs_avg_pric",
		]),
		lastPrice: firstNum(row, ["ovrs_now_pric", "prpr"]),
	};
}

/**
 * Fetch a single KIS profile's read-only holdings + cash.
 * Never throws — failures are captured in `error` and the result is still returned.
 */
export async function fetchKisAccount(
	config: Config,
	profileName: string,
): Promise<AccountFetchResult> {
	try {
		const profile = getProfile(config, profileName);
		const client = new KisClient({ profileName, profile });

		const holdings: AccountFetchResult["holdings"] = [];
		const cash: AccountFetchResult["cash"] = [];

		// Domestic holdings.
		const dom = await fetchDomesticHoldings(client, profile);
		for (const row of dom.rows) {
			const c = domesticRowToContribution(row, profileName);
			if (c) holdings.push(c);
		}

		// Domestic KRW cash.
		const domSummary = await fetchDomesticAccountBalance(client, profile);
		const krw = firstNum(domSummary ?? {}, KRW_CASH_FIELDS);
		if (krw !== undefined) {
			cash.push({
				broker: "kis",
				profile: profileName,
				currency: "KRW",
				amount: krw,
			});
		}

		// Overseas holdings + (optional) USD cash.
		const ovs = await fetchOverseasHoldings(client, profile);
		for (const row of ovs.rows) {
			const c = overseasRowToContribution(row, profileName, "USD");
			if (c) holdings.push(c);
		}
		const usd = firstNum(ovs.summary ?? {}, OVERSEAS_CASH_FIELDS);
		if (usd !== undefined) {
			cash.push({
				broker: "kis",
				profile: profileName,
				currency: "USD",
				amount: usd,
			});
		}

		return {
			broker: "kis",
			profile: profileName,
			included: true,
			holdings,
			cash,
		};
	} catch (err) {
		return {
			broker: "kis",
			profile: profileName,
			included: false,
			error: err instanceof Error ? err.message : String(err),
			holdings: [],
			cash: [],
		};
	}
}
