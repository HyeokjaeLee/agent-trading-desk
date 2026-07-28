/**
 * Foreign/Institutional investor trading data — Naver Finance frgn.naver crawler.
 *
 * td's 8-agent pipeline had ZERO access to 외국인/기관/개인 매매동향 (investor
 * trading flows). Agents consistently mischaracterized supply/demand — diagnosing
 * "매수 실종" (buyer disappeared) when actual data showed aggressive foreign buying.
 *
 * This module fetches daily investor trading data from Naver's frgn.naver page:
 *   https://finance.naver.com/item/frgn.naver?code=CODE
 *
 * The page is static HTML (NOT JS-rendered like item/news_news.naver) — safe to fetch
 * with a plain HTTP GET. Encoding is EUC-KR.
 *
 * Data per day: close, change%, volume, 기관 순매매, 외국인 순매매,
 * 외국인 보유주수, 외국인 보유율.
 *
 * Extracted via regex on table.class="type2" rows.
 */

export interface InvestorFlowDay {
	date: string; // YYYY.MM.DD
	close: number;
	changePct: number;
	volume: number;
	/** 기관 순매매량 (shares). Positive = net buy, negative = net sell. */
	institutionNet: number;
	/** 외국인 순매매량 (shares). Positive = net buy, negative = net sell. */
	foreignNet: number;
	/** 외국인 보유주수 (cumulative shares held at end of day). */
	foreignSharesHeld: number;
	/** 외국인 보유율 (%). */
	foreignOwnershipRatio: number;
}

export interface InvestorFlowTrend {
	/** Sum of foreign net trading over recent N days (shares). */
	recentForeignNetSum: number;
	/** Sum of institution net trading over recent N days (shares). */
	recentInstitutionNetSum: number;
	/** Number of foreign net-buy days in recent window. */
	foreignBuyDays: number;
	/** Number of institution net-buy days in recent window. */
	institutionBuyDays: number;
	/** Foreign ownership ratio change (latest - N days ago), in percentage points. */
	foreignOwnershipDelta: number;
	/**
	 * Classification:
	 * - "accumulation": foreign net buying ≥3 of last 5 days AND positive net sum
	 * - "distribution": foreign net selling ≥3 of last 5 days AND negative net sum
	 * - "mixed": no clear pattern (2-3 days each direction)
	 * - "neutral": insufficient data
	 */
	pattern: "accumulation" | "distribution" | "mixed" | "neutral";
}

export interface InvestorFlowData {
	symbol: string;
	name?: string;
	/** Daily flow data, most recent first. */
	days: InvestorFlowDay[];
	trend: InvestorFlowTrend;
}

const RECENT_WINDOW = 5;

/**
 * Parse a signed share count from Naver HTML cell text.
 * Naver formats: "+1,234,567" or "-1,234,567" or plain "1,234,567".
 * Sometimes with surrounding span tags and whitespace.
 */
