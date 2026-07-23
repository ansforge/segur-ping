'use strict';
// Frontend for the DSFR dashboard. Loads the manifest (data/index.json) — which
// lists every supervised URL with its latest curl result — plus the daily history
// files (data/<day>.json) for the selected range, then renders KPI cards, two
// time-series charts (response time; per-check availability) and a status table
// filterable by domain. Fully static — no framework/build step.

// Le manifeste et les fichiers journaliers sont reconstruits chaque minute par
// Jenkins et poussés dans git, mais le site Pages n'est redéployé que toutes les
// 2 h : il sert un snapshot figé. Pour que « Actualiser » affiche du quasi-live, on
// lit les JSON directement depuis le contenu brut de git (dernier commit, cache CDN
// ~5 min, CORS *). Pour un dev local, remplacer DATA_BASE par './data'.
const DATA_BASE = 'https://raw.githubusercontent.com/ansforge/segur-ping/main/docs/data';
function dataUrl(name) { return `${DATA_BASE}/${name}?t=${Date.now()}`; }

// Latest run of the Pages deploy workflow (api.github.com sends CORS: *, but is
// rate-limited to 60 req/h per IP for unauthenticated calls — fine on load/refresh).
const CI_RUNS_URL = 'https://api.github.com/repos/ansforge/segur-ping/actions/workflows/pages.yml/runs?per_page=1';

// DSFR-flavoured categorical palette (one colour per series).
const PALETTE = ['#000091', '#1D71B8', '#5A7700', '#965A00', '#D20050', '#6A6AF4', '#00A95F', '#8D533E'];
const RANGE_LABELS = { '24h': 'Dernières 24 heures', '7d': 'Derniers 7 jours', '30d': 'Derniers 30 jours' };
const AXIS = { grid: '#EEEFF7', text: '#898DA5', font: '12px Marianne, sans-serif' };

const state = {
  index: null, domain: 'all', range: '24h', chartUrlId: null,
  charts: { ms: null, checks: null }, dayCache: new Map(),
};

const $ = (s) => document.querySelector(s);

