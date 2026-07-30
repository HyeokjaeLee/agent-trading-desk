/**
 * Session factory — the single place an agent session is created and a turn is
 * run. Extracted from the old 334-line runRole() so both the legacy pipeline
 * (debate.ts) and the new persistent SubAgentPool / PM orchestrator share one
 * implementation.
 *
 * A session is reusable: keep the handle, call runSessionTurn() repeatedly, and
 * the agent accumulates context across turns. Call session.dispose() once when
 * truly done.
 */
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAuthStorage, resolveModel } from "../auth/providers.js";
import { assignmentFor, type AppConfig } from "../config/app-config.js";
import { APP_DIR } from "../config/paths.js";
import type { AgentRole } from "../types.js";
import { systemPrompt, type AnalysisContext } from "./roles.js";

const DEFAULT_PER_CALL_TIMEOUT_MS = 300_000; // thinking models need headroom

export interface RoleSessionHandle {
	role: AgentRole;
	session: AgentSession;
	modelLabel: string;
}

export interface CreateRoleSessionOptions {
	/** Override the system prompt (e.g. PM orchestrator prompt). Defaults to the
	 * role's standard prompt. */
	systemPromptBuilder?: (ctx: AnalysisContext) => string;
	customTools?: ToolDefinition[];
	thinkingLevel?: ThinkingLevel;
}

/** Resolve model + build an isolated agent session for a role. */
export async function createRoleSession(
	role: AgentRole,
	ctx: AnalysisContext,
	config: AppConfig,
	opts?: CreateRoleSessionOptions,
): Promise<RoleSessionHandle> {
	const assignment = assignmentFor(config, role) ?? config.defaultModel;
	if (!assignment) {
		throw new Error(
			`No model assigned to role "${role}" and no defaultModel set. Run: td agent assign ${role} <provider> <modelId>`,
		);
	}
	const model = resolveModel(assignment.provider, assignment.modelId);
	if (!model) {
		throw new Error(
			`Model "${assignment.provider}/${assignment.modelId}" (role ${role}) not available. Check: td auth provider list`,
		);
	}

	const authStorage = getAuthStorage();
	const modelRegistry = ModelRegistry.create(authStorage);
	// Isolated agent dir: load NO user extensions/skills so analyst sessions stay clean.
	const isolatedAgentDir = join(APP_DIR, "agent");
	if (!existsSync(isolatedAgentDir))
		mkdirSync(isolatedAgentDir, { recursive: true });

	const promptBuilder =
		opts?.systemPromptBuilder ??
		((c: AnalysisContext) => systemPrompt(role, c));
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: isolatedAgentDir,
		systemPromptOverride: () => promptBuilder(ctx),
	});
	await resourceLoader.reload();

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 4000 },
	});
	const sessionManager = SessionManager.inMemory(process.cwd(), {});

	const { session } = await createAgentSession({
		model,
		thinkingLevel: opts?.thinkingLevel ?? "medium",
		authStorage,
		modelRegistry,
		resourceLoader,
		settingsManager,
		sessionManager,
		customTools: opts?.customTools ?? [],
	});

	return {
		role,
		session,
		modelLabel: `${assignment.provider}/${assignment.modelId}`,
	};
}

/** Run one turn: stream-collect text, enforce per-call timeout.
 * Returns "" on failure/empty so the caller can retry. Does NOT dispose. */
export async function runSessionTurn(
	session: AgentSession,
	instruction: string,
	config: AppConfig,
): Promise<string> {
	let text = "";
	const unsub = session.subscribe((event) => {
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			text += event.assistantMessageEvent.delta;
		}
	});

	const perCallTimeoutMs =
		(config as AppConfig & { perCallTimeoutMs?: number }).perCallTimeoutMs ??
		DEFAULT_PER_CALL_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			void session.abort();
		} catch {
			/* ignore */
		}
	}, perCallTimeoutMs);

	try {
		await session.prompt(instruction);
	} catch {
		clearTimeout(timer);
		unsub();
		return text;
	}
	clearTimeout(timer);
	// Fallback: pull final assistant text from history if no delta events fired.
	if (!text) text = lastAssistantText(session.messages);
	unsub();
	if (timedOut) return "";
	return text;
}

/** Last assistant message text from a session's message history. */
export function lastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown } | undefined;
		if (m?.role !== "assistant") continue;
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			const texts = c
				.filter(
					(p): p is { type: string; text?: string } =>
						typeof p === "object" &&
						p !== null &&
						(p as { type?: string }).type === "text",
				)
				.map((p) => p.text ?? "");
			if (texts.length) return texts.join("");
		}
	}
	return "";
}
