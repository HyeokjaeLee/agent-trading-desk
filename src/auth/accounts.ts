import { loadConfig } from "koreainvestment-cli";
import type { BrokerageAccountRef } from "../types.js";

/**
 * Brokerage account discovery. Reads the shared ~/.kis-cli/config.yaml that the
 * koreainvestment-cli manages, so accounts already logged in via `kis auth login`
 * or `toss auth login` appear here automatically.
 */

export interface DiscoveredAccount extends BrokerageAccountRef {
	/** Real (false) or paper-trading (true). */
	paper: boolean;
	/** Display details. */
	detail?: string;
}

/** Discover all configured KIS + Toss accounts. */
export async function discoverAccounts(): Promise<DiscoveredAccount[]> {
	const config = await loadConfig();
	const out: DiscoveredAccount[] = [];

	for (const [name, profile] of Object.entries(config.profiles)) {
		out.push({
			broker: "kis",
			profile: name,
			label: `KIS ${name}`,
			paper: profile.env === "paper",
			detail: `account ${profile.accountNumber} (${profile.env})`,
		});
	}
	for (const [name, profile] of Object.entries(config.tossProfiles)) {
		out.push({
			broker: "toss",
			profile: name,
			label: `Toss ${name}`,
			paper: false,
			detail: profile.accountNo ? `account ${profile.accountNo}` : undefined,
		});
	}

	return out;
}

/**
 * Register a new brokerage account by delegating to the koreainvestment-cli's
 * own interactive login (interactive: opens prompts). Returns the spawned
 * process so the caller can stream output. Agent callers should prefer passing
 * credentials via environment / config directly.
 */
export function loginBrokerageCommand(broker: "kis" | "toss"): {
	cmd: string;
	args: string[];
} {
	if (broker === "kis") return { cmd: "kis", args: ["auth", "login"] };
	return { cmd: "toss", args: ["auth", "login"] };
}
