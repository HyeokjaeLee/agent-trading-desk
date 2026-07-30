/**
 * `td proxy` — manage the dynamic leading-indicator proxy map
 * (~/.agent-trading-desk/proxy-map.json). Relationships can be added/removed
 * at runtime without code changes.
 */
import type { Command } from "commander";
import { out, outputJson, fail } from "../output.js";
import {
	loadProxyMap,
	saveProxyMap,
	findCategory,
	addProxy,
	removeProxy,
} from "../market/proxy-store.js";
import { leadingProxiesFor } from "../market/proxies.js";

export function registerProxyCommands(root: Command): void {
	const proxy = root
		.command("proxy")
		.description("manage the cross-market leading-indicator proxy map");

	proxy
		.command("list")
		.description("show all proxy categories and their proxies")
		.option("--json", "JSON output")
		.action((opts) => {
			const map = loadProxyMap();
			if (opts.json) {
				outputJson(map);
				return;
			}
			out(`proxy-map v${map.version} (updated ${map.updatedAt})`);
			for (const cat of map.categories) {
				const tags = [
					cat.isDefault ? "default" : null,
					cat.matchMarket ? `market=${cat.matchMarket}` : null,
				]
					.filter(Boolean)
					.join(", ");
				out(`\n[${cat.id}]${tags ? ` (${tags})` : ""} ${cat.description}`);
				if (cat.matchTickers.length)
					out(`  tickers: ${cat.matchTickers.join(", ")}`);
				if (cat.matchKeywords.length)
					out(`  keywords: ${cat.matchKeywords.join(", ")}`);
				for (const p of cat.proxies) {
					out(`  • ${p.ticker} — ${p.name}`);
					out(`      ${p.relation}`);
				}
			}
		});

	proxy
		.command("add <categoryId> <ticker> <name> <relation>")
		.description("add or update a proxy entry in a category")
		.action(
			(categoryId: string, ticker: string, name: string, relation: string) => {
				const map = loadProxyMap();
				addProxy(map, categoryId, { ticker, name, relation });
				saveProxyMap(map);
				out(`added ${ticker} (${name}) → category "${categoryId}"`);
			},
		);

	proxy
		.command("remove <categoryId> <ticker>")
		.description("remove a proxy entry from a category")
		.action((categoryId: string, ticker: string) => {
			const map = loadProxyMap();
			const removed = removeProxy(map, categoryId, ticker);
			if (!removed)
				fail(`proxy ${ticker} not found in category "${categoryId}"`, 1);
			saveProxyMap(map);
			out(`removed ${ticker} from category "${categoryId}"`);
		});

	proxy
		.command("show <ticker>")
		.description("show proxies matched for a given ticker")
		.option("--name <name>", "company name (improves keyword matching)")
		.option("--json", "JSON output")
		.action((ticker: string, opts) => {
			const map = loadProxyMap();
			const px = leadingProxiesFor(ticker, opts.name);
			if (opts.json) {
				outputJson({ ticker, proxies: px });
				return;
			}
			out(`proxies for ${ticker}:`);
			if (px.length === 0) {
				out("  (none)");
				return;
			}
			for (const p of px) {
				out(`  • ${p.ticker} — ${p.name}`);
				out(`      ${p.relation}`);
			}
			// also surface which category matched, for transparency
			const cat = findCategory(map, ticker, opts.name, undefined);
			if (cat) out(`  [matched category: ${cat.id}]`);
		});

	proxy
		.command("refresh <categoryId>")
		.description("reset the 7-day cooldown so discover_proxies re-checks this category on next use")
		.action((categoryId: string) => {
			const map = loadProxyMap();
			const cat = map.categories.find((c) => c.id === categoryId);
			if (!cat) fail(`category "${categoryId}" not found`, 1);
			const before = cat.lastRefreshedAt ?? "(never)";
			cat.lastRefreshedAt = new Date(0).toISOString(); // epoch — forces re-check
			saveProxyMap(map);
			out(`reset cooldown for "${categoryId}" (was: ${before}). discover_proxies will re-check on next use.`);
		});
}
