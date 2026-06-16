#!/usr/bin/env node
'use strict';
/*
 * moonlight — chat pop-in surfacer (asyncRewake Stop hook).
 *
 * Zero LLM calls. If a new trade has happened since the last one we surfaced,
 * print a one-line summary to stderr and exit 2 — Claude Code injects stderr
 * as a system reminder into the live chat ("pop-in"). Otherwise exit 0.
 *
 * Reads/writes state.json directly so we never re-surface the same trade.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.moonlight');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function ok() {
  process.exit(0);
}

const cfg = readJson(CONFIG_PATH) || {};
if (cfg.surfaces && cfg.surfaces.chatPopins === false) ok();

const st = readJson(STATE_PATH);
if (!st || !Array.isArray(st.trades) || st.trades.length === 0) ok();

const latest = st.trades[st.trades.length - 1];
if (!latest || latest.id === st.lastSurfacedId) ok();

// Mark surfaced first so a crash can't loop on the same trade.
st.lastSurfacedId = latest.id;
try {
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, STATE_PATH);
} catch {
  ok();
}

const pnl = typeof st.todaysPnl === 'number' ? st.todaysPnl : 0;
const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
const verb = latest.mode === 'proposal' ? 'proposed' : latest.action || 'traded';
// Prefer the dollar (notional) amount for fractional buys; else show share qty.
const size = latest.notional ? `$${latest.notional} of` : `${latest.qty ?? ''}`.trim();
const line =
  `[moonlight] Background trade ${verb}: ${(latest.action || '').toUpperCase()} ` +
  `${size} ${latest.symbol || ''}`.replace(/\s+/g, ' ').trim() +
  (latest.price ? ` @ $${latest.price}` : '') +
  `. Today's P&L ${pnlStr}.` +
  (latest.note ? ` ${latest.note}` : '') +
  (latest.mode === 'proposal'
    ? ' Approve it in the moonlight dashboard (run: moonlight) or your Robinhood app.'
    : '');

process.stderr.write(line + '\n');
process.exit(2); // asyncRewake: surface to the live chat
