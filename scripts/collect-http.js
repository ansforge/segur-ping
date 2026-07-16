'use strict';
// Curl every configured URL once (bounded concurrency) and write ONE JSON file
// per URL under docs/data/http/<id>.json, overwritten each run (latest status
// snapshot — no time-series). Runs every minute from Jenkins.
//
// We shell out to the real `curl` binary on purpose: it honours the pod's
// HTTP(S)_PROXY env vars and the system CA trust store (into which the IGC Santé
// CAs are injected), which a bare Node fetch would not without extra config.
//
// Per-URL record shape:
//   { id, url, label, domain, ts, http_code, ms, ok, err }
// http_code is null when curl couldn't get any response (DNS/TLS/timeout).
// ok = curl succeeded AND 200 <= http_code < 400.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, ROOT } = require('./http-targets');

const HTTP_DIR = path.join(ROOT, 'docs', 'data', 'http');

function atomicWriteJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // Node's rename overwrites the target on all platforms
}

// One curl. `-o /dev/null` discards the body; `-w` prints just the status code
// and total time so we don't have to parse HTTP output. Redirects are NOT
// followed by default so a 301/302 is reported as-is (set followRedirects in
// urls.json to change that).
function curlStatus(url, cfg) {
  return new Promise((resolve) => {
    const timeout = String(cfg.timeoutSec || 10);
    const args = [
      '-sS', '-o', os.platform() === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{time_total}',
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
      http_code: null, ms: null, ok: false,
      err: e.code === 'ENOENT' ? "'curl' binary not found in the pod image" : `curl spawn ${e.code || e.message}`,
    }));
    child.on('close', (code) => {
      const m = out.trim().match(/(\d{3})\s+([\d.]+)/);
      // curl prints "000 0.000" on failure; treat 000 as no response.
      const rawCode = m ? parseInt(m[1], 10) : null;
      const httpCode = rawCode && rawCode !== 0 ? rawCode : null;
      const ms = m && parseFloat(m[2]) > 0 ? Math.round(parseFloat(m[2]) * 1000) : null;
      if (code === 0 && httpCode != null) {
        resolve({
          http_code: httpCode, ms,
          ok: httpCode >= 200 && httpCode < 400,
          err: httpCode >= 400 ? `HTTP ${httpCode}` : null,
        });
      } else {
        resolve({
          http_code: httpCode, ms, ok: false,
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
  const ts = new Date().toISOString();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
  console.log(`[collect-http] start ${ts} | node ${process.version} on ${os.platform()}/${os.arch()} | host ${os.hostname()} | uid ${uid}`);
  console.log(`[collect-http] urls=${cfg.urls.length} concurrency=${cfg.concurrency} timeout=${cfg.timeoutSec}s followRedirects=${cfg.followRedirects}`);

  fs.mkdirSync(HTTP_DIR, { recursive: true });

  let ok = 0;
  let httpErr = 0;
  let unreachable = 0;
  await pool(cfg.urls, cfg.concurrency, async (t) => {
    const r = await curlStatus(t.url, cfg);
    const rec = {
      id: t.id, url: t.url, label: t.label, domain: t.domain,
      ts, http_code: r.http_code, ms: r.ms, ok: r.ok, err: r.err,
    };
    atomicWriteJSON(path.join(HTTP_DIR, `${t.id}.json`), rec);
    if (r.ok) ok++;
    else if (r.http_code != null) httpErr++;
    else unreachable++;
    return rec;
  });

  console.log(`[collect-http] done ${ts} - ${ok} ok / ${httpErr} http-error / ${unreachable} unreachable over ${cfg.urls.length}`);
  if (ok === 0 && cfg.urls.length > 0) {
    console.warn('[collect-http] WARNING: 0 URLs OK. Likely egress/proxy or CA trust issue.');
    console.warn('[collect-http] Check HTTP(S)_PROXY env and that curl trusts the target CAs in this pod.');
  }
}

main().catch((e) => { console.error('[collect-http] error', e); process.exit(1); });
