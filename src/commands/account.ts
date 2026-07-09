import type { Command } from "commander";
import { loadConfig } from "../config/app-config.js";
import { aggregatePortfolio } from "../accounts/aggregate.js";
import { out, outputJson, fail, printTable, fmtMoney } from "../output.js";
import { PORTFOLIO_FILE } from "../config/paths.js";
import { writeJsonFile } from "../output.js";

export function registerAccountCommands(root: Command): void {
	const account = root
		.command("account")
		.description("read-only aggregated brokerage account view");

	account
		.command("summary")
		.description(
			"aggregate cash (KRW/USD) + holdings across all enabled accounts (READ-ONLY)",
		)
		.option("--json", "JSON output")
		.action(async (opts) => {
			const cfg = loadConfig();
			if (cfg.accounts.length === 0) {
				fail(
					"No accounts enabled. Run: td auth account enable <broker> <profile>",
					2,
				);
			}
			const portfolio = await aggregatePortfolio(cfg.accounts);
			writeJsonFile(PORTFOLIO_FILE, portfolio);

			if (opts.json) {
				outputJson(portfolio);
				return;
			}
			out(`As of: ${portfolio.asOf}`);
			out("\nCash:");
			for (const c of portfolio.cash) {
				out(
					`  ${fmtMoney(c.amount, c.currency)}  [${c.sources.map((s) => `${s.broker}/${s.profile}`).join(", ")}]`,
				);
			}
			out("\nHoldings:");
			if (portfolio.holdings.length === 0) {
				out("  (none)");
			} else {
				printTable(
					portfolio.holdings.map((h) => ({
						ticker: h.ticker,
						name: h.name ?? "",
						qty: h.quantity,
						avg: h.averagePrice ?? "",
						last: h.lastPrice ?? "",
						ccy: h.currency,
						accounts: h.breakdown.length,
					})),
				);
			}
			out("\nAccounts:");
			for (const a of portfolio.accounts) {
				out(
					`  ${a.broker}/${a.profile}: ${a.included ? "ok" : "FAILED"}${a.error ? ` — ${a.error}` : ""}`,
				);
			}
		});
}
