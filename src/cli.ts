import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerAnalyzeCommands } from "./commands/analyze.js";
import { registerAskCommands } from "./commands/ask.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerProxyCommands } from "./commands/proxy.js";
import { fail } from "./output.js";

// Prevent SIGPIPE from killing the process when stdout is piped in background mode.
// Without this, large stdout writes (yfinance data, agent output) to a closed/buffered
// pipe raise SIGPIPE → process dies silently after ~15-20s.
process.stdout?.on?.("error", () => {});
process.stderr?.on?.("error", () => {});

const program = new Command();

program
	.name("td")
	.description(
		"agent-trading-desk — multi-agent investment CLI. Aggregates KIS + Toss accounts, pulls PBR/PER/PSR/PCR + charts from yfinance (single source of truth), and runs a PM-orchestrated team of investment agents (the portfolio-manager delegates to technical/fundamental/news/bull-bear/risk/reviewer specialists, in parallel) to a consensus. READ-ONLY: never places orders.",
	)
	.version("0.1.0");

registerAuthCommands(program);
registerAgentCommands(program);
registerMarketCommands(program);
registerAccountCommands(program);
registerAnalyzeCommands(program);
registerAskCommands(program);
registerBotCommands(program);
registerProxyCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
	fail(err instanceof Error ? err.message : String(err), 1);
});
