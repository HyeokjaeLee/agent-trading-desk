import type { Command } from "commander";
import { loadConfig, saveConfig, setAssignment } from "../config/app-config.js";
import { listAvailableModels } from "../auth/providers.js";
import { ALL_ROLES, ROLE_LABELS } from "../agents/roles.js";
import { out, outputJson, fail, printTable } from "../output.js";
import type { AgentRole } from "../types.js";
import type { AppConfig } from "../config/app-config.js";

export function registerAgentCommands(root: Command): void {
	const agent = root
		.command("agent")
		.description(
			"assign models to investment agent roles and inspect the team",
		);

	agent
		.command("list")
		.description("list agent roles and their assigned models")
		.option("--json", "JSON output")
		.action((opts) => {
			const cfg = loadConfig();
			const rows = ALL_ROLES.map((role) => {
				const a = cfg.assignments.find((x) => x.role === role);
				return {
					role,
					label: ROLE_LABELS[role],
					model: a ? `${a.provider}/${a.modelId}` : "(unassigned)",
				};
			});
			if (opts.json) {
				outputJson({
					defaultModel: cfg.defaultModel,
					assignments: cfg.assignments,
					roles: rows,
				});
				return;
			}
			out(
				`Default model: ${cfg.defaultModel ? `${cfg.defaultModel.provider}/${cfg.defaultModel.modelId}` : "(none)"}`,
			);
			printTable(rows, ["role", "label", "model"]);
		});

	agent
		.command("assign <role> <provider> <modelId>")
		.description("assign a model to a role (role: " + ALL_ROLES.join("|") + ")")
		.action((role: string, provider: string, modelId: string) => {
			if (!ALL_ROLES.includes(role as AgentRole)) {
				fail(`Unknown role "${role}". Roles: ${ALL_ROLES.join(", ")}`, 2);
			}
			const cfg = setAssignment(
				loadConfig(),
				role as AgentRole,
				provider,
				modelId,
			);
			saveConfig(cfg);
			out(`✓ ${ROLE_LABELS[role as AgentRole]} → ${provider}/${modelId}`);
		});

	agent
		.command("default <provider> <modelId>")
		.description("set the default fallback model for unassigned roles")
		.action((provider: string, modelId: string) => {
			const cfg: AppConfig = loadConfig();
			cfg.defaultModel = { provider, modelId };
			saveConfig(cfg);
			out(`✓ default model → ${provider}/${modelId}`);
		});

	agent
		.command("roles")
		.description("describe each agent role")
		.option("--json", "JSON output")
		.action((opts) => {
			if (opts.json) {
				outputJson(ALL_ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] })));
				return;
			}
			for (const r of ALL_ROLES) {
				out(`• ${r} — ${ROLE_LABELS[r]}`);
			}
		});

	agent
		.command("models")
		.description("list available models to assign")
		.option("--json", "JSON output")
		.action((opts) => {
			const models = listAvailableModels();
			if (opts.json) outputJson(models);
			else
				printTable(
					models.map((m) => ({
						provider: m.provider,
						modelId: m.modelId,
						name: m.name,
					})),
				);
		});
}