async function fetchJSON(url) {
  // `reload` bypasses the browser HTTP cache and sends `Cache-Control: no-cache`,
  // which compliant proxies honour by revalidating with the origin.
  const r = await fetch(url, { cache: 'reload' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadDay(day) {
  if (state.dayCache.has(day)) return state.dayCache.get(day);
  let data = [];
  try {
    data = await fetchJSON(dataUrl(`${day}.json`));
  } catch (err) {
    console.warn('jour indisponible', day, err.message);
    data = [];
  }
  if (!Array.isArray(data)) data = [];
  state.dayCache.set(day, data);
  return data;
}

// ---- formatting helpers (French) ----------------------------------------
const nf = new Intl.NumberFormat('fr-FR');
function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function targetColor(i) { return PALETTE[i % PALETTE.length]; }

// ---- classification ------------------------------------------------------
// When the healthcheck body exposes an overall `health`, it wins over the HTTP
// code (a 200 with health=DOWN is still a problem).
function bucketOf(u) {
  if (u.http_code == null) return u.ts ? 'down' : 'unknown';
  if (u.health === 'DOWN') return 'problem';
  if (u.health === 'UP') return 'ok';
  if (u.http_code >= 400) return 'problem';
  return 'ok';
}

function statusBadge(u) {
  const c = u.http_code;
  if (c == null) {
    if (!u.ts) return '<span class="badge unknown">Inconnu</span>';
    return '<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>Injoignable</span>';
  }
  if (u.health === 'DOWN') return '<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>Dégradé</span>';
  if (u.health === 'UP') return '<span class="badge up"><span class="fr-icon-checkbox-circle-line" style="font-size:14px;"></span>En ligne</span>';
  if (c >= 400) return `<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>HTTP ${c}</span>`;
  if (c >= 300) return `<span class="badge warn"><span class="fr-icon-arrow-right-line" style="font-size:14px;"></span>Redirection</span>`;
  return '<span class="badge up"><span class="fr-icon-checkbox-circle-line" style="font-size:14px;"></span>En ligne</span>';
}

// Render each healthcheck sub-check as a coloured chip (UP green / DOWN red).
function renderChecks(checks) {
  if (!checks || !Object.keys(checks).length) return '<span class="muted">—</span>';
  const chips = Object.entries(checks).map(([k, v]) => {
    const val = String(v == null ? '' : v).toUpperCase();
    const cls = val === 'UP' ? 'up' : (val === 'DOWN' ? 'down' : 'unknown');
    return `<span class="chip ${cls}" title="${escapeHtml(k)} : ${escapeHtml(val || '—')}">${escapeHtml(k)}</span>`;
  }).join('');
  return `<div class="chips">${chips}</div>`;
}

// ---- history / series ----------------------------------------------------
function rangeDays() {
  const all = state.index.days || [];
  let n = 30;
  if (state.range === '24h') n = 2;
  else if (state.range === '7d') n = 7;
  return all.slice(-n);
}
function windowMs() {
  if (state.range === '24h') return 864e5;
  if (state.range === '7d') return 6048e5;
  return 2592e6;
}
async function historyRows() {
  const chunks = await Promise.all(rangeDays().map(loadDay));
  const cutoff = Date.now() - windowMs();
  return chunks.flat().filter((r) => Date.parse(r.ts) >= cutoff);
}
const inDomain = (u) => state.domain === 'all' || u.domain === state.domain;
const toBin = (v) => (v == null ? null : (String(v).toUpperCase() === 'UP' ? 1 : 0));

// Response-time dataset: one line per URL of the current domain filter.
function msDataset(rows) {
  const urls = (state.index.urls || []).filter(inDomain);
  const ids = new Set(urls.map((u) => u.id));
  const perTs = new Map();
  for (const r of rows) {
    if (!ids.has(r.id)) continue;
    const x = Math.floor(Date.parse(r.ts) / 1000);
    if (!perTs.has(x)) perTs.set(x, {});
    perTs.get(x)[r.id] = r.ms;
  }
  const xs = [...perTs.keys()].sort((a, b) => a - b);
  const series = urls.map((u) => xs.map((x) => {
    const v = perTs.get(x)[u.id];
    return v == null ? null : v;
  }));
  return { data: [xs, ...series], urls };
}

// Checks dataset for one URL: overall health + each sub-check as a 1/0 step line.
function checksDataset(rows, urlId) {
  const mine = rows.filter((r) => r.id === urlId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const xs = mine.map((r) => Math.floor(Date.parse(r.ts) / 1000));
  const names = [];
  for (const r of mine) if (r.checks) for (const k of Object.keys(r.checks)) if (!names.includes(k)) names.push(k);
  const globalSeries = mine.map((r) => toBin(r.health));
  const checkSeries = names.map((n) => mine.map((r) => (r.checks ? toBin(r.checks[n]) : null)));
  return { data: [xs, globalSeries, ...checkSeries], labels: ['Global', ...names] };
}

// ---- chart rendering -----------------------------------------------------
function axisX() {
  return { stroke: AXIS.text, font: AXIS.font, grid: { stroke: AXIS.grid, width: 1 }, ticks: { stroke: AXIS.grid } };
}
function axisY(label) {
  return {
    stroke: AXIS.text, font: AXIS.font, grid: { stroke: AXIS.grid, width: 1 }, ticks: { stroke: AXIS.grid },
    label: label || undefined, labelFont: '12px Marianne, sans-serif', labelSize: 30,
  };
}
function renderLegend(sel, items) {
  $(sel).innerHTML = items.map((it) => `
    <span style="display:inline-flex; align-items:center; gap:8px; font-size:13px; color:#50546D;">
      <span style="display:inline-block; width:18px; height:3px; border-radius:2px; background:${it.color};"></span>${escapeHtml(it.label)}
    </span>`).join('');
}

function makeMsChart(el, data, urls) {
  el.innerHTML = '';
  const width = Math.max(el.clientWidth || 900, 320);
  const series = [{}].concat(urls.map((u, i) => ({
    label: u.label || u.url, stroke: targetColor(i), width: 2, spanGaps: false,
    points: { show: false }, value: (up, v) => (v == null ? '—' : `${nf.format(Math.round(v))} ms`),
  })));
  const opts = { width, height: 300, legend: { show: false }, scales: { x: { time: true } }, axes: [axisX(), axisY('ms')], series };
  if (state.charts.ms) state.charts.ms.destroy();
  // eslint-disable-next-line new-cap
  state.charts.ms = new uPlot(opts, data, el);
  renderLegend('#legendMs', urls.map((u, i) => ({ label: u.label || u.url, color: targetColor(i) })));
}

function makeChecksChart(el, data, labels) {
  el.innerHTML = '';
  const width = Math.max(el.clientWidth || 900, 320);
  // eslint-disable-next-line new-cap
  const stepped = uPlot.paths.stepped({ align: 1 });
  const series = [{}].concat(labels.map((lab, i) => ({
    label: lab, stroke: targetColor(i), width: 2, spanGaps: false, points: { show: false },
    paths: stepped, value: (up, v) => (v == null ? '—' : (v === 1 ? 'UP' : 'DOWN')),
  })));
  const opts = {
    width, height: 260, legend: { show: false },
    scales: { x: { time: true }, y: { range: [-0.15, 1.15] } },
    axes: [
      axisX(),
      { ...axisY(''), splits: () => [0, 1], values: (u, vals) => vals.map((v) => (v === 1 ? 'UP' : (v === 0 ? 'DOWN' : ''))) },
    ],
    series,
  };
  if (state.charts.checks) state.charts.checks.destroy();
  // eslint-disable-next-line new-cap
  state.charts.checks = new uPlot(opts, data, el);
  renderLegend('#legendChecks', labels.map((lab, i) => ({ label: lab, color: targetColor(i) })));
}

async function renderCharts() {
  $('#rangeLabelMs').textContent = RANGE_LABELS[state.range];
  const rows = await historyRows();

  const ms = msDataset(rows);
  makeMsChart($('#chartMs'), ms.data, ms.urls);

  const u = (state.index.urls || []).find((x) => x.id === state.chartUrlId);
  $('#chartChecksLabel').textContent = u ? (u.label || u.url) : '';
  const ck = checksDataset(rows, state.chartUrlId);
  makeChecksChart($('#chartChecks'), ck.data, ck.labels);

  $('#chartfoot').textContent = `${nf.format(rows.length)} mesures sur la période · ${RANGE_LABELS[state.range]}.`;
}

// ---- KPI / table / dropdowns ---------------------------------------------
async function renderCiBadge() {
  const el = $('#ciBadge');
  if (!el) return;
  const set = (cls, icon, text, title) => {
    el.className = `badge ${cls}`;
    el.innerHTML = `<span class="${icon}" style="font-size:14px;"></span>${text}`;
    el.title = title;
  };
  try {
    const d = await fetchJSON(`${CI_RUNS_URL}&t=${Date.now()}`);
    const run = (d.workflow_runs || [])[0];
    if (!run) throw new Error('aucun run');
    el.href = run.html_url;
    const when = relTime(run.updated_at || run.created_at);
    if (run.status !== 'completed') {
      set('unknown', 'fr-icon-refresh-line', 'Déploiement en cours', `Déploiement ${run.status} · ${when}`);
    } else if (run.conclusion === 'success') {
      set('up', 'fr-icon-checkbox-circle-line', 'Déploiement OK', `Dernier déploiement réussi · ${when}`);
    } else {
      set('down', 'fr-icon-error-warning-line', 'Déploiement en échec', `Dernier déploiement : ${run.conclusion} · ${when}`);
    }
  } catch (err) {
    set('unknown', 'fr-icon-information-line', 'Statut indisponible', `Statut CI indisponible : ${err.message}`);
    console.warn('CI badge', err.message);
  }
}

function renderKpis() {
  const urls = state.index.urls || [];
  const total = urls.length;
  const counts = { ok: 0, problem: 0, down: 0, unknown: 0 };
  for (const u of urls) counts[bucketOf(u)]++;

  const kpis = [
    { label: 'URLs supervisées', value: nf.format(total), unit: '', note: `${state.index.domains ? state.index.domains.length : 0} domaine(s)` },
    { label: 'En ligne', value: nf.format(counts.ok), unit: '', note: 'santé UP / 2xx-3xx' },
    { label: 'En échec / dégradé', value: nf.format(counts.problem), unit: '', note: 'santé DOWN / 4xx-5xx' },
    { label: 'Injoignables', value: nf.format(counts.down), unit: '', note: 'aucune réponse (DNS/TLS/timeout)' },
  ];

  $('#kpis').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div style="display:flex; align-items:baseline; gap:6px; margin-top:8px;">
        <span class="kpi-value">${k.value}</span>
        <span class="kpi-unit">${k.unit}</span>
      </div>
      <div class="kpi-note">${k.note}</div>
    </div>`).join('');
}

function populateDomains() {
  const sel = $('#domain');
  const domains = state.index.domains || [];
  const total = (state.index.urls || []).length;
  const opts = [`<option value="all">Tous les domaines (${total})</option>`];
  for (const d of domains) {
    const n = (state.index.urls || []).filter((u) => u.domain === d).length;
    opts.push(`<option value="${escapeHtml(d)}">${escapeHtml(d)} (${n})</option>`);
  }
  sel.innerHTML = opts.join('');
  if (state.domain !== 'all' && !domains.includes(state.domain)) state.domain = 'all';
  sel.value = state.domain;
}

function populateChartUrls() {
  const sel = $('#chartUrl');
  const urls = (state.index.urls || []).filter(inDomain);
  sel.innerHTML = urls.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.label || u.url)}</option>`).join('');
  if (!urls.find((u) => u.id === state.chartUrlId)) state.chartUrlId = urls[0] ? urls[0].id : null;
  if (state.chartUrlId) sel.value = state.chartUrlId;
}

function renderTable() {
  const all = state.index.urls || [];
  const urls = state.domain === 'all' ? all : all.filter((u) => u.domain === state.domain);

  const rows = urls.map((u) => {
    const bucket = bucketOf(u);
    const rowBg = (bucket === 'problem' || bucket === 'down') ? 'background:#FEF1F6;' : '';
    let codeColor = '#343852';
    if (u.http_code == null) codeColor = '#6C7089';
    else if (u.http_code >= 400) codeColor = '#B1001E';
    else if (u.http_code >= 300) codeColor = '#965A00';
    return `
      <tr style="${rowBg}">
        <td class="l" style="font-weight:500; color:#343852;">${escapeHtml(u.label)}</td>
        <td class="l mono muted"><a href="${escapeHtml(u.url)}" target="_blank" rel="noopener" style="color:#1D71B8; text-decoration:none;">${escapeHtml(u.url)}</a></td>
        <td class="l mono muted">${escapeHtml(u.domain)}</td>
        <td class="l">${statusBadge(u)}</td>
        <td class="r num" style="color:${codeColor}; font-weight:500;">${u.http_code == null ? '—' : u.http_code}</td>
        <td class="l">${renderChecks(u.checks)}</td>
        <td class="r num muted">${u.ms == null ? '—' : `${nf.format(u.ms)} ms`}</td>
        <td class="r muted">${relTime(u.ts)}</td>
      </tr>`;
  }).join('');

  $('#rows').innerHTML = rows || '<tr><td class="l muted" colspan="8" style="padding:20px 14px;">Aucune URL pour ce domaine.</td></tr>';
  const label = state.domain === 'all' ? 'tous domaines' : state.domain;
  $('#filterCount').textContent = `${nf.format(urls.length)} URL(s) · ${label}`;
}

async function main() {
  renderCiBadge(); // independent of the data fetch — fire and forget
  try {
    state.index = await fetchJSON(dataUrl('index.json'));
  } catch (err) {
    $('#chartfoot').textContent = 'Aucune donnée disponible (data/index.json introuvable).';
    console.error(err);
    return;
  }
  const gen = state.index.generatedAt
    ? new Date(state.index.generatedAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
    : '—';
  $('#generated').textContent = `Généré le ${gen} · fuseau ${state.index.timezone || 'UTC'}`;

  try {
    renderKpis();
    populateDomains();
    populateChartUrls();
    renderTable();
    await renderCharts();
  } catch (err) {
    $('#chartfoot').textContent = `Erreur de rendu : ${err.message}`;
    console.error(err);
  }
}

// ---- bootstrap ----------------------------------------------------------
$('#domain').addEventListener('change', (e) => { state.domain = e.target.value; renderTable(); populateChartUrls(); renderCharts(); });
$('#range').addEventListener('change', (e) => { state.range = e.target.value; renderCharts(); });
$('#chartUrl').addEventListener('change', (e) => { state.chartUrlId = e.target.value; renderCharts(); });
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.innerHTML = '<span class="fr-icon-refresh-line" style="font-size:14px;"></span>Actualisation…';
  state.dayCache.clear();
  try {
    await main();
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.innerHTML = prev;
  }
});
window.addEventListener('resize', () => { if (state.index) renderCharts(); });

main();
