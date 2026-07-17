'use strict';
// Curl every configured URL once (bounded concurrency), then write BOTH:
//  1. docs/data/http/<id>.json  — latest status snapshot per URL (overwritten),
//     read by build-site.js to render the table.
//  2. docs/data/<day>.json      — appended time-series (one row per URL per run),
//     read by the frontend to plot values over time.
// Runs every minute from Jenkins.
//
// We shell out to the real `curl` binary on purpose: it honours the pod's
// HTTP(S)_PROXY env vars and the system CA trust store (into which the IGC Santé
// CAs are injected), which a bare Node fetch would not without extra config.
//
// Snapshot record: { id, url, label, domain, ts, http_code, ms, ok, err, health, checks }
// History row (compact): { ts, id, http_code, ms, health, checks }
// http_code is null when curl couldn't get any response (DNS/TLS/timeout).
// ok = curl succeeded AND 200 <= http_code < 400.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, ROOT } = require('./http-targets');

const DATA_DIR = path.join(ROOT, 'docs', 'data');
const HTTP_DIR = path.join(DATA_DIR, 'http');

function atomicWriteJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // Node's rename overwrites the target on all platforms
}

// Current instant in a given IANA timezone -> { ts (ISO with offset), date }.
// `date` names the daily history file; `ts` is the plotted timestamp.
function nowInTz(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(now).find((p) => p.type === 'timeZoneName');
  let offset = '+00:00';
  if (tzName && /GMT([+-]\d{2}:\d{2})/.test(tzName.value)) {
    offset = tzName.value.match(/GMT([+-]\d{2}:\d{2})/)[1];
  }
  const hour24 = parts.hour === '24' ? '00' : parts.hour; // guard Intl edge case
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { ts: `${date}T${hour24}:${parts.minute}:${parts.second}${offset}`, date };
}

// Append this run's rows to the daily history file (atomic read-modify-write).
function appendHistory(date, rows) {
  const dayFile = path.join(DATA_DIR, `${date}.json`);
  let arr = [];
  if (fs.existsSync(dayFile)) {
    try { arr = JSON.parse(fs.readFileSync(dayFile, 'utf8')); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }
  arr.push(...rows);
  atomicWriteJSON(dayFile, arr);
  return arr.length;
}

// Parse a healthcheck-style JSON body into an overall `health` (the top-level
// `status`) and a flat `checks` map (name -> "UP"/"DOWN"). Returns nulls when the
// body isn't such JSON, so plain URLs (no healthcheck) still work.
//   { "status": "DOWN", "checks": { "LISTEBLANCHE": "DOWN", "WADO-RS": "UP" } }
function parseHealth(body) {
  try {
    const j = JSON.parse(body);
    if (!j || typeof j !== 'object') return { health: null, checks: null };
    const health = typeof j.status === 'string' ? j.status.toUpperCase() : null;
    let checks = null;
    if (j.checks && typeof j.checks === 'object' && !Array.isArray(j.checks)) {
      checks = {};
      for (const [k, v] of Object.entries(j.checks)) {
        // Accept both "UP" and { status: "UP", ... } shapes.
        const s = typeof v === 'string' ? v : (v && v.status);
        checks[k] = s != null ? String(s).toUpperCase() : null;
      }
    }
    return { health, checks };
  } catch (_) {
    return { health: null, checks: null };
  }
}

// One curl. We keep the body (no -o) and append "\n<http_code> <time_total>" via
// -w, so a single call yields the healthcheck JSON body AND the status/timing.
// Redirects are NOT followed by default so a 301/302 is reported as-is (set
// followRedirects in urls.json to change that).
function curlStatus(url, cfg) {
  return new Promise((resolve) => {
    const timeout = String(cfg.timeoutSec || 10);
    const args = [
      '-sS', '-w', '\n%{http_code} %{time_total}',
      '--connect-timeout', timeout, '--max-time', timeout,
    ];
    if (cfg.followRedirects) args.push('-L');
    args.push(url);

    const child = spawn('curl', args, { windowsHide: true });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (e) => resolve({
      http_code: null, ms: null, ok: false, health: null, checks: null,
      err: e.code === 'ENOENT' ? "'curl' binary not found in the pod image" : `curl spawn ${e.code || e.message}`,
    }));
    child.on('close', (code) => {
      // The -w metrics are on the final line; everything before it is the body.
      const text = out.replace(/\r/g, '');
      const nl = text.lastIndexOf('\n');
      const statusLine = (nl >= 0 ? text.slice(nl + 1) : text).trim();
      const body = nl >= 0 ? text.slice(0, nl) : '';
      const m = statusLine.match(/(\d{3})\s+([\d.]+)/);
      // curl prints "000 0.000" on failure; treat 000 as no response.
      const rawCode = m ? parseInt(m[1], 10) : null;
      const httpCode = rawCode && rawCode !== 0 ? rawCode : null;
      const ms = m && parseFloat(m[2]) > 0 ? Math.round(parseFloat(m[2]) * 1000) : null;
      const { health, checks } = parseHealth(body);
      if (code === 0 && httpCode != null) {
        resolve({
          http_code: httpCode, ms, health, checks,
          ok: httpCode >= 200 && httpCode < 400,
          err: httpCode >= 400 ? `HTTP ${httpCode}` : null,
        });
      } else {
        resolve({
          http_code: httpCode, ms, health, checks, ok: false,
          err: (errOut.trim().split('\n').pop() || `curl exit ${code}`).slice(0, 200),
        });
      }
    });
  });
}

// Bounded-concurrency map: at most `size` curls in flight at once.
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function main() {
  const cfg = loadConfig();
  const { ts, date } = nowInTz(cfg.timezone);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
  console.log(`[collect-http] start ${ts} | node ${process.version} on ${os.platform()}/${os.arch()} | host ${os.hostname()} | uid ${uid}`);
  console.log(`[collect-http] urls=${cfg.urls.length} concurrency=${cfg.concurrency} timeout=${cfg.timeoutSec}s followRedirects=${cfg.followRedirects}`);

  fs.mkdirSync(HTTP_DIR, { recursive: true });

  let ok = 0;
  let httpErr = 0;
  let unreachable = 0;
  const recs = await pool(cfg.urls, cfg.concurrency, async (t) => {
    const r = await curlStatus(t.url, cfg);
    const rec = {
      id: t.id, url: t.url, label: t.label, domain: t.domain,
      ts, http_code: r.http_code, ms: r.ms, ok: r.ok, err: r.err,
      health: r.health, checks: r.checks,
    };
    // 1. Latest snapshot (overwritten) — feeds the table.
    atomicWriteJSON(path.join(HTTP_DIR, `${t.id}.json`), rec);
    if (r.ok) ok++;
    else if (r.http_code != null) httpErr++;
    else unreachable++;
    return rec;
  });

  // 2. Append compact rows to today's history file — feeds the time-series chart.
  const rows = recs.map((r) => ({
    ts, id: r.id, http_code: r.http_code, ms: r.ms, health: r.health, checks: r.checks,
  }));
  const total = appendHistory(date, rows);

  console.log(`[collect-http] done ${ts} - ${ok} ok / ${httpErr} http-error / ${unreachable} unreachable over ${cfg.urls.length} -> ${date}.json (${total} rows)`);
  if (ok === 0 && cfg.urls.length > 0) {
    console.warn('[collect-http] WARNING: 0 URLs OK. Likely egress/proxy or CA trust issue.');
    console.warn('[collect-http] Check HTTP(S)_PROXY env and that curl trusts the target CAs in this pod.');
  }
}

main().catch((e) => { console.error('[collect-http] error', e); process.exit(1); });
