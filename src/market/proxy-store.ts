/**
 * JSON-based proxy map store. Replaces the hardcoded proxy arrays in proxies.ts
 * so new leading-indicator relationships (e.g. a freshly listed ADR) can be
 * added via `td proxy add` without code changes.
 *
 * The map lives at ~/.agent-trading-desk/proxy-map.json. On first load, if the
 * file is absent it is seeded with the current hardcoded relationships plus the
 * SK Hynix ADR (HXSK), then read back.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../config/paths.js";

/** A proxy relationship entry. */
export interface ProxyEntry {
	ticker: string;
	name: string;
	relation: string;
}

/** A category of tickers that share proxy relationships. */
export interface ProxyCategory {
	id: string;
	description: string;
	matchTickers: string[];
	matchKeywords: string[];
	proxies: ProxyEntry[];
	/** If true, matches any ticker from the given market not matched by another category. */
	isDefault?: boolean;
	/** When isDefault=true, only match tickers from this market ("KR" | "US"). */
	matchMarket?: string;
}

/** The full proxy map file. */
export interface ProxyMap {
	version: number;
	updatedAt: string;
	categories: ProxyCategory[];
}

const PROXY_FILE = join(APP_DIR, "proxy-map.json");

/** Seed data: the former hardcoded relationships + the SK Hynix ADR (HXSK). */
const SEED_MAP: ProxyMap = {
	version: 1,
	updatedAt: "2026-07-31T00:00:00.000Z",
	categories: [
		{
			id: "korean-semiconductor",
			description:
				"Korean semiconductor stocks and their US leading indicators",
			matchTickers: [
				"005930",
				"000660",
				"005935",
				"005930.KS",
				"000660.KS",
				"005935.KS",
			],
			matchKeywords: [
				"반도체",
				"semiconductor",
				"memory",
				"메모리",
				"hynix",
				"samsung electro",
			],
			proxies: [
				{
					ticker: "SOXX",
					name: "iShares Semiconductor ETF",
					relation:
						"Tracks PHLX Semiconductor (SOX) index — strongest overnight leader for Korean memory/logic chip stocks",
				},
				{
					ticker: "SMH",
					name: "VanEck Semiconductor ETF",
					relation: "US semiconductor sector momentum",
				},
				{
					ticker: "MU",
					name: "Micron Technology",
					relation:
						"DRAM/NAND memory peer — direct read-across to Samsung/SK Hynix memory cycle",
				},
				{
					ticker: "NVDA",
					name: "NVIDIA",
					relation: "AI/HPC demand driver for HBM",
				},
				{
					ticker: "HXSK",
					name: "SK Hynix ADR",
					relation:
						"SK Hynix US-listed ADR — same company, direct price arbitrage signal since fungible conversion (2026-07-29)",
				},
			],
		},
		{
			id: "korean-broad",
			description:
				"Generic broad-market overnight proxies for all Korean stocks not in another category",
			matchTickers: [],
			matchKeywords: [],
			isDefault: true,
			matchMarket: "KR",
			proxies: [
				{
					ticker: "^IXIC",
					name: "Nasdaq Composite",
					relation: "US tech/risk-appetite overnight direction",
				},
				{
					ticker: "^GSPC",
					name: "S&P 500",
					relation: "US broad-market overnight direction",
				},
			],
		},
	],
};

/** Load the proxy map. If the file doesn't exist, seed it first. */
export function loadProxyMap(): ProxyMap {
	if (!existsSync(PROXY_FILE)) {
		// First run: write the seed so the file exists from the start.
		if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
		writeFileSync(PROXY_FILE, JSON.stringify(SEED_MAP, null, 2), {
			mode: 0o600,
		});
		return structuredClone(SEED_MAP);
	}
	try {
		return JSON.parse(readFileSync(PROXY_FILE, "utf8")) as ProxyMap;
	} catch {
		return { version: 1, updatedAt: new Date().toISOString(), categories: [] };
	}
}

/** Save the proxy map. */
export function saveProxyMap(map: ProxyMap): void {
	if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
	map.updatedAt = new Date().toISOString();
	writeFileSync(PROXY_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}

/** Find which category a ticker matches. Returns null if no match. */
export function findCategory(
	map: ProxyMap,
	ticker: string,
	name: string | undefined,
	market: string | undefined,
): ProxyCategory | null {
	// First try specific (non-default) categories.
	for (const cat of map.categories) {
		if (cat.isDefault) continue;
		if (cat.matchTickers.includes(ticker)) return cat;
		const lc = (name ?? "").toLowerCase();
		if (lc && cat.matchKeywords.some((k) => lc.includes(k.toLowerCase())))
			return cat;
	}
	// Then try default category by market.
	for (const cat of map.categories) {
		if (!cat.isDefault) continue;
		if (cat.matchMarket && market && cat.matchMarket === market) return cat;
		if (!cat.matchMarket) return cat; // catch-all default
	}
	return null;
}

/** Add or update a proxy entry within a category. */
export function addProxy(
	map: ProxyMap,
	categoryId: string,
	entry: ProxyEntry,
): ProxyMap {
	let cat = map.categories.find((c) => c.id === categoryId);
	if (!cat) {
		cat = {
			id: categoryId,
			description: "",
			matchTickers: [],
			matchKeywords: [],
			proxies: [],
		};
		map.categories.push(cat);
	}
	const idx = cat.proxies.findIndex((p) => p.ticker === entry.ticker);
	if (idx >= 0) cat.proxies[idx] = entry;
	else cat.proxies.push(entry);
	return map;
}

/** Remove a proxy entry from a category. Returns true if removed. */
export function removeProxy(
	map: ProxyMap,
	categoryId: string,
	ticker: string,
): boolean {
	const cat = map.categories.find((c) => c.id === categoryId);
	if (!cat) return false;
	const idx = cat.proxies.findIndex((p) => p.ticker === ticker);
	if (idx < 0) return false;
	cat.proxies.splice(idx, 1);
	return true;
}
