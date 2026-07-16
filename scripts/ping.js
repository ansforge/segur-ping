'use strict';
// Reachability + latency probes with no external dependencies.
//
// Two methods:
//  - icmp: spawn the system `ping` binary and parse reply times (locale-proof:
//          English "time=" / French "temps="). Requires ICMP privileges/egress,
//          which are usually blocked for pods on managed Kubernetes.
//  - tcp : measure the TCP handshake RTT with the `net` module. No special
//          privileges and passes most firewalls — use it when ICMP is blocked.
//
// Each probe returns:
//   { ip, method, sent, recv, loss_pct, rtt_min, rtt_avg, rtt_max, ok, err,
//     cmd, code, raw }
// cmd/code/raw are diagnostics (command run, exit code, captured output).

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');

const isWindows = os.platform() === 'win32';
const REPLY_RE = /(?:time|temps)\s*[<=]\s*([\d.,]+)\s*ms/gi;
const round = (n) => Math.round(n * 100) / 100;
const clip = (s, n = 600) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);

function summarize(ip, method, sent, times, err, extra = {}) {
  const recv = times.length;
  const loss_pct = sent > 0 ? Math.round(((sent - recv) / sent) * 1000) / 10 : 100;
  return {
    ip,
    method,
    sent,
    recv,
    loss_pct,
    rtt_min: recv ? round(Math.min(...times)) : null,
    rtt_avg: recv ? round(times.reduce((a, b) => a + b, 0) / recv) : null,
    rtt_max: recv ? round(Math.max(...times)) : null,
    ok: recv > 0,
    err: recv ? null : (err || 'no reply / timeout'),
    ...extra,
  };
}

function icmpArgs(ip, packets, timeoutSec) {
  if (isWindows) return ['-n', String(packets), '-w', String(timeoutSec * 1000), ip];
  const deadline = Math.max(timeoutSec * packets + 1, packets + 1);
  return ['-c', String(packets), '-W', String(timeoutSec), '-w', String(deadline), ip];
}

function icmpPing(ip, packets, timeoutSec) {
  return new Promise((resolve) => {
    const args = icmpArgs(ip, packets, timeoutSec);
    const cmd = `ping ${args.join(' ')}`;
    const child = spawn('ping', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let spawnErr = null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const killTimer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } },
      (timeoutSec * packets + 5) * 1000);

    const finish = (code) => {
      clearTimeout(killTimer);
      const times = [];
      let m;
      REPLY_RE.lastIndex = 0;
      const text = `${stdout}\n${stderr}`;
      while ((m = REPLY_RE.exec(text)) !== null) times.push(parseFloat(m[1].replace(',', '.')));
      let err = null;
      if (!times.length) {
        if (spawnErr === 'ENOENT') err = "ICMP: 'ping' binary not found in the pod image";
        else if (/not permitted|permission/i.test(text)) err = 'ICMP: operation not permitted (no CAP_NET_RAW / ping_group_range) — use method "tcp"';
        else if (/unreachable|inaccessible/i.test(text)) err = 'ICMP: network/host unreachable';
        else if (spawnErr) err = `ICMP: spawn ${spawnErr}`;
        else err = 'ICMP: no reply — egress likely blocked (managed K8s drops ICMP) — use method "tcp"';
      }
      resolve(summarize(ip, 'icmp', packets, times, err, {
        cmd, code: code == null ? null : code, raw: clip(`${stdout}${stderr}`.trim()),
      }));
    };

    child.on('close', (code) => finish(code));
    child.on('error', (e) => { spawnErr = e.code || 'error'; finish(null); });
  });
}

// Single TCP connect attempt; resolves { ms, err } (ms=null on failure).
function tcpConnectOnce(ip, port, timeoutSec) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const sock = new net.Socket();
    let settled = false;
    const done = (ms, err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ms, err });
    };
    sock.setTimeout(timeoutSec * 1000);
    sock.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6, null));
    sock.once('timeout', () => done(null, 'timeout'));
    sock.once('error', (e) => done(null, e.code || 'error'));
    sock.connect(port, ip);
  });
}

async function tcpPing(ip, port, samples, timeoutSec) {
  const times = [];
  const errs = [];
  for (let i = 0; i < samples; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tcpConnectOnce(ip, port, timeoutSec);
    if (r.ms != null) times.push(round(r.ms)); else errs.push(r.err);
  }
  const err = times.length ? null : `TCP:${port} ${errs[0] || 'failed'}`;
  return summarize(ip, `tcp:${port}`, samples, times, err, {
    cmd: `tcp-connect ${ip}:${port} x${samples}`, code: null,
    raw: errs.length ? `errors: ${errs.join(',')}` : '',
  });
}

// Lightweight one-shot probe used for egress diagnostics.
async function tcpProbe(ip, port, timeoutSec = 2) {
  const r = await tcpConnectOnce(ip, port, timeoutSec);
  return { port, ok: r.ms != null, ms: r.ms != null ? round(r.ms) : null, err: r.err || null };
}

/**
 * Probe one target using the configured method.
 * @param {{ip:string, port?:number}} target
 * @param {{method?:string, packets?:number, timeoutSec?:number, port?:number}} cfg
 */
function measure(target, cfg = {}) {
  const packets = cfg.packets || 4;
  const timeoutSec = cfg.timeoutSec || 2;
  if ((cfg.method || 'icmp').toLowerCase() === 'tcp') {
    const port = target.port || cfg.port || 443;
    return tcpPing(target.ip, port, packets, timeoutSec);
  }
  return icmpPing(target.ip, packets, timeoutSec);
}

function pingHost(ip, packets = 4, timeoutSec = 2) {
  return icmpPing(ip, packets, timeoutSec);
}

module.exports = { measure, pingHost, icmpPing, tcpPing, tcpProbe };

// CLI: node scripts/ping.js <ip> [method] [port] [packets] [timeoutSec]
if (require.main === module) {
  const ip = process.argv[2] || '8.8.8.8';
  const method = process.argv[3] || 'icmp';
  const port = parseInt(process.argv[4], 10) || 443;
  const packets = parseInt(process.argv[5], 10) || 4;
  const timeoutSec = parseInt(process.argv[6], 10) || 2;
  measure({ ip, port }, { method, port, packets, timeoutSec })
    .then((r) => console.log(JSON.stringify(r, null, 2)));
}
