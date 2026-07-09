import type { Command } from "commander";
import { loadConfig } from "../config/app-config.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
import {
	refreshSnapshot,
	loadSnapshot,
	snapshotAgeMs,
} from "../market/snapshot.js";
import { mapToYahoo } from "../market/ticker-map.js";
import { expandWithProxies } from "../market/proxies.js";
import { getMarketState } from "../market/market-state.js";
import { out, outputJson, fail } from "../output.js";

export function registerMarketCommands(root: Command): void {
	const market = root
		.command("market")
		.description("source-of-truth market data (yfinance) + session state");

	market
		.command("refresh")
		.description(
			"fetch fundamentals + technicals ONCE from yfinance and cache as the source of truth",
		)
		.option(
			"-s, --symbols <list>",
			"comma-separated extra symbols (raw: AAPL, 005930)",
		)
		.option(
			"--include-portfolio",
			"also fetch all current portfolio holdings",
			true,
		)
		.option("--period <p>", "history window (1y, 6mo, 3mo...)", "1y")
		.option("--json", "JSON output")
		.action(async (opts) => {
			const holdings: Array<{ ticker: string; name?: string }> = [];
			const tickers = new Set<string>();
			if (opts.includePortfolio) {
				const cfg = loadConfig();
				if (cfg.accounts.length > 0) {
					const portfolio = await aggregatePortfolio(cfg.accounts);
					for (const h of portfolio.holdings) {
						holdings.push({ ticker: h.ticker, name: h.name });
						tickers.add(h.ticker);
					}
				}
			}
			if (opts.symbols) {
				for (const raw of String(opts.symbols)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)) {
					const mapped = mapToYahoo(raw);
					holdings.push({ ticker: mapped.ticker });
					tickers.add(mapped.ticker);
				}
			}
			if (tickers.size === 0) {
				fail(
					"No tickers to fetch. Pass --symbols or enable accounts (td auth account enable).",
					2,
				);
			}
			// Expand Korean holdings with US leading-indicator proxies (overnight forward signals).
			const { tickers: expanded, proxies } = expandWithProxies(holdings);
			for (const t of expanded) tickers.add(t);
			const snapshot = await refreshSnapshot([...tickers], {
				period: opts.period,
				leadingIndicators: proxies,
			});
			if (opts.json) {
				outputJson(snapshot);
				return;
			}
			out(
				`✓ snapshot generated at ${snapshot.generatedAt} (yfinance ${snapshot.yfinanceVersion ?? "?"})`,
			);
			out(
				`Market: KR ${snapshot.marketState.KR?.session} / US ${snapshot.marketState.US?.session}`,
			);
			for (const t of snapshot.tickers) {
				const f = t.fundamentals;
				out(
					`• ${t.ticker} ${t.name ?? ""} [${t.market}] price=${f?.price ?? "?"} PER=${f?.per ?? "?"} PBR=${f?.pbr ?? "?"}${t.error ? ` ERROR:${t.error}` : ""}`,
				);
			}
		});

	market
		.command("status")
		.description("show cached snapshot age + market session state")
		.option("--json", "JSON output")
		.action((opts) => {
			const snap = loadSnapshot();
			const kr = getMarketState("KR");
			const us = getMarketState("US");
			const ageMs = snapshotAgeMs();
			if (opts.json) {
				outputJson({
					snapshotGeneratedAt: snap?.generatedAt ?? null,
					ageMs: ageMs ?? null,
					marketState: { KR: kr, US: us },
					tickers: snap?.tickers.map((t) => t.ticker) ?? [],
				});
				return;
			}
			out(
				`KR: ${kr.session}${kr.isOpen ? " (OPEN)" : ""}  tradingDay=${kr.tradingDay}`,
			);
			out(
				`US: ${us.session}${us.isOpen ? " (OPEN)" : ""}  tradingDay=${us.tradingDay}`,
			);
			if (snap) {
				out(
					`Snapshot: ${snap.generatedAt} (${ageMs !== undefined ? Math.round(ageMs / 1000) + "s ago" : "?"})`,
				);
				out(
					`Tickers: ${snap.tickers.map((t) => t.ticker).join(", ") || "(none)"}`,
				);
			} else {
				out("No cached snapshot. Run: td market refresh");
			}
		});
}
