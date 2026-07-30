/**
 * KST clock utilities. Every agent's system prompt carries the current date/time
 * so it reasons from the correct "now" — a recurring failure mode was judging
 * stale snapshot data as if it were a different date.
 *
 * Pass an explicit `now` (via `AnalysisContext.now`) to lock the clock for
 * backtests / E2E tests with historical data.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DOW_KR = [
	"일요일",
	"월요일",
	"화요일",
	"수요일",
	"목요일",
	"금요일",
	"토요일",
] as const;

export interface ClockInfo {
	/** `2026-07-30` (KST calendar date) */
	date: string;
	/** `14:30` (KST, 24h) */
	time: string;
	/** `수요일` */
	dow: string;
	/** Full ISO timestamp of the underlying instant (UTC). */
	iso: string;
	/** `2026-07-30 (수) 14:30 KST` */
	label: string;
}

/** Format an instant as KST clock info. Defaults to the real current time. */
export function kstClock(now: Date = new Date()): ClockInfo {
	const kst = new Date(now.getTime() + KST_OFFSET_MS);
	const y = kst.getUTCFullYear();
	const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
	const d = String(kst.getUTCDate()).padStart(2, "0");
	const hh = String(kst.getUTCHours()).padStart(2, "0");
	const mm = String(kst.getUTCMinutes()).padStart(2, "0");
	const dow = DOW_KR[kst.getUTCDay()] ?? "?";
	const date = `${y}-${m}-${d}`;
	const time = `${hh}:${mm}`;
	return {
		date,
		time,
		dow,
		iso: now.toISOString(),
		label: `${date} (${dow[0]}) ${time} KST`,
	};
}
