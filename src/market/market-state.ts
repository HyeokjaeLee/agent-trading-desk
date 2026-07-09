import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import type { MarketSessionState } from "../types.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/** KRX regular session: 09:00–15:30 KST, Mon–Fri. */
const KR_TZ = "Asia/Seoul";
const KR_OPEN_HM = 900;
const KR_CLOSE_HM = 1530;

/** US (NYSE/NASDAQ) regular session: 09:30–16:00 ET, Mon–Fri. */
const US_TZ = "America/New_York";
const US_OPEN_HM = 930;
const US_CLOSE_HM = 1600;

function hm(d: dayjs.Dayjs): number {
	return d.hour() * 100 + d.minute();
}

function isWeekday(d: dayjs.Dayjs): boolean {
	const dow = d.day(); // 0 Sun .. 6 Sat
	return dow >= 1 && dow <= 5;
}

/** Compute market session state for a region at a given (or current) instant. */
export function getMarketState(
	region: "KR" | "US",
	nowIso?: string,
): MarketSessionState {
	const tz = region === "KR" ? KR_TZ : US_TZ;
	const open = region === "KR" ? KR_OPEN_HM : US_OPEN_HM;
	const close = region === "KR" ? KR_CLOSE_HM : US_CLOSE_HM;
	const now = nowIso ? dayjs(nowIso) : dayjs();
	const local = now.tz(tz);
	const cur = hm(local);
	const weekday = isWeekday(local);

	let session: MarketSessionState["session"] = "closed";
	let isOpen = false;
	if (weekday) {
		if (cur >= open && cur < close) {
			session = "open";
			isOpen = true;
		} else if (cur < open) {
			session = "pre";
		} else if (cur >= close) {
			session = "after";
		}
	}

	// Find next open day
	let nextOpen: string | undefined;
	let cursor = local.startOf("day");
	for (let i = 0; i < 8; i++) {
		if (isWeekday(cursor)) {
			const candidateOpen = cursor
				.hour(Math.floor(open / 100))
				.minute(open % 100)
				.second(0);
			if (candidateOpen.isAfter(now)) {
				nextOpen = candidateOpen.utc().toISOString();
				break;
			}
		}
		cursor = cursor.add(1, "day");
	}

	const tradingDay = local.format("YYYY-MM-DD");

	return {
		region,
		now: local.utc().toISOString(),
		session,
		isOpen,
		nextOpen,
		tradingDay,
	};
}

/**
 * Decide how to treat a news item based on market state.
 * - If the market is OPEN on the news date → assume already priced in (reference only).
 * - If the market is CLOSED (overnight / weekend / pre-open) and the news is
 *   directional → it should be used as an active signal for the next open.
 *
 * Returns whether the news should be weighted as an *active* (forward-looking)
 * signal vs a *reference* (already discounted) one.
 */
export function newsSignalWeight(
	region: "KR" | "US",
	newsIso: string,
	nowIso?: string,
): { pricedIn: boolean; active: boolean; reason: string } {
	const close = region === "KR" ? KR_CLOSE_HM : US_CLOSE_HM;
	const state = getMarketState(region, nowIso ?? newsIso);
	const newsTime = dayjs(newsIso).tz(region === "KR" ? KR_TZ : US_TZ);
	const newsTradingDay = newsTime.format("YYYY-MM-DD");

	// If market was open when (or after) the news hit the wire → priced in.
	if (state.isOpen && state.tradingDay === newsTradingDay) {
		return {
			pricedIn: true,
			active: false,
			reason: `Market is currently OPEN (${state.region}); same-day news is treated as priced in.`,
		};
	}

	// Market closed but news is from before today's session already traded → priced in.
	const now = nowIso ? dayjs(nowIso) : dayjs();
	const lastClose = state.tradingDay
		? dayjs
				.tz(state.tradingDay, region === "KR" ? KR_TZ : US_TZ)
				.hour(Math.floor(close / 100))
				.minute(close % 100)
		: null;
	if (lastClose && newsTime.isBefore(lastClose) && now.isAfter(lastClose)) {
		return {
			pricedIn: true,
			active: false,
			reason: `News predates the last close (${state.tradingDay}); already reflected.`,
		};
	}

	// Otherwise: market is closed and news is fresh → active forward signal.
	return {
		pricedIn: false,
		active: true,
		reason: `Market ${state.region} is ${state.session}; fresh overnight/pre-open news should drive the next open.`,
	};
}
