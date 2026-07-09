/**
 * Read-only brokerage account aggregation layer.
 *
 * Combines KIS + Toss accounts into one unified portfolio (cash + holdings),
 * keyed by canonical yfinance ticker. A single exported `aggregatePortfolio`
 * function fetches each enabled account defensively (per-account try/catch),
 * so one failing account never aborts the snapshot.
 */
import { loadConfig, type Config } from "../broker/index.js";

import { mapToYahoo } from "../market/ticker-map.js";
import type {
	AggregatedPortfolio,
	BrokerageAccountRef,
	CashPosition,
	Holding,
} from "../types.js";
import { fetchKisAccount } from "./kis.js";
import { fetchTossAccount } from "./toss.js";

// ---------- shared fetch contract (owned by the aggregator) ----------

/** A single holding contribution from one account. */
export interface HoldingContribution {
	broker: string;
	profile: string;
	symbol: string;
	name?: string;
	market: string;
	currency: string;
	quantity: number;
	averagePrice?: number;
	lastPrice?: number;
}

/** A single cash contribution from one account. */
export interface CashContribution {
	broker: string;
	profile: string;
	currency: string;
	amount: number;
}

/** Uniform result of fetching one account's read-only state. */
export interface AccountFetchResult {
	broker: "kis" | "toss";
	profile: string;
	/** true when the fetch succeeded (even if empty). */
	included: boolean;
	error?: string;
	holdings: HoldingContribution[];
	cash: CashContribution[];
}

/** Account selector passed to `aggregatePortfolio`. */
export interface EnabledAccount {
	broker: "kis" | "toss";
	profile: string;
}

export interface AggregateOptions {
	/** Override the snapshot timestamp (ISO). Defaults to now. */
	asOf?: string;
}

// ---------- profile enumeration ----------

/**
 * Enumerate all configured brokerage accounts from ~/.kis-cli/config.yaml.
 * Used to discover what can be passed to `aggregatePortfolio`.
 */
export function listConfiguredAccounts(config: Config): BrokerageAccountRef[] {
	const refs: BrokerageAccountRef[] = [];
	for (const [name, profile] of Object.entries(config.profiles)) {
		refs.push({
			broker: "kis",
			profile: name,
			label: `KIS ${name} (${profile.env})`,
			paper: profile.env === "paper",
		});
	}
	for (const [name] of Object.entries(config.tossProfiles)) {
		refs.push({
			broker: "toss",
			profile: name,
			label: `Toss ${name}`,
		});
	}
	return refs;
}

// ---------- aggregation ----------

interface HoldingAccum {
	ticker: string;
	symbol: string;
	market: string;
	currency: string;
	name?: string;
	lastPrice?: number;
	quantity: number;
	cost: number; // sum(averagePrice * qty)
	costQty: number; // sum(qty where averagePrice defined)
	breakdown: NonNullable<Holding["breakdown"]>;
}

/** Merge all account results into the final AggregatedPortfolio. */
function mergeResults(
	results: AccountFetchResult[],
	asOf: string,
): AggregatedPortfolio {
	const byTicker = new Map<string, HoldingAccum>();

	for (const result of results) {
		for (const c of result.holdings) {
			const mapped = mapToYahoo(c.symbol, c.market);
			const acc = byTicker.get(mapped.ticker) ?? {
				ticker: mapped.ticker,
				symbol: mapped.symbol,
				market: mapped.market,
				currency: c.currency,
				name: c.name,
				lastPrice: c.lastPrice,
				quantity: 0,
				cost: 0,
				costQty: 0,
				breakdown: [],
			};
			acc.quantity += c.quantity;
			if (c.averagePrice !== undefined) {
				acc.cost += c.averagePrice * c.quantity;
				acc.costQty += c.quantity;
			}
			if (acc.lastPrice === undefined && c.lastPrice !== undefined) {
				acc.lastPrice = c.lastPrice;
			}
			if (!acc.name && c.name) acc.name = c.name;
			acc.breakdown.push({
				broker: c.broker,
				profile: c.profile,
				quantity: c.quantity,
				averagePrice: c.averagePrice,
			});
			byTicker.set(mapped.ticker, acc);
		}
	}

	const holdings: Holding[] = [];
	const byCurrency: Record<string, number> = {};
	for (const acc of byTicker.values()) {
		const averagePrice = acc.costQty > 0 ? acc.cost / acc.costQty : undefined;
		const costBasis =
			averagePrice !== undefined ? averagePrice * acc.quantity : undefined;
		const lastPrice = acc.lastPrice;
		holdings.push({
			ticker: acc.ticker,
			symbol: acc.symbol,
			name: acc.name,
			market: acc.market,
			currency: acc.currency,
			quantity: acc.quantity,
			averagePrice,
			lastPrice,
			costBasis,
			breakdown: acc.breakdown,
		});
		// Market value: prefer last price, fall back to cost basis.
		const marketValue =
			(lastPrice !== undefined ? lastPrice * acc.quantity : costBasis) ?? 0;
		byCurrency[acc.currency] = (byCurrency[acc.currency] ?? 0) + marketValue;
	}

	// Cash: group contributions by currency, sum, record sources.
	const cashByCurrency = new Map<
		string,
		{ amount: number; sources: CashPosition["sources"] }
	>();
	for (const result of results) {
		for (const c of result.cash) {
			const key = c.currency.toUpperCase();
			const entry = cashByCurrency.get(key) ?? { amount: 0, sources: [] };
			entry.amount += c.amount;
			entry.sources.push({ broker: c.broker, profile: c.profile });
			cashByCurrency.set(key, entry);
		}
	}
	const cash: CashPosition[] = [];
	for (const [currency, entry] of cashByCurrency) {
		byCurrency[currency] = (byCurrency[currency] ?? 0) + entry.amount;
		cash.push({
			currency,
			amount: entry.amount,
			sources: entry.sources,
		});
	}

	const accounts = results.map((r) => ({
		broker: r.broker,
		profile: r.profile,
		included: r.included,
		error: r.error,
	}));

	return {
		asOf,
		cash,
		holdings,
		totals: { byCurrency },
		accounts,
	};
}

/**
 * Fetch and aggregate all enabled accounts into one read-only portfolio.
 *
 * Each account is fetched independently and defensively: a failure is recorded
 * on the account entry and does not abort the snapshot. Only balance, holdings,
 * and buying-power endpoints are ever called — no order/trade endpoints.
 */
export async function aggregatePortfolio(
	enabled: EnabledAccount[],
	opts?: AggregateOptions,
): Promise<AggregatedPortfolio> {
	const config = await loadConfig();

	const results: AccountFetchResult[] = [];
	for (const acct of enabled) {
		const result =
			acct.broker === "kis"
				? await fetchKisAccount(config, acct.profile)
				: await fetchTossAccount(config, acct.profile);
		results.push(result);
	}

	const asOf = opts?.asOf ?? new Date().toISOString();
	return mergeResults(results, asOf);
}
