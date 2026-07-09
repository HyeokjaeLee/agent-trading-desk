# agent-trading-desk (`td`)

> Agent-friendly multi-agent investment CLI. Aggregates your **KIS + Toss** accounts
> (read-only), pulls **PBR / PER / PSR / PCR + charts** from **yfinance** (single source
> of truth), and runs a **debating team of investment agents** (technical, fundamental,
> news, bull/bear, risk, judgment-reviewer, portfolio-manager) to a consensus
> portfolio / strategy. Built on the **pi SDK** with TypeScript + Bun.

Designed for **agent consumers** (Openclaw, Hermes, Claude Code, OpenCode, …) more than
for humans: every command supports `--json` with a stable schema, no interactive prompts,
and clear exit codes. It **never places orders** — account access is strictly read-only.

---

## Why

- **One source of truth.** Yahoo/yfinance data is fetched **once** per invocation
  (`td market refresh`) and cached. All agents read that cache — they never hit the
  network themselves. (`td market refresh` → `~/.agent-trading-desk/market-snapshot.json`)
- **Read-only brokerage.** Aggregates cash (KRW/USD) + holdings across **all** linked
  KIS profiles and Toss accounts via [`koreainvestment-cli`](https://github.com/HyeokjaeLee/koreainvestment-cli).
  No order/trade endpoints are ever called.
- **Multi-agent debate.** Specialist analysts produce independent reports → **bull/bear**
  debate adversarially → **risk manager** sizes/gates → **judgment reviewer**
  (devil's advocate) checks for stale data, priced-in news, and overconfidence →
  **portfolio manager** synthesizes the final decision. Inspired by
  [TradingAgents](https://github.com/tauricresearch/tradingagents),
  [TradingCodex](https://github.com/monarchjuno/tradingcodex).
- **Cross-market leading indicators.** When the Korean market is closed, US proxies
  (e.g. **SOXX/SMH** = Philadelphia Semiconductor index, **MU** = Micron, **NVDA**)
  are fetched as **active forward signals** for the next KR open of Samsung / SK Hynix.
- **News with the priced-in principle.** Via [browser-use](https://github.com/browser-use/browser-use)
  (MCP). If a market is OPEN on the news date → treated as already priced in
  (reference only). If the market is CLOSED and the news is directional → active signal
  for the next open.
- **Decision memory.** Each decision is logged; prior same-ticker decisions are injected
  for reflection on the next run.

## Install

```bash
git clone <this repo> && cd agent-trading-desk
bun install
bun run build           # → dist/cli.js
```

Then either `bun dist/cli.js <cmd>` or link the `td` binary. Python 3 with `yfinance`
is required for market data (only invoked through the bundled bridge).

## Quick start

```bash
# 1. Brokerage accounts already live in ~/.kis-cli (via `kis auth login` / `toss auth login`)
td auth account list
td auth account enable kis main
td auth account enable toss default

# 2. Models already configured in ~/.pi/agent (gpt/claude/zai/opencode-go …)
td auth provider list            # see available models
td agent default opencode-go glm-5.2
td agent assign portfolio-manager opencode-go glm-5.2
td agent assign risk openai-codex gpt-5.5

# 3. Fetch market data ONCE (holdings + US leading-indicator proxies)
td market refresh

# 4. Run the desk
td analyze portfolio             # recommend stocks to add / adjust
td analyze strategy              # current-time response strategy
```

## Commands

| Command | Description |
|---|---|
| `td auth provider list\|add\|login\|remove` | manage LLM providers (reuses `~/.pi/agent`) |
| `td auth provider models` | list all authed models ready to assign |
| `td auth account list\|enable\|disable` | manage linked brokerage accounts (`~/.kis-cli`) |
| `td agent list\|assign\|default\|roles` | assign models to agent roles |
| `td market refresh [--symbols …]` | fetch yfinance data ONCE → cached source of truth |
| `td market status` | snapshot age + KR/US session state |
| `td account summary` | read-only aggregated cash (KRW/USD) + holdings |
| `td analyze portfolio` | multi-agent recommendation (additions / adjustments) |
| `td analyze strategy` | multi-agent current-time response strategy |

All commands accept `--json`. Analyze flags: `--symbols AAPL,005930`,
`--refresh`, `--no-news`, `--blind` (backtest: hide realized outcomes),
`--as-of 2026-05-01`, `--report` (include full per-agent reports).

## Agent roles

`technical` · `fundamental` · `news` · `bull` · `bear` · `risk` · `reviewer`
· `portfolio-manager`. Assign any available model to any role, or set a
`td agent default`. Roles run: analysts (parallel) → bull/bear debate (N rounds) →
risk + reviewer (parallel) → portfolio-manager synthesis.

## Output schema (`td analyze … --json`)

```jsonc
{
  "generatedAt": "2026-07-08T…",
  "objective": "portfolio-recommend" | "strategy",
  "marketState": { "KR": {…}, "US": {…} },
  "positions": [
    { "ticker": "005930.KS", "name": "Samsung Electronics",
      "action": "buy|hold|trim|sell|watch|avoid", "confidence": 0.78,
      "rationale": "…", "targetWeight": 0.30, "horizon": "medium", "keyRisks": ["…"] }
  ],
  "strategy": "…", "cashGuidance": "…", "warnings": ["…"],
  "reports": [ /* per-agent reports */ ], "debate": [ /* rounds */ ]
}
```

## Architecture

```
src/
  cli.ts                      # `td` entrypoint (commander)
  types.ts                    # stable domain + output schemas
  config/                     # app config + paths (~/.agent-trading-desk)
  auth/   providers.ts accounts.ts     # models (pi AuthStorage) + brokerage (koreainvestment-cli)
  accounts/  kis.ts toss.ts aggregate.ts  # READ-ONLY aggregation → AggregatedPortfolio
  market/   yfinance.ts(snapshot via py/yfinance_fetch.py), proxies.ts, market-state.ts, ticker-map.ts
  news/   browser-use.ts      # news via browser-use MCP (graceful degradation)
  agents/  roles.ts registry.ts debate.ts pipeline.ts memory.ts   # multi-agent orchestration
  commands/                   # auth, agent, market, account, analyze
py/yfinance_fetch.py          # the ONLY Yahoo access (fundamentals + TA indicators)
```

## Safety

- **Read-only.** No order/trade/price POST endpoints. KIS uses only `inquire-balance`,
  `inquire-account-balance`, overseas `inquire-balance` (GET); Toss uses only
  `getAccounts` / `getHoldings` / `getBuyingPower`.
- **Isolated agent sessions.** Analyst sessions load no user pi extensions/skills.
- Per-call timeout guards so one slow model can't sink a run.

## License

MIT.
