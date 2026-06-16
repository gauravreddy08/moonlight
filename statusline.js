#!/usr/bin/env node
'use strict';
/*
 * moonlighter — statusline ticker. Zero LLM calls.
 *
 * Claude Code runs this every ~1s (refreshInterval) and passes session JSON on
 * stdin (ignored here). We read state.json and render a single ANSI line.
 *
 * Display rules learned the hard way:
 *  - ASCII ONLY. Fancy Unicode glyphs (diamonds, hourglasses, arrows) render as
 *    mojibake ("â") in some statusline hosts. ANSI color codes are fine.
 *  - ROTATE whole messages, don't scroll character-by-character — a char marquee
 *    chops words mid-stream ("PROPOSAL" -> "OSAL") and is unreadable.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.moonlighter');

// ANSI color (safe everywhere ANSI works)
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const out = (s) => process.stdout.write(s);

function fmtAgo(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

// Force text to ASCII. Agent-written headlines/notes can contain smart
// punctuation (em dashes, curly quotes, ellipses) that renders as mojibake in
// some statusline hosts — map the common ones, drop anything else non-ASCII.
function asciify(s) {
  return String(s)
    .replace(/[‒-―−]/g, '-') // dashes
    .replace(/[‘’‛]/g, "'") // single quotes
    .replace(/[“”]/g, '"') // double quotes
    .replace(/…/g, '...') // ellipsis
    .replace(/[•·]/g, '*') // bullets/middots
    .replace(/[^\x20-\x7E]/g, ''); // strip any remaining non-ASCII
}

// Truncate plain text (no ANSI inside) to n chars with an ASCII ellipsis.
function clip(s, n) {
  s = asciify(s);
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 3)) + '...';
}

function main() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json')) || {};
  const surfaces = cfg.surfaces || {};

  // Ticker visibility: 'always' | 'events' | 'never'.
  //   always — show on every refresh
  //   events — show only when there's something to act on/just happened
  //            (a pending proposal, or a trade in the last 10 min)
  //   never  — never render
  // Back-compat: a legacy surfaces.ticker===false is treated as 'never'.
  const mode = cfg.tickerMode || (surfaces.ticker === false ? 'never' : 'always');
  if (mode === 'never') return;

  const st = readJson(path.join(DATA_DIR, 'state.json'));
  const now = Math.floor(Date.now() / 1000);

  if (!cfg.enabled) {
    if (mode === 'events') return; // nothing to event on
    out(`${C.gray}* moonlighter idle - /invest-config to enable${C.reset}`);
    return;
  }
  if (!st) {
    if (mode === 'events') return;
    out(`${C.cyan}* moonlighter${C.reset} ${C.dim}warming up...${C.reset}`);
    return;
  }

  // events mode: render only on a live proposal or a very recent trade.
  if (mode === 'events') {
    const newest =
      Array.isArray(st.trades) && st.trades.length
        ? st.trades[st.trades.length - 1]
        : null;
    const recentTrade = newest && newest.ts && now - newest.ts < 600;
    if (!st.pendingProposal && !recentTrade) return;
  }

  // A pending proposal is actionable, so PIN it (don't rotate it away).
  if (st.pendingProposal) {
    const p = st.pendingProposal;
    const size = p.notional ? `$${p.notional}` : `${p.qty || ''}`.trim();
    let t = `PROPOSAL: ${(p.action || '').toUpperCase()} ${size} ${p.symbol || ''}`.replace(/\s+/g, ' ').trim();
    if (!p.notional && p.estCost) t += ` (~$${p.estCost})`;
    t += ` - approve in moonlighter / RH app`;
    return out(render({ text: t, color: C.yellow }));
  }

  // Otherwise ROTATE among different views of the data the agent already saved.
  // No agent call happens here — this is pure presentation. The card advances
  // every 5 min off the wall clock, so closing/sleeping the laptop never
  // desyncs it: each render recomputes the bucket from real time.
  const cards = buildCards(st, now);
  const idx = Math.floor(Date.now() / (5 * 60 * 1000)) % cards.length;
  out(render(cards[idx]));
}

// Build the rotation deck from stored state. Each entry is one self-contained
// view. Order doesn't matter — rotation picks by time bucket.
function buildCards(st, now) {
  const cards = [];
  const trades = Array.isArray(st.trades) ? st.trades : [];
  const last = trades.length ? trades[trades.length - 1] : null;

  // 1. most recent transaction
  if (last) {
    const size = last.notional ? `$${last.notional}` : `${last.qty || ''}`.trim();
    const px = last.price ? ` @ $${last.price}` : '';
    const verb = last.mode === 'proposal' ? 'PROPOSED' : (last.action || 'trade').toUpperCase();
    cards.push({ text: `last: ${verb} ${size} ${last.symbol || ''}${px}`.replace(/\s+/g, ' ').trim(), color: '' });
  }

  // 2. today's profit/loss
  if (typeof st.todaysPnl === 'number') {
    const p = st.todaysPnl;
    cards.push({ text: `today P/L ${p >= 0 ? '+' : '-'}$${Math.abs(p).toFixed(2)}`, color: p >= 0 ? C.green : C.red });
  }

  // 3. holdings snapshot
  if (Array.isArray(st.positions) && st.positions.length) {
    const t = st.positions.slice(0, 3).map((pos) => {
      const d = typeof pos.dayPct === 'number' ? pos.dayPct : 0;
      return `${pos.symbol} ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    }).join('  ');
    cards.push({ text: `holdings: ${t}`, color: '' });
  }

  // 4. account buying power (if the agent stored it)
  if (st.account && st.account.buyingPower != null) {
    cards.push({ text: `buying power $${Number(st.account.buyingPower).toFixed(2)}`, color: '' });
  }

  // 5. latest agent note / headline
  if (Array.isArray(st.headlines) && st.headlines.length) {
    cards.push({ text: String(st.headlines[st.headlines.length - 1]), color: '' });
  }

  // 6. status / next check (recomputed from wall clock every render)
  let status;
  if (st.nextRunEpoch && st.nextRunEpoch > now) status = `next check in ~${fmtAgo(st.nextRunEpoch - now)}`;
  else if (st.lastRunEpoch) status = `last checked ${fmtAgo(now - st.lastRunEpoch)} ago`;
  else status = 'standing by';
  cards.push({ text: status, color: C.gray });

  return cards.length ? cards : [{ text: 'no activity yet', color: C.dim }];
}

function render(card) {
  const head = `${C.bold}${C.cyan}moonlighter${C.reset}`;
  const body = `${card.color || ''}${clip(card.text, 64)}${C.reset}`;
  return `${head} ${C.gray}>${C.reset} ${body}`;
}

main();
