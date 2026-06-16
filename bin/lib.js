#!/usr/bin/env node
'use strict';
/*
 * moonlighter — shared state/config helper.
 *
 * This file performs ZERO LLM calls. It is the only thing that touches
 * config.json / state.json, and it backs the statusline, the hooks, and the
 * slash commands. Keep it dependency-free (Node stdlib only) and fast.
 *
 * Usage:  node lib.js <command> [args...]
 * Data lives in $CLAUDE_PLUGIN_DATA (falls back to ~/.moonlighter for dev).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA ||
  path.join(os.homedir(), '.moonlighter');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

const DEFAULT_CONFIG = {
  enabled: false, // opt-in: nothing trades until the user flips this on
  mode: 'propose', // 'propose' (write a proposal, approve via dashboard/RH app) | 'auto' (place trade)
  cadenceMinutes: 30, // fallback cadence if the agent does not set its own nextRunEpoch
  marketHoursOnly: true, // skip runs outside US equity regular hours
  maxRunsPerDay: 12, // hard daily ceiling on background runs (0 = unlimited)
  tradeModel: 'claude-sonnet-4-6', // model for the background run; cheaper than the session's Opus
  budgetCap: 100, // max $ the agent may deploy per trade
  maxPositionSize: 100, // max $ per single position
  allowedSymbols: [], // [] = no allowlist restriction
  blocklist: [],
  strategyNotes: 'Conservative. Small positions. Prefer liquid large-caps.',
  tickerMode: 'always', // statusline ticker: 'always' | 'events' | 'never'
  surfaces: {
    chatPopins: true, // inject new trades into the live chat
    desktopNotif: true, // native OS notification
  },
};

const DEFAULT_STATE = {
  trades: [], // {id, ts, action, symbol, qty, price, note}
  todaysPnl: 0,
  positions: [], // {symbol, qty, value, dayPct}
  headlines: [], // freeform strings the ticker rotates through
  nextRunEpoch: 0, // when the next background run becomes due (agent-set)
  lastRunEpoch: 0,
  pendingProposal: null, // {id, action, symbol, qty, estCost, rationale}
  lastSurfacedId: null, // newest trade id already shown as a chat pop-in
  runsToday: 0,
  dayStamp: '', // YYYY-MM-DD in ET, for daily-cap rollover
  updatedEpoch: 0,
};

// ---- io helpers -----------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function writeJson(p, obj) {
  ensureDir();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p); // atomic-ish; statusline never reads a half-written file
}

const readConfig = () => readJson(CONFIG_PATH, DEFAULT_CONFIG);
const readState = () => readJson(STATE_PATH, DEFAULT_STATE);
const writeConfig = (c) => writeJson(CONFIG_PATH, c);
const writeState = (s) => writeJson(STATE_PATH, { ...s, updatedEpoch: nowSec() });

const nowSec = () => Math.floor(Date.now() / 1000);

// dotted-path get/set on a plain object
function dotGet(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function dotSet(obj, dotted, val) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) {
    if (typeof o[k] !== 'object' || o[k] == null) o[k] = {};
    o = o[k];
  }
  o[last] = val;
  return obj;
}

function parseValue(raw) {
  // Accept JSON; fall back to raw string.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---- US equity market hours (America/New_York) ----------------------------

function etParts() {
  // Intl gives wall-clock parts in ET without needing a tz library.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return parts;
}

function etDayStamp() {
  const p = etParts();
  return `${p.year}-${p.month}-${p.day}`;
}

function isMarketOpen() {
  const p = etParts();
  const dow = p.weekday; // Mon..Sun
  if (dow === 'Sat' || dow === 'Sun') return false;
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60; // 09:30–16:00 ET
}

// ---- commands -------------------------------------------------------------

function cmdSeed() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) writeConfig(DEFAULT_CONFIG);
  if (!fs.existsSync(STATE_PATH)) writeState(DEFAULT_STATE);
  process.stdout.write(DATA_DIR + '\n');
}

function cmdGet(which, key) {
  const obj = which === 'config' ? readConfig() : readState();
  const val = key ? dotGet(obj, key) : obj;
  process.stdout.write(
    (typeof val === 'string' ? val : JSON.stringify(val)) + '\n'
  );
}

function cmdSet(which, key, rawVal) {
  const isConfig = which === 'config';
  const obj = isConfig ? readConfig() : readState();
  dotSet(obj, key, parseValue(rawVal));
  isConfig ? writeConfig(obj) : writeState(obj);
}

function cmdMarketOpen() {
  process.exit(isMarketOpen() ? 0 : 1);
}

function cmdUnderDailyCap() {
  const cfg = readConfig();
  if (!cfg.maxRunsPerDay || cfg.maxRunsPerDay <= 0) process.exit(0);
  const st = readState();
  const today = etDayStamp();
  const runs = st.dayStamp === today ? st.runsToday : 0;
  process.exit(runs < cfg.maxRunsPerDay ? 0 : 1);
}

function cmdRecordSpawn() {
  const st = readState();
  const today = etDayStamp();
  st.runsToday = st.dayStamp === today ? (st.runsToday || 0) + 1 : 1;
  st.dayStamp = today;
  writeState(st);
}

// Append a trade and mark it as the latest (used by chat pop-in surfacing).
function cmdAddTrade(json) {
  const st = readState();
  const t = parseValue(json);
  if (!t.id) t.id = `t${nowSec()}-${Math.floor((Date.now() % 1000))}`;
  if (!t.ts) t.ts = nowSec();
  st.trades.push(t);
  if (st.trades.length > 50) st.trades = st.trades.slice(-50);
  writeState(st);
  process.stdout.write(t.id + '\n');
}

function cmdHeadline(text) {
  const st = readState();
  st.headlines.push(text);
  if (st.headlines.length > 12) st.headlines = st.headlines.slice(-12);
  writeState(st);
}

// Called by the background agent as its LAST step.
function cmdFinish(nextEpochRaw) {
  const st = readState();
  st.lastRunEpoch = nowSec();
  const next = parseInt(nextEpochRaw, 10);
  if (Number.isFinite(next) && next > 0) {
    st.nextRunEpoch = next;
  } else {
    const cfg = readConfig();
    st.nextRunEpoch = nowSec() + (cfg.cadenceMinutes || 30) * 60;
  }
  writeState(st);
  // release the single-flight lock so the next due run can spawn
  try {
    fs.unlinkSync(path.join(DATA_DIR, 'run.lock'));
  } catch {}
  process.stdout.write('next run at epoch ' + st.nextRunEpoch + '\n');
}

// Open a file in the user's editor. Prefers $VISUAL/$EDITOR (terminal editors
// block until exit); falls back to macOS `open -t`, else `nano`.
function openEditor(file) {
  const { spawnSync } = require('child_process');
  const ed = process.env.VISUAL || process.env.EDITOR;
  if (ed) return spawnSync(ed, [file], { stdio: 'inherit', shell: true });
  if (process.platform === 'darwin') return spawnSync('open', ['-t', file], { stdio: 'inherit' });
  return spawnSync('nano', [file], { stdio: 'inherit' });
}

function run(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'edit': // open the config file in $EDITOR for arbitrary changes
      ensureDir();
      if (!fs.existsSync(CONFIG_PATH)) writeConfig(DEFAULT_CONFIG);
      openEditor(CONFIG_PATH);
      return;
    case 'seed':
      return cmdSeed();
    case 'get':
      return cmdGet(args[0], args[1]);
    case 'set':
      return cmdSet(args[0], args[1], args[2]);
    case 'market-open':
      return cmdMarketOpen();
    case 'under-daily-cap':
      return cmdUnderDailyCap();
    case 'record-spawn':
      return cmdRecordSpawn();
    case 'add-trade':
      return cmdAddTrade(args[0]);
    case 'headline':
      return cmdHeadline(args[0]);
    case 'finish':
      return cmdFinish(args[0]);
    case 'paths':
      process.stdout.write(
        JSON.stringify({ DATA_DIR, CONFIG_PATH, STATE_PATH, RUNS_DIR }) + '\n'
      );
      return;
    case 'ui':
    case undefined: // bare `moonlighter` opens the interactive dashboard
      ensureDir();
      if (!fs.existsSync(CONFIG_PATH)) writeConfig(DEFAULT_CONFIG);
      if (!fs.existsSync(STATE_PATH)) writeState(DEFAULT_STATE);
      return require('./ui.js').start(); // lazy require avoids a load cycle
    default:
      process.stderr.write('moonlighter: unknown command: ' + cmd + '\n');
      process.exit(1);
  }
}

if (require.main === module) run(process.argv.slice(2));

module.exports = {
  run,
  readConfig,
  writeConfig,
  readState,
  writeState,
  isMarketOpen,
  openEditor,
  nowSec,
  DATA_DIR,
  CONFIG_PATH,
  STATE_PATH,
  DEFAULT_CONFIG,
};