function parseShares(text: string): number {
	const cleaned = text.replace(/[,\s]/g, "").replace(/[^\d\-+]/g, "");
	const n = parseInt(cleaned, 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a percentage like "+8.22%" or "-4.31%".
 */
function parsePercent(text: string): number {
	const m = text.match(/([+-]?\d+\.?\d*)\s*%/);
	const val = m?.[1];
	if (val) return parseFloat(val);
	const cleaned = text.replace(/[^\d.\-+]/g, "");
	const n = parseFloat(cleaned);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a plain number like "2,728,432,122".
 */
function parsePlainNumber(text: string): number {
	const cleaned = text.replace(/,/g, "").replace(/[^\d]/g, "");
	const n = parseInt(cleaned, 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch investor trading flow data for a single Korean stock code.
 * Returns up to 20 most recent trading days.
 */
export async function fetchInvestorFlow(
	code: string,
	name?: string,
): Promise<InvestorFlowData | undefined> {
	try {
		const url = `https://finance.naver.com/item/frgn.naver?code=${code}&page=1`;
		const resp = await fetch(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!resp.ok) return undefined;
		const buf = await resp.arrayBuffer();
		const html = new TextDecoder("euc-kr").decode(buf);

		// Extract rows from table.class="type2" (second table contains the flow data)
		const tables = html.match(
			/<table[^>]*class="type2"[^>]*>[\s\S]*?<\/table>/g,
		);
		if (!tables || tables.length < 2) return undefined;

		const flowTable = tables[1];
		if (!flowTable) return undefined;
		const rowMatches = flowTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
		if (!rowMatches) return undefined;

		const days: InvestorFlowDay[] = [];

		for (const row of rowMatches) {
			const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g);
			if (!cells || cells.length < 8) continue;

			const clean = cells.map((c) => {
				let t = c.replace(/<[^>]+>/g, " ");
				t = t.replace(/[\n\t\r]+/g, " ").replace(/\s+/g, " ").trim();
				return t;
			});

			// Row format: date | close | change(direction+amount) | change% | volume |
			//             institution | foreign | ... | foreignSharesHeld | foreignOwnershipRatio%
			const date = clean[0] ?? "";
			if (!/^\d{4}\.\d{2}\.\d{2}/.test(date)) continue;

			const close = parsePlainNumber(clean[1] ?? "");
			const changePct = parsePercent(clean[3] ?? clean[2] ?? "");
			const volume = parsePlainNumber(clean[4] ?? "");
			const institutionNet = parseShares(clean[5] ?? "");
			const foreignNet = parseShares(clean[6] ?? "");

			// Last two numeric cells: foreignSharesHeld and foreignOwnershipRatio
			// Find the ownership ratio (cell ending with %) and shares held (cell before it)
			let foreignSharesHeld = 0;
			let foreignOwnershipRatio = 0;

			for (let i = clean.length - 1; i >= 0; i--) {
				const cell = clean[i];
				if (!cell) continue;
				if (cell.includes("%")) {
					foreignOwnershipRatio = parsePercent(cell);
					// The cell before the ratio is shares held
					if (i > 0) {
						foreignSharesHeld = parsePlainNumber(clean[i - 1] ?? "");
					}
					break;
				}
			}

			days.push({
				date,
				close,
				changePct,
				volume,
				institutionNet,
				foreignNet,
				foreignSharesHeld,
				foreignOwnershipRatio,
			});
		}

		if (days.length === 0) return undefined;

		// Compute trend summary over recent window
		const window = Math.min(RECENT_WINDOW, days.length);
		const recent = days.slice(0, window);
		const recentForeignNetSum = recent.reduce(
			(sum, d) => sum + d.foreignNet,
			0,
		);
		const recentInstitutionNetSum = recent.reduce(
			(sum, d) => sum + d.institutionNet,
			0,
		);
		const foreignBuyDays = recent.filter(
			(d) => d.foreignNet > 0,
		).length;
		const institutionBuyDays = recent.filter(
			(d) => d.institutionNet > 0,
		).length;

		const latestRatio = days[0]?.foreignOwnershipRatio ?? 0;
		const oldestRatio = days[window - 1]?.foreignOwnershipRatio ?? 0;
		const foreignOwnershipDelta = latestRatio - oldestRatio;

		let pattern: InvestorFlowTrend["pattern"] = "neutral";
		if (window >= 3) {
			if (foreignBuyDays >= 3 && recentForeignNetSum > 0) {
				pattern = "accumulation";
			} else if (foreignBuyDays <= window - 3 && recentForeignNetSum < 0) {
				pattern = "distribution";
			} else {
				pattern = "mixed";
			}
		}

		return {
			symbol: code,
			name,
			days,
			trend: {
				recentForeignNetSum,
				recentInstitutionNetSum,
				foreignBuyDays,
				institutionBuyDays,
				foreignOwnershipDelta,
				pattern,
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * Fetch investor flow data for multiple Korean stock codes in parallel.
 * Non-Korean tickers are silently skipped.
 */
export async function fetchInvestorFlows(
	codes: Array<{ code: string; name?: string }>,
): Promise<Map<string, InvestorFlowData>> {
	const results = new Map<string, InvestorFlowData>();
	const tasks = codes.map(async ({ code, name }) => {
		const data = await fetchInvestorFlow(code, name);
		if (data) results.set(code, data);
	});
	await Promise.allSettled(tasks);
	return results;
}
