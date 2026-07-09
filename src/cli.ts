import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerAnalyzeCommands } from "./commands/analyze.js";
import { registerAskCommands } from "./commands/ask.js";
import { registerBotCommands } from "./commands/bot.js";
import { fail } from "./output.js";

const program = new Command();

program
	.name("td")
	.description(
		"agent-trading-desk — multi-agent investment CLI. Aggregates KIS + Toss accounts, pulls PBR/PER/PSR/PCR + charts from yfinance (single source of truth), and runs a debating team of investment agents (technical, fundamental, news, bull/bear, risk, reviewer, portfolio-manager) to a consensus. READ-ONLY: never places orders.",
	)
	.version("0.1.0");

registerAuthCommands(program);
registerAgentCommands(program);
registerMarketCommands(program);
registerAccountCommands(program);
registerAnalyzeCommands(program);
registerAskCommands(program);
registerBotCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
	fail(err instanceof Error ? err.message : String(err), 1);
});
