'use strict';
// Cross-platform ICMP ping wrapper with no external dependencies.
// Spawns the system `ping` binary and parses individual reply times, which is
// robust across OSes and locales (English "time=" / French "temps="), then
// computes min/avg/max and packet loss ourselves.

const { spawn } = require('child_process');
const os = require('os');

const isWindows = os.platform() === 'win32';

// Matches "time=12.3 ms", "time<1ms", "temps=12 ms", "temps<1 ms"
const REPLY_RE = /(?:time|temps)\s*[<=]\s*([\d.,]+)\s*ms/gi;

function buildArgs(ip, packets, timeoutSec) {
  if (isWindows) {
    // -n count, -w per-reply timeout in ms
    return ['-n', String(packets), '-w', String(timeoutSec * 1000), ip];
  }
  // Linux/iputils: -c count, -W per-reply timeout in seconds,
  // -w overall deadline so a dead host cannot hang the minute.
  const deadline = Math.max(timeoutSec * packets + 1, packets + 1);
  return ['-c', String(packets), '-W', String(timeoutSec), '-w', String(deadline), ip];
}

/**
 * Ping one host.
 * @returns {Promise<{ip,sent,recv,loss_pct,rtt_min,rtt_avg,rtt_max,ok}>}
 */
function pingHost(ip, packets = 4, timeoutSec = 2) {
  return new Promise((resolve) => {
    const args = buildArgs(ip, packets, timeoutSec);
    const child = spawn('ping', args, { windowsHide: true });

    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    // Hard safety timeout in case the process never exits.
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
    }, (timeoutSec * packets + 5) * 1000);

    const finish = () => {
      clearTimeout(killTimer);
      const times = [];
      let m;
      REPLY_RE.lastIndex = 0;
      while ((m = REPLY_RE.exec(out)) !== null) {
        times.push(parseFloat(m[1].replace(',', '.')));
      }
      const recv = times.length;
      const sent = packets;
      const loss_pct = sent > 0 ? Math.round(((sent - recv) / sent) * 1000) / 10 : 100;
      const round = (n) => Math.round(n * 100) / 100;
      resolve({
        ip,
        sent,
        recv,
        loss_pct,
        rtt_min: recv ? round(Math.min(...times)) : null,
        rtt_avg: recv ? round(times.reduce((a, b) => a + b, 0) / recv) : null,
        rtt_max: recv ? round(Math.max(...times)) : null,
        ok: recv > 0,
      });
    };

    child.on('close', finish);
    child.on('error', () => finish()); // ping binary missing -> recv 0, ok false
  });
}

module.exports = { pingHost };

// CLI: `node scripts/ping.js 8.8.8.8 [packets] [timeoutSec]`
if (require.main === module) {
  const ip = process.argv[2] || '8.8.8.8';
  const packets = parseInt(process.argv[3], 10) || 4;
  const timeoutSec = parseInt(process.argv[4], 10) || 2;
  pingHost(ip, packets, timeoutSec).then((r) => {
    console.log(JSON.stringify(r, null, 2));
  });
}
