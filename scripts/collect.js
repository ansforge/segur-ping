'use strict';
// Ping every configured target once (in parallel) and append one record per
// target to today's daily JSON file under docs/data/. Runs every minute.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { measure, tcpProbe } = require('./ping');

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

// Probe common egress ports to a host so the log shows what actually works.
async function egressDiagnostic(ip, timeoutSec) {
  const ports = [443, 53, 80];
  console.warn(`[collect] egress diagnostic against ${ip} (TCP ${ports.join('/')}):`);
  for (const p of ports) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tcpProbe(ip, p, timeoutSec);
    console.warn(`[collect]   TCP:${p} -> ${r.ok ? `OK ${r.ms} ms` : `FAIL (${r.err})`}`);
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const tz = config.timezone || 'UTC';
  const method = (config.method || 'icmp').toLowerCase();
  const { ts, date, hour } = nowInTz(tz);

  // Environment banner — helps diagnose the dynamic-pod runtime.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
  console.log(`[collect] start ${ts} | node ${process.version} on ${os.platform()}/${os.arch()} | host ${os.hostname()} | uid ${uid}`);
  console.log(`[collect] method=${method} port=${config.port || 443} packets=${config.packets || 4} timeout=${config.timeoutSec || 2}s targets=${config.targets.length}`);

  const results = await Promise.all(
    config.targets.map((t) =>
      measure(t, config)
        .then((r) => ({ ts, date, hour, ip: t.ip, label: t.label, ...r }))
    )
  );

  // Per-target line, always. On failure, dump the command, exit code and raw output.
  for (const r of results) {
    if (r.ok) {
      console.log(`[collect]   UP   ${r.ip} (${r.label}) ${r.method} rtt_avg=${r.rtt_avg}ms loss=${r.loss_pct}% recv=${r.recv}/${r.sent}`);
    } else {
      console.warn(`[collect]   DOWN ${r.ip} (${r.label}) ${r.method} loss=${r.loss_pct}% err="${r.err}"`);
      console.warn(`[collect]        cmd: ${r.cmd}${r.code == null ? '' : ` (exit ${r.code})`}`);
      if (r.raw) console.warn(`[collect]        out: ${r.raw.replace(/\n/g, ' | ')}`);
    }
  }

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
  console.log(`[collect] done ${ts} - ${up}/${results.length} up (method=${method}) -> ${path.basename(dayFile)} (${arr.length} records)`);

  // If NOTHING is reachable it's almost always the environment (ICMP blocked/
  // unprivileged, no egress), not real downtime. Probe TCP egress so the log
  // shows exactly what this pod can reach, and how to fix the config.
  if (up === 0 && results.length > 0) {
    const sample = results.find((r) => r.err) || results[0];
    console.warn(`[collect] WARNING: 0/${results.length} targets up. First error: ${sample.err}`);
    await egressDiagnostic(sample.ip, config.timeoutSec || 2);
    if (method === 'icmp') {
      console.warn('[collect] ICMP is typically dropped for pods on managed Kubernetes.');
      console.warn('[collect] FIX: set "method":"tcp" in config.json. Use the port shown OK above');
      console.warn('[collect]      (443 works for Google/Cloudflare/OpenDNS; these resolvers also accept TCP:53).');
    } else {
      console.warn('[collect] Even TCP failed — this pod may have no direct internet egress');
      console.warn('[collect]      (egress firewall or HTTP-proxy-only). Check your cluster egress policy.');
    }
  }
}

main().catch((e) => { console.error('[collect] error', e); process.exit(1); });
