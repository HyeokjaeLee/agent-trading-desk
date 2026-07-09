import type { Command } from "commander";
import {
	listProviders,
	addApiKey,
	removeProvider,
	listAvailableModels,
	getAuthStorage,
} from "../auth/providers.js";
import { discoverAccounts, loginBrokerageCommand } from "../auth/accounts.js";
import { loadConfig, saveConfig } from "../config/app-config.js";
import { outputJson, out, fail, printTable } from "../output.js";
import type { AppConfig } from "../config/app-config.js";

export function registerAuthCommands(root: Command): void {
	const auth = root
		.command("auth")
		.description("manage model providers and brokerage accounts");

	// ---- auth provider (LLM models) ----
	const provider = auth
		.command("provider")
		.description("manage model providers (gpt, claude, zai, opencode-go, ...)");

	provider
		.command("list")
		.description("list configured model providers and their available models")
		.option("--json", "JSON output")
		.action((opts) => {
			const providers = listProviders();
			if (opts.json) {
				outputJson(providers);
				return;
			}
			if (providers.length === 0) {
				out(
					"No providers configured. Use: td auth provider add <provider> --api-key <key>",
				);
				return;
			}
			for (const p of providers) {
				out(
					`• ${p.provider} (${p.displayName}) [${p.authType}${p.configured ? ", configured" : ", no key"}]`,
				);
				for (const m of p.models) {
					out(
						`    - ${m.modelId}  ${m.name}${m.reasoning ? " (reasoning)" : ""}`,
					);
				}
			}
		});

	provider
		.command("add <provider>")
		.description(
			"add/replace an API key for a provider (e.g. openai, anthropic, zai, opencode-go)",
		)
		.option("-k, --api-key <key>", "API key (omit to read TD_API_KEY env)")
		.option("--json", "JSON output")
		.action((prov: string, opts) => {
			const key = opts.apiKey ?? process.env.TD_API_KEY;
			if (!key) fail("--api-key is required (or set TD_API_KEY env)", 2);
			addApiKey(prov, key);
			if (opts.json) outputJson({ provider: prov, configured: true });
			else out(`✓ ${prov}: API key stored in ~/.pi/agent/auth.json`);
		});

	provider
		.command("login <provider>")
		.description(
			"OAuth login for a subscription provider (opens browser / device code)",
		)
		.option("--json", "JSON output")
		.action(async (prov: string, opts) => {
			const auth = getAuthStorage();
			const oauthProviders = auth.getOAuthProviders() as Array<{
				id: string;
				name?: string;
			}>;
			const ids = oauthProviders.map((p) => p.id);
			if (!ids.includes(prov)) {
				fail(
					`Unknown OAuth provider "${prov}". Known: ${ids.join(", ")}. For API-key providers use: td auth provider add`,
					2,
				);
			}
			const readline = await import("node:readline/promises");
			const { stdin, stdout } = process;
			const rl = readline.createInterface({ input: stdin, output: stdout });
			try {
				await auth.login(prov as never, {
					onAuth: ({ url }) => out(`Open this URL to authorize:\n  ${url}`),
					onDeviceCode: ({ userCode, verificationUri }) =>
						out(`Device code: ${userCode}\nVerify at: ${verificationUri}`),
					onPrompt: async ({ message }) => {
						const ans = await rl.question(message + " ");
						return ans.trim();
					},
					onSelect: async ({ message, options }) => {
						out(message);
						options.forEach((o, i) => out(`  ${i}: ${o.label}`));
						const ans = await rl.question("Select> ");
						return options[Number(ans)]?.id;
					},
				});
				if (opts.json) outputJson({ provider: prov, configured: true });
				else out(`✓ ${prov}: OAuth login stored`);
			} finally {
				rl.close();
			}
		});

	provider
		.command("remove <provider>")
		.description("remove a provider's credentials")
		.option("--json", "JSON output")
		.action((prov: string, opts) => {
			removeProvider(prov);
			if (opts.json) outputJson({ provider: prov, configured: false });
			else out(`✓ ${prov}: credentials removed`);
		});

	provider
		.command("models")
		.description("list all models ready to use (auth configured)")
		.option("--json", "JSON output")
		.action((opts) => {
			const models = listAvailableModels();
			if (opts.json) {
				outputJson(models);
				return;
			}
			printTable(
				models.map((m) => ({
					provider: m.provider,
					modelId: m.modelId,
					name: m.name,
				})),
			);
		});

	// ---- auth account (brokerage) ----
	const account = auth
		.command("account")
		.description(
			"manage linked brokerage accounts (KIS, Toss) — read from ~/.kis-cli",
		);

	account
		.command("list")
		.description("list all discovered brokerage accounts")
		.option("--json", "JSON output")
		.action(async (opts) => {
			const discovered = await discoverAccounts();
			const cfg = loadConfig();
			const enabled = new Set(
				cfg.accounts.map((a) => `${a.broker}/${a.profile}`),
			);
			const rows = discovered.map((a) => ({
				broker: a.broker,
				profile: a.profile,
				paper: a.paper ? "Y" : "N",
				detail: a.detail ?? "",
				enabled: enabled.has(`${a.broker}/${a.profile}`) ? "yes" : "no",
			}));
			if (opts.json) {
				outputJson({
					accounts: discovered.map((a) => ({
						...a,
						enabled: enabled.has(`${a.broker}/${a.profile}`),
					})),
				});
				return;
			}
			out("Discovered brokerage accounts (~/.kis-cli/config.yaml):");
			printTable(rows);
			out(
				"\nEnable for aggregation: td agent account enable <broker> <profile>",
			);
		});

	account
		.command("add <broker>")
		.description(
			"register a brokerage account via the koreainvestment-cli login (interactive)",
		)
		.action((broker: string) => {
			if (broker !== "kis" && broker !== "toss")
				fail(`broker must be kis or toss`, 2);
			const { cmd, args } = loginBrokerageCommand(broker);
			out(`Run the interactive login to register a ${broker} account:`);
			out(`  ${cmd} ${args.join(" ")}`);
			out(
				"(This delegates to the koreainvestment-cli which manages ~/.kis-cli/config.yaml.)",
			);
		});

	account
		.command("enable <broker> <profile>")
		.description("enable a discovered account for portfolio aggregation")
		.action((broker: string, profile: string) => {
			if (broker !== "kis" && broker !== "toss")
				fail(`broker must be kis or toss`, 2);
			const cfg: AppConfig = loadConfig();
			const exists = cfg.accounts.some(
				(a) => a.broker === broker && a.profile === profile,
			);
			if (!exists)
				cfg.accounts.push({ broker: broker as "kis" | "toss", profile });
			saveConfig(cfg);
			out(`✓ enabled ${broker}/${profile} for aggregation`);
		});

	account
		.command("disable <broker> <profile>")
		.description("disable an account for aggregation")
		.action((broker: string, profile: string) => {
			const cfg: AppConfig = loadConfig();
			cfg.accounts = cfg.accounts.filter(
				(a) => !(a.broker === broker && a.profile === profile),
			);
			saveConfig(cfg);
			out(`✓ disabled ${broker}/${profile}`);
		});
}
