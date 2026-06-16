#!/usr/bin/env node
'use strict';
/*
 * moonlight — interactive terminal dashboard. Zero LLM calls.
 *
 * A real keyboard-driven TUI (raw mode):
 *   up / down     move the selection
 *   space  or  -> / <-   change the selected setting (cycle / step presets)
 *   a / r         approve / reject the pending proposal
 *   q / esc       quit
 *
 * Reads/writes the same ~/.moonlight/{config,state}.json the plugin uses, so
 * you configure everything and act on proposals OUTSIDE Claude Code. Pure Node
 * stdlib — no dependencies.
 *
 * Free-text fields (symbol lists, strategy notes) are intentionally NOT in this
 * keypress UI; set them with the CLI:  moonlight set config strategyNotes "…"
 */

const readline = require('readline');
const lib = require('./lib.js');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', rev: '\x1b[7m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'];

// Cycle a value through a list by direction, WRAPPING at both ends (so Space
// keeps rotating and never gets stuck at the top/bottom). For numeric ladders
// the current value is snapped to the nearest rung first.
function stepPreset(cur, arr, dir) {
  let idx = arr.indexOf(cur);
  if (idx === -1) {
    let best = Infinity;
    arr.forEach((v, i) => { const d = Math.abs(v - cur); if (d < best) { best = d; idx = i; } });
  }
  return arr[(idx + dir + arr.length) % arr.length];
}
const cycleList = stepPreset; // same wrap-around behavior for string lists
const surf = (c) => (c.surfaces = c.surfaces || {});

// Plain-language US market hours shown in brackets next to "market only".
const MKT_HOURS = '9:30a-4:00p ET';

// The editable settings. Each has a one-line `help` shown when highlighted, and
// a `change(cfg, dir)` that cycles/steps the value (Space or <-/->, wrapping).
// For arbitrary values (e.g. a custom $ amount or model id), edit the config
// file directly — press `e` in the dashboard, or `moonlight edit`.
const ITEMS = [
  { label: 'Trading', help: 'Master on/off switch. When off, the agent never trades in the background.',
    show: (c) => (c.enabled ? `${C.green}ENABLED${C.reset}` : `${C.gray}disabled${C.reset}`), change: (c) => (c.enabled = !c.enabled) },
  { label: 'Ticker', help: 'How often the moonlight line shows in your status bar.',
    show: (c) => c.tickerMode || 'always', change: (c, d) => (c.tickerMode = cycleList(c.tickerMode || 'always', ['always', 'events', 'never'], d)) },
  { label: 'Hours', help: `When the agent may trade. Stocks only fill in US market hours (${MKT_HOURS}); crypto trades 24/7.`,
    show: (c) => (c.marketHoursOnly ? `market only (${MKT_HOURS})` : '24/7 (anytime)'), change: (c) => (c.marketHoursOnly = !c.marketHoursOnly) },
  { label: 'Budget cap', help: 'Most money the agent may spend in ONE cycle. For a custom amount, press e to edit the file.',
    show: (c) => `$${c.budgetCap}`, change: (c, d) => (c.budgetCap = stepPreset(c.budgetCap, [5, 10, 25, 50, 100, 250, 500, 1000], d)) },
  { label: 'Max position', help: 'Most money allowed in any single stock/coin. For a custom amount, press e to edit the file.',
    show: (c) => `$${c.maxPositionSize}`, change: (c, d) => (c.maxPositionSize = stepPreset(c.maxPositionSize, [5, 10, 25, 50, 100, 250, 500, 1000], d)) },
  { label: 'Cadence', help: 'How often the agent wakes to consider a trade (while you are active).',
    show: (c) => `every ${c.cadenceMinutes} min`, change: (c, d) => (c.cadenceMinutes = stepPreset(c.cadenceMinutes, [5, 15, 30, 60, 120], d)) },
  { label: 'Daily cap', help: 'Safety limit: most background runs per day (0 = unlimited).',
    show: (c) => (c.maxRunsPerDay ? `${c.maxRunsPerDay}/day` : 'unlimited'), change: (c, d) => (c.maxRunsPerDay = stepPreset(c.maxRunsPerDay, [0, 6, 12, 24, 48], d)) },
  { label: 'Model', help: 'Claude model for the agent. Space cycles known ones; for any other id, press e to edit the file.',
    show: (c) => c.tradeModel, change: (c, d) => (c.tradeModel = cycleList(c.tradeModel, MODELS, d)) },
  { label: 'Chat pop-ins', help: 'Show each new trade inline in your Claude chat as it happens.',
    show: (c) => (c.surfaces && c.surfaces.chatPopins === false ? `${C.gray}off${C.reset}` : `${C.green}on${C.reset}`), change: (c) => (surf(c).chatPopins = c.surfaces.chatPopins === false) },
  { label: 'Desktop notif', help: 'Pop a macOS notification on your screen when the agent trades.',
    show: (c) => (c.surfaces && c.surfaces.desktopNotif === false ? `${C.gray}off${C.reset}` : `${C.green}on${C.reset}`), change: (c) => (surf(c).desktopNotif = c.surfaces.desktopNotif === false) },
];

const fmtAgo = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h');

function frame(cfg, st, sel, flash) {
  const now = lib.nowSec();
  const pnl = typeof st.todaysPnl === 'number' ? st.todaysPnl : 0;
  const pnlC = pnl >= 0 ? C.green : C.red;
  const L = [];
  L.push('');
  L.push(`  ${C.bold}${C.cyan}moonlight${C.reset}   ${cfg.enabled ? C.green + 'enabled' : C.gray + 'disabled'}${C.reset}`);
  L.push('');
  L.push(`  today P/L     ${pnlC}${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}${C.reset}`);
  if (st.account && st.account.buyingPower != null) L.push(`  buying power  $${Number(st.account.buyingPower).toFixed(2)}`);
  if (Array.isArray(st.positions) && st.positions.length) {
    L.push(`  holdings      ${st.positions.slice(0, 5).map((p) => { const d = typeof p.dayPct === 'number' ? p.dayPct : 0; return `${p.symbol} ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`; }).join('   ')}`);
  }
  let timing = 'standing by';
  if (st.nextRunEpoch && st.nextRunEpoch > now) timing = `next check in ~${fmtAgo(st.nextRunEpoch - now)}`;
  else if (st.lastRunEpoch) timing = `last checked ${fmtAgo(now - st.lastRunEpoch)} ago`;
  L.push(`  ${C.gray}${timing}${C.reset}`);

  L.push('');
  if (st.pendingProposal) {
    const p = st.pendingProposal;
    const size = p.notional ? `$${p.notional}` : `${p.qty || ''}`.trim();
    L.push(`  ${C.yellow}PENDING  ${(p.action || '').toUpperCase()} ${size} ${p.symbol || ''}${C.reset}${p.rationale ? C.dim + '  (' + p.rationale + ')' + C.reset : ''}`);
    L.push(`           ${p.userDecision ? C.dim + 'marked ' + p.userDecision + C.reset : C.green + 'a' + C.reset + ' approve   ' + C.red + 'r' + C.reset + ' reject'}`);
  } else {
    // Executed fills only — proposals are not trades.
    const recent = (Array.isArray(st.trades) ? st.trades : []).filter((t) => t.mode !== 'proposal').slice(-5).reverse();
    if (recent.length) {
      L.push(`  ${C.dim}recent trades${C.reset}`);
      recent.forEach((t) => {
        const size = t.notional ? `$${t.notional}` : `${t.qty || ''}`.trim();
        const px = t.price ? ` @ $${t.price}` : '';
        const ago = t.ts ? ` ${C.gray}${fmtAgo(now - t.ts)} ago${C.reset}` : '';
        L.push(`    ${(t.action || '?').toUpperCase()} ${size} ${t.symbol || ''}${px}${ago}`.replace(/ +$/, ''));
      });
    } else {
      L.push(`  ${C.dim}no trades yet${C.reset}`);
    }
  }

  L.push('');
  L.push(`  ${C.dim}─ settings ───────────────────────────${C.reset}`);
  ITEMS.forEach((it, i) => {
    const on = i === sel;
    const ptr = on ? `${C.cyan}>${C.reset}` : ' ';
    const label = (it.label + ' '.repeat(16)).slice(0, 16);
    const row = `${ptr} ${label} ${it.show(cfg)}`;
    L.push(on ? `  ${C.rev} ${stripForRev(it, cfg, label)} ${C.reset}` : `  ${row}`);
  });
  // Plain-language description of the highlighted setting.
  L.push('');
  L.push(`  ${C.cyan}i${C.reset} ${C.dim}${ITEMS[sel].help}${C.reset}`);
  L.push('');
  L.push(`  ${C.gray}up/down move   space or <-/-> change   a/r proposal   e edit file   q quit${C.reset}`);
  L.push(`  ${C.gray}config: ${lib.CONFIG_PATH}${C.reset}`);
  if (flash) L.push(`  ${C.green}${flash}${C.reset}`);
  L.push('');
  return L.join('\n');
}

// For the highlighted (reverse-video) row, avoid embedded color codes fighting
// the reverse attribute — render the value plain.
function stripForRev(it, cfg, label) {
  const plain = it.show(cfg).replace(/\x1b\[[0-9;]*m/g, '');
  return `> ${label} ${plain}`;
}

function start() {
  if (!process.stdin.isTTY) {
    process.stdout.write('moonlight dashboard needs an interactive terminal (TTY).\nUse the CLI instead, e.g. `moonlight get config`.\n');
    return;
  }
  let cfg = lib.readConfig();
  let st = lib.readState();
  let sel = 0;
  let flash = '';

  const paint = () => {
    cfg = lib.readConfig();
    st = lib.readState();
    process.stdout.write('\x1b[2J\x1b[H' + frame(cfg, st, sel, flash));
    flash = '';
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write('\x1b[?25l'); // hide cursor

  const quit = () => {
    process.stdin.removeListener('keypress', onKey);
    process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); // show cursor, clear
    process.stdout.write('moonlight dashboard closed.\n');
    process.exit(0);
  };

  // Open the config file in the user's editor for arbitrary edits. Terminal
  // editors block until they exit; GUI editors return immediately (the
  // dashboard re-reads the file on the next paint either way).
  const openConfig = () => {
    process.stdin.removeListener('keypress', onKey);
    process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    lib.openEditor(lib.CONFIG_PATH);
    process.stdin.setRawMode(true);
    process.stdout.write('\x1b[?25l');
    process.stdin.on('keypress', onKey);
    flash = 'reloaded config from file';
    paint();
  };

  function onKey(str, key) {
    key = key || {};
    if ((key.ctrl && key.name === 'c') || key.name === 'q' || key.name === 'escape') return quit();
    if (key.name === 'up') { sel = (sel - 1 + ITEMS.length) % ITEMS.length; return paint(); }
    if (key.name === 'down') { sel = (sel + 1) % ITEMS.length; return paint(); }
    if (str === 'e') return openConfig();

    const item = ITEMS[sel];
    if (key.name === 'left' || key.name === 'right' || key.name === 'space' || str === ' ' || key.name === 'return') {
      item.change(cfg, key.name === 'left' ? -1 : 1);
      lib.writeConfig(cfg);
      return paint();
    }
    if (str === 'a') {
      if (st.pendingProposal) { st.pendingProposal.userDecision = 'approve'; lib.writeState(st); flash = 'approved - order places on next agent cycle'; }
      else flash = 'no pending proposal';
      return paint();
    }
    if (str === 'r') {
      if (st.pendingProposal) { st.pendingProposal = null; st.headlines = [...(st.headlines || []), 'Proposal rejected'].slice(-12); lib.writeState(st); flash = 'rejected & cleared'; }
      else flash = 'no pending proposal';
      return paint();
    }
  }

  process.stdin.on('keypress', onKey);
  paint();
}

module.exports = { start, ITEMS, stepPreset, cycleList, frame };
