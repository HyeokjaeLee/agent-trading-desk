/**
 * agent-trading-desk — agent-friendly multi-agent investment CLI.
 *
 * Public API for programmatic use (Openclaw, Hermes, or other agents embedding
 * the desk). The `td` binary is the primary interface; this module exposes the
 * building blocks for embedding.
 */

export * from "./types.js";
export {
	loadConfig,
	saveConfig,
	assignmentFor,
	setAssignment,
	type AppConfig,
} from "./config/app-config.js";
export {
	APP_DIR,
	SNAPSHOT_FILE,
	PORTFOLIO_FILE,
	MEMORY_FILE,
} from "./config/paths.js";
export { aggregatePortfolio } from "./accounts/aggregate.js";
export {
	refreshSnapshot,
	loadSnapshot,
	snapshotAgeMs,
	resolveTickers,
} from "./market/snapshot.js";
export { fetchTickers } from "./market/yfinance.js";
export { getMarketState, newsSignalWeight } from "./market/market-state.js";
export { mapToYahoo, yahooToSymbol } from "./market/ticker-map.js";
export {
	listProviders,
	listAvailableModels,
	resolveModel,
	addApiKey,
	removeProvider,
} from "./auth/providers.js";
export { discoverAccounts } from "./auth/accounts.js";
export {
	ALL_ROLES,
	ROLE_LABELS,
	systemPrompt,
	userMessage,
} from "./agents/roles.js";
export {
	runRole,
	parseReport,
	parseRecommendation,
	type RunResult,
} from "./agents/registry.js";
export { runAnalysis, type AnalysisOutcome } from "./agents/debate.js";
export {
	buildAnalysisContext,
	type BuildContextOptions,
} from "./agents/pipeline.js";
export { recordDecision, loadRelevantMemory } from "./agents/memory.js";
export {
	fetchNews,
	type NewsItem,
	type NewsResult,
} from "./news/browser-use.js";
