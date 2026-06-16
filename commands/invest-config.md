---
description: Configure moonlight trading settings via an interactive wizard (or a one-shot instruction).
allowed-tools: Read, Write, Bash, AskUserQuestion
---

Manage moonlight configuration. No trading happens here — this only edits
config via the bundled `moonlight` command (on your PATH while the plugin is
enabled). Zero Claude credits beyond this turn.

First, always read the current config so you can reflect existing values:
`moonlight get config`

## If `$ARGUMENTS` is non-empty (one-shot mode)

Apply exactly what I asked with `moonlight set config ...`, then re-print the
config. Examples:
- `moonlight set config enabled true` · `moonlight set config mode auto`
- `moonlight set config cadenceMinutes 20` · `moonlight set config marketHoursOnly false`
- `moonlight set config maxRunsPerDay 8` · `moonlight set config tradeModel claude-haiku-4-5`
- `moonlight set config budgetCap 250` · `moonlight set config maxPositionSize 100`
- `moonlight set config allowedSymbols '["NVDA","AAPL"]'` · `moonlight set config blocklist '["GME"]'`
- `moonlight set config strategyNotes "Only dividend large-caps."`
- `moonlight set config tickerMode always` (or `events`, `never`)
- `moonlight set config surfaces.chatPopins false` · `moonlight set config surfaces.desktopNotif false`

## If `$ARGUMENTS` is empty (interactive wizard)

Use the **AskUserQuestion** tool to present the settings as clickable chips. Make
the option that matches the CURRENT config value the first option and append
" (current)" to its label, so it reads like a settings panel. Ask these four
questions in a single AskUserQuestion call:

1. **header "Status"** — "Should moonlight trade in the background?"
   - `Enabled` — runs background cycles when due and you're active
   - `Disabled` — pause all background activity

2. **header "Mode"** — "How should it act on decisions?"
   - `Propose` — write a proposal, approve in dashboard/RH app (safer)
   - `Auto` — place trades automatically within your risk limits

3. **header "Ticker"** — "When should the statusline ticker show?"
   - `Always on` — always visible (sets `tickerMode always`)
   - `Only on events` — appears only for a pending proposal or a just-placed
     trade (sets `tickerMode events`)
   - `Never` — hidden (sets `tickerMode never`)
   (The in-chat pop-ins and desktop notifications are separate toggles —
   `surfaces.chatPopins` / `surfaces.desktopNotif` — changeable via
   `/invest-config <instruction>`.)

4. **header "Risk"** — "Spending limit per trade?"
   - `Conservative — $50` (budgetCap 50, maxPositionSize 50)
   - `Moderate — $250` (budgetCap 250, maxPositionSize 100)
   - `Aggressive — $1000` (budgetCap 1000, maxPositionSize 500)
   (The user can pick "Other" to type a custom dollar amount — if so, set both
   budgetCap and maxPositionSize to that number.)

Apply those four answers with `moonlight set config ...`.

Then ask a SECOND AskUserQuestion call for the deeper settings (again mark the
current value first with " (current)"):

5. **header "Cadence"** — "How often should it run a trading cycle?"
   - `Every 5 min` (cadenceMinutes 5) · `Every 15 min` (15) · `Every 30 min` (30)
     · `Hourly` (60)

6. **header "Hours"** — "When is it allowed to run?"
   - `Market hours only` (marketHoursOnly true) · `Anytime / 24-7` (marketHoursOnly false)

7. **header "Daily cap"** — "Max background runs per day?"
   - `6` · `12` · `24` · `Unlimited` (maxRunsPerDay 0)

8. **header "Model"** — "Which model runs the background agent?"
   - `Sonnet - balanced` (claude-sonnet-4-6) · `Haiku - cheapest` (claude-haiku-4-5)
     · `Opus - best` (claude-opus-4-8)

Apply those too. Then finish with a compact summary of the full resulting config.

Two settings stay one-shot only (free text, not chips): symbol lists and strategy
notes. Tell the user they can set those with:
`/invest-config set allowedSymbols '["NVDA","BTC"]'`, `/invest-config set blocklist '["GME"]'`,
`/invest-config set strategyNotes "..."`.

$ARGUMENTS
