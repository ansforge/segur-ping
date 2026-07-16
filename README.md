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
scripts/is-publish-tick.js  exit 0 on a 2h publish boundary
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
    { "ip": "8.8.8.8", "label": "Google DNS" }
  ],
  "packets": 4,
  "timeoutSec": 2,
  "publishEveryHours": 2,
  "timezone": "Europe/Paris"
}
```

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
   `enablement: true`, then publishes `docs/` on every push touching `docs/**`
   (each 2h Jenkins publish) or on manual *Run workflow*.
   - If auto-enable is blocked by org policy, set it by hand once:
     *Settings → Pages → Source = **GitHub Actions*** and re-run the workflow.
   - This is the only Actions workflow — the per-minute pinging stays on Jenkins,
     so it uses no meaningful Actions quota (~12 short runs/day; unlimited for
     public repos).
2. **Jenkins job**: a **multibranch Pipeline** on `ansforge/segur-ping`, script
   path `Jenkinsfile` (already set up as `ANS/Transverse/Forge/ping-segur`).
   - The pipeline pins `agent { label 'bookwormjdk17' }` (git + Node 18 + ping).
   - It reuses the multibranch **GitHub App credential** for the publish push.
     The id is set at the top of the `Jenkinsfile` as `GIT_CRED_ID = 'ans-forge'`
     — change it there if branch indexing uses a different credential id.
   - No Docker and no extra secret required.

The `cron('* * * * *')` trigger inside the Jenkinsfile drives it from there.
Trigger a build manually with **PUBLISH_NOW = true** to force an immediate
publish.

> **ICMP note:** the scripts use the agent's `ping` binary. Debian bookworm
> normally allows unprivileged ping (`net.ipv4.ping_group_range`). If every
> target reports `down` with 100% loss, the agent is blocking ICMP for the
> jenkins user — grant it or run ping via a wrapper.

## How it stays cheap & clean

- One JSON append per minute on disk (persisted workspace) — **no commit spam**.
- Git commit + push only every 2 hours → ~12 commits/day.
- Build logs auto-rotate (`buildDiscarder`); the **audit data is in git history**,
  untouched.
- Chart library (uPlot) is **vendored** (works offline). The DSFR fonts/icons
  load from a CDN and degrade gracefully to system fonts if unreachable.

## Notes / limits

- Missed minute: if a run exceeds 60s, `disableConcurrentBuilds` skips the next
  tick (visible as a gap in the chart). Pings run in parallel to keep runs fast.
- Code changes to `scripts/`/`docs/` land in the running clone at the next
  publish (`git pull --rebase`); the `Jenkinsfile` itself refreshes every build.
- Data-at-risk if the Jenkins host dies = up to one publish window (~2h).
