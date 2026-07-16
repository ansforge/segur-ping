'use strict';
// Rebuild docs/data/index.json: the list of available days plus a rolling
// 24h per-target summary (avg/min/max RTT, packet loss %, uptime %, status).
// Run at publish time (every 2h or manual). The frontend reads this manifest.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function listDays() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort();
}

function loadDay(day) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${day}.json`), 'utf8')); }
  catch (_) { return []; }
}

function summarize(records) {
  // records: all records for one target within the window
  if (!records.length) {
    return { avg_rtt: null, min_rtt: null, max_rtt: null, loss_pct: null, uptime_pct: null, samples: 0, lastSeen: null, status: 'unknown' };
  }
  const up = records.filter((r) => r.ok);
  const rtts = up.map((r) => r.rtt_avg).filter((v) => v != null);
  const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const last = sorted[sorted.length - 1];
  return {
    samples: records.length,
    avg_rtt: rtts.length ? round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
    min_rtt: rtts.length ? round(Math.min(...rtts)) : null,
    max_rtt: rtts.length ? round(Math.max(...rtts)) : null,
    loss_pct: round(records.reduce((a, r) => a + (r.loss_pct || 0), 0) / records.length),
    uptime_pct: round((up.length / records.length) * 100),
    lastSeen: last.ts,
    status: last.ok ? 'up' : 'down',
  };
}

function main() {
  const days = listDays();
  // Gather last ~24h of records: load today + yesterday and filter by timestamp.
  const recent = [];
  for (const day of days.slice(-2)) recent.push(...loadDay(day));
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const within = recent.filter((r) => new Date(r.ts).getTime() >= cutoff);

  const targets = config.targets.map((t) => ({
    ip: t.ip,
    label: t.label,
    last24h: summarize(within.filter((r) => r.ip === t.ip)),
  }));

  const index = {
    generatedAt: new Date().toISOString(),
    timezone: config.timezone || 'UTC',
    days,
    targets,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`[build-site] index.json written: ${days.length} days, ${targets.length} targets`);
}

main();
