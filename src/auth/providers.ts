import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Model-provider (LLM) management. Reuses pi's AuthStorage + ModelRegistry,
 * which read ~/.pi/agent/auth.json and ~/.pi/agent/models.json — so providers
 * already configured in the pi environment (gpt/openai-codex, claude, zai,
 * opencode-go, grepp-anthropic, ...) are immediately usable.
 */

export interface ProviderInfo {
	provider: string;
	displayName: string;
	authType: "api_key" | "oauth" | "unknown";
	configured: boolean;
	models: ModelInfo[];
}

export interface ModelInfo {
	provider: string;
	modelId: string;
	name: string;
	reasoning: boolean;
}

export function getAuthStorage(): AuthStorage {
	return AuthStorage.create();
}

export function getModelRegistry(): ModelRegistry {
	return ModelRegistry.create(getAuthStorage());
}

/** List providers that have credentials, each with its available models. */
export function listProviders(): ProviderInfo[] {
	const auth = getAuthStorage();
	const registry = getModelRegistry();
	const providersWithCreds = auth.list();
	const available = registry.getAvailable();

	// Group available models by provider.
	const modelsByProvider = new Map<string, ModelInfo[]>();
	for (const m of available) {
		const list = modelsByProvider.get(m.provider) ?? [];
		list.push({
			provider: m.provider,
			modelId: m.id,
			name: m.name,
			reasoning: m.reasoning ?? false,
		});
		modelsByProvider.set(m.provider, list);
	}

	const seen = new Set<string>();
	const out: ProviderInfo[] = [];
	for (const provider of providersWithCreds) {
		seen.add(provider);
		const cred = auth.get(provider);
		const authType: ProviderInfo["authType"] =
			cred?.type === "oauth"
				? "oauth"
				: cred?.type === "api_key"
					? "api_key"
					: "unknown";
		out.push({
			provider,
			displayName: registry.getProviderDisplayName(provider) ?? provider,
			authType,
			configured: true,
			models: modelsByProvider.get(provider) ?? [],
		});
	}
	// Also surface providers that have models configured in models.json but no key yet,
	// so the user knows they can be enabled.
	for (const [provider, models] of modelsByProvider) {
		if (!seen.has(provider)) {
			out.push({
				provider,
				displayName: registry.getProviderDisplayName(provider) ?? provider,
				authType: "unknown",
				configured: false,
				models,
			});
		}
	}
	return out;
}

/** List all models that are ready to use (auth configured). */
export function listAvailableModels(): ModelInfo[] {
	const registry = getModelRegistry();
	return registry.getAvailable().map((m) => ({
		provider: m.provider,
		modelId: m.id,
		name: m.name,
		reasoning: m.reasoning ?? false,
	}));
}

/** Find a concrete model by provider+id (must be available/authed). */
export function resolveModel(provider: string, modelId: string) {
	const registry = getModelRegistry();
	return registry.find(provider, modelId);
}

/** Add or replace an API-key credential for a provider. */
export function addApiKey(provider: string, apiKey: string): void {
	const auth = getAuthStorage();
	auth.set(provider, { type: "api_key", key: apiKey });
}

/** Remove a provider's credential. */
export function removeProvider(provider: string): void {
	const auth = getAuthStorage();
	auth.logout(provider);
}
