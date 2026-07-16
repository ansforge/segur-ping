'use strict';
// Reachability + latency probes with no external dependencies.
//
// Two methods:
//  - icmp: spawn the system `ping` binary and parse reply times (locale-proof:
//          English "time=" / French "temps="). Requires ICMP privileges/egress,
//          which are often blocked on locked-down CI agents.
//  - tcp : measure the TCP handshake RTT with the `net` module. No special
//          privileges and passes most firewalls — use it when ICMP is blocked.
//
// Both return the same shape:
//   { ip, method, sent, recv, loss_pct, rtt_min, rtt_avg, rtt_max, ok, err }
// `err` is set (a short reason) only when nothing came back, to aid diagnosis.

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');

const isWindows = os.platform() === 'win32';
const REPLY_RE = /(?:time|temps)\s*[<=]\s*([\d.,]+)\s*ms/gi;
const round = (n) => Math.round(n * 100) / 100;

function summarize(ip, method, sent, times, err) {
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
  };
}

function icmpArgs(ip, packets, timeoutSec) {
  if (isWindows) return ['-n', String(packets), '-w', String(timeoutSec * 1000), ip];
  const deadline = Math.max(timeoutSec * packets + 1, packets + 1);
  return ['-c', String(packets), '-W', String(timeoutSec), '-w', String(deadline), ip];
}

function icmpPing(ip, packets, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn('ping', icmpArgs(ip, packets, timeoutSec), { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let spawnErr = null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const killTimer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } },
      (timeoutSec * packets + 5) * 1000);

    const finish = () => {
      clearTimeout(killTimer);
      const times = [];
      let m;
      REPLY_RE.lastIndex = 0;
      const text = `${stdout}\n${stderr}`;
      while ((m = REPLY_RE.exec(text)) !== null) times.push(parseFloat(m[1].replace(',', '.')));
      // Build a helpful reason when nothing came back.
      let err = null;
      if (!times.length) {
        if (spawnErr === 'ENOENT') err = "ICMP: 'ping' binary not found on agent";
        else if (/not permitted|permission/i.test(text)) err = 'ICMP: operation not permitted (privileges) — try method "tcp"';
        else if (/unreachable|inaccessible/i.test(text)) err = 'ICMP: network/host unreachable';
        else err = (stderr.trim().split('\n')[0] || 'ICMP: no reply / blocked (firewall?) — try method "tcp"');
      }
      resolve(summarize(ip, 'icmp', packets, times, err));
    };

    child.on('close', finish);
    child.on('error', (e) => { spawnErr = e.code || 'spawn error'; finish(); });
  });
}

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
  let lastErr = null;
  for (let i = 0; i < samples; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tcpConnectOnce(ip, port, timeoutSec);
    if (r.ms != null) times.push(round(r.ms)); else lastErr = r.err;
  }
  const err = times.length ? null : `TCP:${port} ${lastErr || 'failed'}`;
  return summarize(ip, `tcp:${port}`, samples, times, err);
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

// Back-compat helper.
function pingHost(ip, packets = 4, timeoutSec = 2) {
  return icmpPing(ip, packets, timeoutSec);
}

module.exports = { measure, pingHost, icmpPing, tcpPing };

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
