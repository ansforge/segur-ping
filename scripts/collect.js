'use strict';
// Ping every configured target once (in parallel) and append one record per
// target to today's daily JSON file under docs/data/. Runs every minute.

const fs = require('fs');
const path = require('path');
const { measure } = require('./ping');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'docs', 'data');

// Format the current instant in a given IANA timezone into date/hour/ISO parts.
function nowInTz(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  // Offset like "GMT+02:00" -> "+02:00"
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now).find((p) => p.type === 'timeZoneName');
  let offset = '+00:00';
  if (tzName && /GMT([+-]\d{2}:\d{2})/.test(tzName.value)) {
    offset = tzName.value.match(/GMT([+-]\d{2}:\d{2})/)[1];
  }

  const hour24 = parts.hour === '24' ? '00' : parts.hour; // guard Intl edge case
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const ts = `${date}T${hour24}:${parts.minute}:${parts.second}${offset}`;
  return { ts, date, hour: parseInt(hour24, 10) };
}

function atomicWriteJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // Node's rename overwrites the target on all platforms
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const tz = config.timezone || 'UTC';
  const { ts, date, hour } = nowInTz(tz);

  const results = await Promise.all(
    config.targets.map((t) =>
      measure(t, config)
        .then((r) => ({ ts, date, hour, ip: t.ip, label: t.label, ...r }))
    )
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dayFile = path.join(DATA_DIR, `${date}.json`);
  let arr = [];
  if (fs.existsSync(dayFile)) {
    try { arr = JSON.parse(fs.readFileSync(dayFile, 'utf8')); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }
  // `ip` field from pingHost duplicates target ip; keep the config order fields first.
  for (const r of results) {
    arr.push({
      ts: r.ts, date: r.date, hour: r.hour,
      ip: r.ip, label: r.label,
      sent: r.sent, recv: r.recv, loss_pct: r.loss_pct,
      rtt_min: r.rtt_min, rtt_avg: r.rtt_avg, rtt_max: r.rtt_max,
      ok: r.ok,
    });
  }
  atomicWriteJSON(dayFile, arr);

  const up = results.filter((r) => r.ok).length;
  const method = (config.method || 'icmp').toLowerCase();
  console.log(`[collect] ${ts} - ${results.length} targets, ${up} up (method=${method}) -> ${path.basename(dayFile)} (${arr.length} records)`);

  // Loud diagnostic: if NOTHING is reachable it's almost always an environment
  // problem (ICMP blocked/unprivileged, firewall egress), not real downtime.
  if (up === 0 && results.length > 0) {
    const sample = results.find((r) => r.err) || results[0];
    console.warn(`[collect] WARNING: 0/${results.length} targets up. Likely cause: ${sample.err}`);
    if (method === 'icmp') {
      console.warn('[collect] If the agent blocks ICMP, set "method": "tcp" (and optional "port") in config.json.');
    }
  }
}

main().catch((e) => { console.error('[collect] error', e); process.exit(1); });
