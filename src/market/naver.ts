/**
 * Naver Finance crawler — 한국 주식 펀더멘털 + 재무 비율 데이터.
 *
 * Yahoo Finance는 한국 주식(.KS/.KQ)의 PER, PBR, EPS, BPS를 반환하지 않음.
 * Naver Finance HTML에서 직접 추출 (TS 넠이티브, Python 불필요).
 *
 * 추출 항목:
 *   - 밸류에이션: PER, PBR, EPS, BPS, 배당수익률
 *   - 수익성: ROE, ROA, 매출액, 영업이익, 당기순이익
 *   - 재무 건전성: 부채비율, 당좌비율, 유동비율, 유보율, 이자보상배율
 *   - 성장성: 영업이익증가율, 매출액증가율, 당기순이익증가율
 *   - 시장 정보: 시가총액, 상장주식수, 외국인 보유 비율
 */

export interface NaverFundamentals {
	symbol: string;
	per?: number;
	pbr?: number;
	eps?: number;
	bps?: number;
	dividendYield?: number;
	roe?: number;
	roa?: number;
	revenue?: string;
	operatingIncome?: string;
	netIncome?: string;
	debtRatio?: number;
	quickRatio?: number;
	currentRatio?: number;
	retainedEarningsRatio?: number;
	interestCoverageRatio?: number;
	revenueGrowth?: number;
	operatingIncomeGrowth?: number;
	netIncomeGrowth?: number;
	marketCap?: string;
	listedShares?: string;
	foreignOwnershipRatio?: number;
}

function parseNum(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const cleaned = s.replace(/,/g, "").replace(/%/g, "").trim();
	const n = parseFloat(cleaned);
	return Number.isFinite(n) ? n : undefined;
}

function extractValue(
	html: string,
	label: string,
	maxDist = 600,
): string | undefined {
	const target = `${label}(`;
	const idx = html.indexOf(target);
	if (idx < 0) {
		const idx2 = html.indexOf(`>${label}<`);
		if (idx2 < 0) return undefined;
		const chunk = html.slice(idx2, idx2 + maxDist);
		const m = chunk.match(/>\s*([\d,.%+-]+)\s*</);
		return m?.[1];
	}
	const chunk = html.slice(idx, idx + maxDist);
	const matches = [...chunk.matchAll(/>\s*([\d,.%+-]+)\s*</g)];
	return matches.length > 0 ? matches[0]?.[1] : undefined;
}

function extractCoinfoData(html: string): Partial<NaverFundamentals> {
	const result: Partial<NaverFundamentals> = {};
	const findTd = (label: string): string | undefined => {
		const idx = html.indexOf(label);
		if (idx < 0) return undefined;
		const chunk = html.slice(idx, idx + 500);
		const tdRe = /<td[^>]*>\s*([^<]+?)\s*<\/td>/;
		const m = chunk.match(tdRe);
		return m?.[1]?.trim();
	};
	result.listedShares = findTd("상장주식수");
	const foreignHeld = findTd("외국인보유주식수");
	if (foreignHeld && result.listedShares) {
		const held = parseNum(foreignHeld.replace(/[^\d.]/g, ""));
		const total = parseNum(result.listedShares.replace(/[^\d.]/g, ""));
		if (held && total && total > 0) {
			result.foreignOwnershipRatio = (held / total) * 100;
		}
	}
	return result;
}

export async function fetchNaverFundamentals(
	code: string,
): Promise<NaverFundamentals | undefined> {
	try {
		const resp = await fetch(
			`https://finance.naver.com/item/main.nhn?code=${code}`,
			{
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (!resp.ok) return undefined;
		const html = await resp.text();

		const result: NaverFundamentals = {
			symbol: code,
			per: parseNum(extractValue(html, "PER")),
			pbr: parseNum(extractValue(html, "PBR")),
			eps: parseNum(extractValue(html, "EPS")),
			bps: parseNum(extractValue(html, "BPS")),
			roe: parseNum(extractValue(html, "ROE")),
			roa: parseNum(extractValue(html, "ROA")),
			revenue: extractValue(html, "매출액"),
			operatingIncome: extractValue(html, "영업이익"),
			netIncome: extractValue(html, "당기순이익"),
			marketCap: extractValue(html, "시가총액"),
			debtRatio: parseNum(extractValue(html, "부채비율")),
			quickRatio: parseNum(extractValue(html, "당좌비율")),
			currentRatio: parseNum(extractValue(html, "유동비율")),
			retainedEarningsRatio: parseNum(extractValue(html, "유보율")),
			interestCoverageRatio: parseNum(extractValue(html, "이자보상배율")),
			operatingIncomeGrowth: parseNum(extractValue(html, "영업이익증가율")),
			revenueGrowth: parseNum(extractValue(html, "매출액증가율")),
			netIncomeGrowth: parseNum(extractValue(html, "당기순이익증가율")),
			dividendYield: parseNum(extractValue(html, "배당수익률")),
		};

		try {
			const resp2 = await fetch(
				`https://finance.naver.com/item/coinfo.naver?code=${code}`,
				{
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					},
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (resp2.ok) {
				const buf = await resp2.arrayBuffer();
				const coinfoHtml = new TextDecoder("euc-kr").decode(buf);
				const extra = extractCoinfoData(coinfoHtml);
				result.listedShares = extra.listedShares ?? result.listedShares;
				result.foreignOwnershipRatio = extra.foreignOwnershipRatio;
			}
		} catch {
			/* coinfo optional */
		}

		return result;
	} catch {
		return undefined;
	}
}

export async function fetchNaverFundamentalsBatch(
	codes: string[],
): Promise<Map<string, NaverFundamentals>> {
	const results = new Map<string, NaverFundamentals>();
	for (const code of codes) {
		const fund = await fetchNaverFundamentals(code);
		if (fund) results.set(code, fund);
		await new Promise((r) => setTimeout(r, 300));
	}
	return results;
}

export function getKoreanCode(ticker: string): string | undefined {
	const m = ticker.match(/^(\d{6})\.(KS|KQ)$/);
	return m?.[1];
}
