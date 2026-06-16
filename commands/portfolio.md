---
description: Open your moonlight portfolio — holdings, P&L, talk to the trading agent, or run a cycle now.
allowed-tools: Read, Write, Bash, mcp__plugin_moonlight_robinhood-trading__*
---

Use the **moonlight** skill in interactive mode.

1. Read current config and state with the bundled command:
   `moonlight get config` and `moonlight get state`.
2. Read live holdings, balances, and positions from the `robinhood-trading` MCP.
3. Give me a tight summary: account(s), today's P&L, current positions, the
   agent's mode (`auto`/`propose`), next scheduled run, and any pending proposal.
4. Then wait for me. I may ask you to explain a position, change strategy, run a
   trading cycle now, or act on the pending proposal. Follow the safety contract
   in the skill at all times.

$ARGUMENTS
