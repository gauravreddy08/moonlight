# moonlighter

> **Status: WIP / experimental.** Early work in progress, under active iteration.
> It trades **real money** on a Robinhood Agentic account — run it in `propose`
> mode with tiny limits, expect rough edges, and review before relying on it.

Claude moonlights as your trader while you code.

moonlighter is a Claude Code plugin that runs a small, risk-bounded trading agent
on your **real Robinhood Agentic account** — but only in the background, only
when *you're* actively coding, and only when a run is genuinely due. It surfaces
what it does as a live, scrolling **statusline ticker** (a `/pet` replacement),
**in-chat pop-ins**, and **desktop notifications** — each independently
toggleable.

> Real money. You connect your own Robinhood Agentic account and you own every
> action your agent takes. Start in `propose` mode with tiny limits.

## How it works

```
Stop / SessionStart hook ──gate──► claude -p (background trade run) ──► Robinhood MCP
   (you're active)        (due?      cheap model, single cycle          (read + trade)
                          locked?)              │
                                                ▼
                              config.json + state.json  (plugin data dir)
                                                │
              statusline ticker   ·   chat pop-in (asyncRewake)   ·   desktop notif
                          (all plain scripts — zero Claude credits)
```

The background agent **schedules its own next run** (writes `nextRunEpoch`). The
hook fires it only when you become active past that time — so there's no
continuous daemon, by design. The ticker shows how stale the data is.

## Credit safety

Claude credits are spent in **exactly one place**: the background trade-decision
run. The ticker, state writes, notifications, and pop-ins are plain Node/bash.
Before any run spawns, `bin/run-if-due.sh` checks: not already inside a
background session (`MOONLIGHTER_BG`), `enabled`, no run already alive
(single-flight PID lock), past `nextRunEpoch`, ≥60s since the last run, market
open (if required), and under the daily cap. The run uses a cheaper model
(`tradeModel`, default `claude-sonnet-4-6`).

## Install

```bash
# load locally for testing
claude --plugin-dir /path/to/moonlighter

# connect your Robinhood Agentic account (one-time browser auth)
claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading
```

The plugin's `.mcp.json` already declares the same server, so once the plugin is
enabled the `robinhood-trading` tools appear automatically; the `claude mcp add`
line is the equivalent manual route / for non-plugin setups.

> **Statusline note:** the plugin ships a default `statusLine` that runs the
> ticker. This overrides any existing statusline while enabled. Turn the ticker
> off with `/invest-config` (`surfaces.ticker false`) to fall back to yours.

## Use

- `/portfolio` — holdings, P&L, talk to the agent, or run a cycle now.
- `/invest-config` — run it bare for an **interactive chip-based wizard**
  (status, mode, surfaces, risk), or pass an instruction for one-shot edits like
  `/invest-config set cadence to 20` (cadence, market-hours, daily cap, model,
  symbol lists, strategy notes).
Approving proposals (in `propose` mode): use the **dashboard** (`moonlighter` →
`a`/`r`) or your **Robinhood app**. The slickest path is `auto` mode + Robinhood's
own "require approval" account setting, which pushes each trade to your phone with
Approve/Deny buttons.

## Standalone CLI / dashboard (outside Claude Code)

The same `moonlighter` command is a normal CLI. Install it globally so you can
configure and monitor from any terminal — no Claude session needed:

```bash
cd /path/to/moonlighter && npm link    # exposes `moonlighter` globally
moonlighter                            # opens the interactive dashboard (TUI)
```

In the dashboard you can flip every setting (↑/↓ move, Space or ←/→ change),
watch P&L / positions / next-run, and **approve/reject the pending proposal**
(`a`/`r`). Rejecting is instant; approving is recorded and the order is placed by
the agent on its next cycle (placing a trade needs the Robinhood MCP, which only
a Claude session can call).

For arbitrary values (a custom $ amount, a different model id, symbol lists),
edit the config file directly: press **`e`** in the dashboard, or run
`moonlighter edit` (opens `$EDITOR`). The file path is shown at the bottom of the
dashboard. Scriptable too: `moonlighter get config`, `moonlighter set config mode auto`.

## First run

1. `/invest-config` → set tiny `budgetCap`/`maxPositionSize`, keep `mode propose`.
2. `/invest-config enabled true`.
3. Keep coding. When a run is due and you're active, a proposal pops into chat
   and the ticker; approve it from the `moonlighter` dashboard (`a`) or RH app.
4. Trust it? `/invest-config mode auto` (+ Robinhood "require approval" for
   phone-push Approve/Deny on each trade).

## Config reference

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | master switch |
| `mode` | `propose` | `propose` (wait for approval via dashboard/RH app) or `auto` (place trades) |
| `cadenceMinutes` | `30` | fallback cadence if the agent doesn't self-schedule |
| `marketHoursOnly` | `true` | skip runs outside 09:30–16:00 ET, Mon–Fri |
| `maxRunsPerDay` | `12` | hard daily ceiling (0 = unlimited) |
| `tradeModel` | `claude-sonnet-4-6` | model for background runs |
| `budgetCap` | `100` | max $ deployed per cycle |
| `maxPositionSize` | `100` | max $ per position |
| `allowedSymbols` | `[]` | allowlist ([] = no restriction) |
| `blocklist` | `[]` | never-trade symbols |
| `strategyNotes` | conservative | free-text guidance to the agent |
| `tickerMode` | `always` | statusline ticker: `always`, `events` (only on a proposal/recent trade), or `never` |
| `surfaces.chatPopins` / `.desktopNotif` | `true` | in-chat pop-ins / desktop notifications on/off |
