# segur-ping

Continuous **network availability & latency monitoring** for audit purposes.
Pings a list of IPs every minute, stores results as one JSON file per day, and
publishes a chart + light summary table to **GitHub Pages** every 2 hours (or
manually) — the per-minute collection is orchestrated by a **self-hosted
Jenkins** pipeline (so the expensive part consumes no GitHub Actions quota).
A single lightweight Actions workflow only deploys the site (~12 short runs/day).

## What it measures

Per target, every minute (`packets` ICMP echoes, default 4):

| Field | Meaning |
|---|---|
| `ts`, `date`, `hour` | Local timestamp (Europe/Paris), date and hour |
| `ip`, `label` | Target |
| `sent`, `recv`, `loss_pct` | Packets sent/received, packet loss % |
| `rtt_min/avg/max` | Round-trip time in ms (`null` if unreachable) |
| `ok` | `true` if at least one reply came back |

Data lives in `docs/data/YYYY-MM-DD.json` (kept forever — this is the audit
record). The dashboard reads `docs/data/index.json` (a manifest + rolling 24h
summary) plus the daily files for the selected range.

## Layout

```
config.json          targets, packet count, timeout, timezone
scripts/ping.js      spawn system ping, parse RTT + loss (locale-proof)
scripts/collect.js   ping all targets, append to today's daily JSON
scripts/build-site.js  rebuild docs/data/index.json (manifest + summaries)
docs/                GitHub Pages root (index.html, app.js, vendor/uPlot.*)
Jenkinsfile          single minute-cron job on the bookwormjdk17 agent
Dockerfile           OPTIONAL — local-dev container only; NOT used by Jenkins
```

The Jenkins agent (`bookwormjdk17`) already has **git + Node 18 + ping**, so the
pipeline runs the Node scripts directly on the agent — no Docker involved.

## Configure

Edit `config.json`:

```json
{
  "targets": [
    { "ip": "8.8.8.8", "label": "Google DNS" },
    { "ip": "10.0.0.5", "label": "Service X", "port": 8443 }
  ],
  "method": "icmp",
  "port": 443,
  "packets": 4,
  "timeoutSec": 2,
  "publishEveryHours": 2,
  "timezone": "Europe/Paris"
}
```

- **`method`**: `"icmp"` (system `ping`, needs ICMP privileges/egress) or
  `"tcp"` (measures the TCP handshake RTT — **no privileges, passes most
  firewalls**). Use `tcp` on locked-down agents where ICMP is blocked.
- **`port`**: default TCP port for `tcp` method; override per target with a
  `"port"` field. Ignored for `icmp`.

## Run locally (verification)

```bash
node scripts/ping.js 8.8.8.8      # sanity-check the parser
node scripts/collect.js           # append one batch to docs/data/<today>.json
node scripts/build-site.js        # (re)build docs/data/index.json
# serve the dashboard:
cd docs && python -m http.server 8080   # open http://localhost:8080
```

## One-time Jenkins / GitHub setup

1. **GitHub Pages**: the workflow `.github/workflows/pages.yml` auto-enables
   Pages (Actions source) on its first run via `configure-pages` with
   `enablement: true`. It deploys `docs/` on a **2-hourly schedule**, on manual
   *Run workflow*, and on pushes that change the site itself — but **not** on the
   per-minute `docs/data/**` commits (excluded via `!docs/data/**`), so the
   frequent data pushes never trigger a deploy.
   - If auto-enable is blocked by org policy, set it by hand once:
     *Settings → Pages → Source = **GitHub Actions*** and re-run the workflow.
2. **Jenkins job**: a **multibranch Pipeline** on `ansforge/segur-ping`, script
   path `Jenkinsfile` (already set up as `ANS/Transverse/Forge/ping-segur`).
   - The pipeline pins `agent { label 'bookwormjdk17' }` (git + Node 18 + ping).
   - It reuses the multibranch **GitHub App credential** for the push.
     The id is set at the top of the `Jenkinsfile` as `GIT_CRED_ID = 'ans-forge'`
     — change it there if branch indexing uses a different credential id.
   - No Docker and no extra secret required.

The `cron('* * * * *')` trigger inside the Jenkinsfile drives it: every minute it
pings, appends to the daily JSON, commits and pushes. The dashboard itself
refreshes on the 2-hourly Pages schedule.

> **If every target shows `down` / 100% loss** (as on a locked-down agent), ICMP
> is blocked for the jenkins user (privileges or firewall egress). Either grant
> unprivileged ping (`net.ipv4.ping_group_range` / `setcap` on the ping binary),
> or set **`"method": "tcp"`** in `config.json` — TCP handshake probing needs no
> privileges and passes most firewalls. The collector logs the exact reason when
> nothing is reachable.

## How it stays cheap & clean

- Data is committed + pushed **every minute** (near-real-time audit trail), but
  those commits only touch `docs/data/**`.
- The Pages **workflow ignores `docs/data/**`** and deploys on a **2h schedule**,
  so per-minute data pushes never trigger a deploy → Actions usage stays ~12/day.
- Build logs auto-rotate (`buildDiscarder`); the **audit data is in git history**.
- Chart library (uPlot) is **vendored** (works offline). The DSFR fonts/icons
  load from a CDN and degrade gracefully to system fonts if unreachable.

## Notes / limits

- **Commit volume**: per-minute pushing ≈ 1440 commits/day on `main`. That's the
  cost of near-real-time data; the history is the audit trail. (If that's too
  much, raise the cron interval or batch commits.)
- Missed minute: if a run exceeds 60s, `disableConcurrentBuilds` skips the next
  tick (visible as a gap in the chart). Probes run in parallel to keep runs fast.
- The dashboard reflects data as of the last 2-hourly Pages deploy, even though
  the underlying data in git is minute-fresh.
