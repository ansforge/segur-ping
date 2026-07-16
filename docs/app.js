'use strict';
// Frontend for the DSFR dashboard. Loads the manifest (data/index.json) plus the
// daily JSON files needed for the selected range, then renders KPI cards, a uPlot
// time-series and the summary table. Fully static — no framework/build step.

// DSFR-flavoured categorical palette (one colour per target, in config order).
const PALETTE = ['#000091', '#1D71B8', '#5A7700', '#965A00', '#D20050', '#6A6AF4', '#00A95F', '#8D533E'];

const RANGE_LABELS = { '24h': 'Dernières 24 heures', '7d': 'Derniers 7 jours', '30d': 'Derniers 30 jours' };
const AXIS = { grid: '#EEEFF7', line: '#C1C5DC', text: '#898DA5', font: '12px Marianne, sans-serif' };

const state = { index: null, range: '24h', metric: 'rtt_avg', chart: null, dayCache: new Map() };

const $ = (s) => document.querySelector(s);

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadDay(day) {
  if (state.dayCache.has(day)) return state.dayCache.get(day);
  let data = [];
  try {
    data = await fetchJSON(`data/${day}.json`);
  } catch (err) {
    console.warn('jour indisponible', day, err.message);
    data = [];
  }
  state.dayCache.set(day, data);
  return data;
}

// ---- formatting helpers (French) ----------------------------------------
const nf = new Intl.NumberFormat('fr-FR');
function fr(v, d = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function withUnit(v, unit, d = 1) {
  return v == null ? '—' : `${fr(v, d)} ${unit}`;
}
function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

// ---- range / series -----------------------------------------------------
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

async function buildSeries() {
  const chunks = await Promise.all(rangeDays().map(loadDay));
  const all = chunks.flat();
  const cutoff = Date.now() - windowMs();
  const within = all.filter((r) => new Date(r.ts).getTime() >= cutoff);

  const targets = state.index.targets;
  const perTs = new Map(); // ts(sec) -> { ip: value }
  for (const rec of within) {
    const x = Math.floor(new Date(rec.ts).getTime() / 1000);
    if (!perTs.has(x)) perTs.set(x, {});
    perTs.get(x)[rec.ip] = rec[state.metric];
  }
  const xs = [...perTs.keys()].sort((a, b) => a - b);
  const series = targets.map((t) => xs.map((x) => {
    const v = perTs.get(x)[t.ip];
    return v == null ? null : v;
  }));
  return { data: [xs, ...series], count: within.length };
}

// ---- rendering ----------------------------------------------------------
function targetColor(i) { return PALETTE[i % PALETTE.length]; }

function renderKpis() {
  const targets = state.index.targets || [];
  const total = targets.length;
  const upList = targets.filter((t) => (t.last24h || {}).status === 'up');
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const rtts = upList.map((t) => t.last24h.avg_rtt).filter((v) => v != null);
  const uptimes = targets.map((t) => t.last24h && t.last24h.uptime_pct).filter((v) => v != null);
  const losses = targets.map((t) => t.last24h && t.last24h.loss_pct).filter((v) => v != null);

  const kpis = [
    { label: 'Cibles en ligne', value: `${upList.length}/${total}`, unit: '', note: `${total - upList.length} cible(s) hors ligne` },
    { label: 'Latence moyenne', value: fr(avg(rtts), 1), unit: 'ms', note: 'sur les cibles en ligne' },
    { label: 'Disponibilité globale', value: fr(avg(uptimes), 1), unit: '%', note: 'glissant sur 24 h' },
    { label: 'Perte de paquets', value: fr(avg(losses), 1), unit: '%', note: 'moyenne des cibles' },
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

function statusBadge(status) {
  if (status === 'up') return '<span class="badge up"><span class="fr-icon-checkbox-circle-line" style="font-size:14px;"></span>En ligne</span>';
  if (status === 'down') return '<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>Hors ligne</span>';
  return '<span class="badge unknown">Inconnu</span>';
}

function renderTable() {
  const rows = (state.index.targets || []).map((t, i) => {
    const s = t.last24h || {};
    let lossColor = '#50546D';
    if (s.loss_pct >= 5) lossColor = '#B1001E';
    else if (s.loss_pct >= 1) lossColor = '#965A00';
    let availColor = '#B1001E';
    if (s.uptime_pct >= 99) availColor = '#5A7700';
    else if (s.uptime_pct >= 95) availColor = '#965A00';
    const rowBg = s.status === 'down' ? 'background:#FEF1F6;' : '';
    return `
      <tr style="${rowBg}">
        <td class="l mono" style="font-weight:500; color:#343852;">
          <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${targetColor(i)}; margin-right:8px; vertical-align:middle;"></span>${t.label || ''}
        </td>
        <td class="l mono muted">${t.ip}</td>
        <td class="l">${statusBadge(s.status)}</td>
        <td class="r num">${withUnit(s.avg_rtt, 'ms')}</td>
        <td class="r num muted">${withUnit(s.min_rtt, 'ms')}</td>
        <td class="r num muted">${withUnit(s.max_rtt, 'ms')}</td>
        <td class="r num" style="color:${lossColor};">${withUnit(s.loss_pct, '%')}</td>
        <td class="r num" style="color:${availColor}; font-weight:500;">${withUnit(s.uptime_pct, '%')}</td>
        <td class="r num muted">${s.samples == null ? '—' : nf.format(s.samples)}</td>
        <td class="r muted">${relTime(s.lastSeen)}</td>
      </tr>`;
  }).join('');
  $('#rows').innerHTML = rows;
}

function renderLegend() {
  $('#legend').innerHTML = (state.index.targets || []).map((t, i) => `
    <span style="display:inline-flex; align-items:center; gap:8px; font-size:13px; color:#50546D;">
      <span style="display:inline-block; width:18px; height:3px; border-radius:2px; background:${targetColor(i)};"></span>${t.label || t.ip}
    </span>`).join('');
}

function makeChart(data) {
  const el = $('#chart');
  el.innerHTML = '';
  const width = Math.max(el.clientWidth || 900, 320);
  const isRtt = state.metric === 'rtt_avg';
  const unit = isRtt ? 'ms' : '%';

  const series = [{}].concat((state.index.targets || []).map((t, i) => ({
    label: t.label || t.ip,
    stroke: targetColor(i),
    width: 2,
    spanGaps: false,
    points: { show: false },
    value: (u, v) => (v == null ? '—' : `${fr(v, 1)} ${unit}`),
  })));

  const opts = {
    width,
    height: 320,
    legend: { show: false },
    scales: { x: { time: true } },
    axes: [
      { stroke: AXIS.text, font: AXIS.font, grid: { stroke: AXIS.grid, width: 1 }, ticks: { stroke: AXIS.grid } },
      {
        stroke: AXIS.text, font: AXIS.font, grid: { stroke: AXIS.grid, width: 1 }, ticks: { stroke: AXIS.grid },
        label: isRtt ? 'RTT (ms)' : 'Perte (%)', labelFont: '12px Marianne, sans-serif', labelSize: 30,
      },
    ],
    series,
  };

  if (state.chart) { state.chart.destroy(); state.chart = null; }
  // eslint-disable-next-line new-cap
  state.chart = new uPlot(opts, data, el);
}

async function renderChart() {
  const isRtt = state.metric === 'rtt_avg';
  $('#chartTitle').textContent = isRtt ? 'Latence aller-retour (RTT)' : 'Taux de perte de paquets';
  $('#chartRangeLabel').textContent = RANGE_LABELS[state.range];
  const { data, count } = await buildSeries();
  makeChart(data);
  $('#chartfoot').textContent = `${nf.format(count)} mesures affichées.`;
}

function wireToggle(groupSel, key) {
  document.querySelectorAll(`${groupSel} .seg`).forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`${groupSel} .seg`).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state[key] = btn.dataset[key];
      renderChart();
    });
  });
}

async function main() {
  try {
    state.index = await fetchJSON('data/index.json');
  } catch (err) {
    $('#chartfoot').textContent = 'Aucune donnée disponible (data/index.json introuvable).';
    console.error(err);
    return;
  }
  const gen = state.index.generatedAt
    ? new Date(state.index.generatedAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
    : '—';
  $('#generated').textContent = `Généré le ${gen} · fuseau ${state.index.timezone || 'UTC'}`;

  renderKpis();
  renderTable();
  renderLegend();
  await renderChart();
}

// ---- bootstrap ----------------------------------------------------------
wireToggle('#range', 'range');
wireToggle('#metric', 'metric');
$('#refresh').addEventListener('click', () => { state.dayCache.clear(); main(); });
window.addEventListener('resize', () => { if (state.chart) renderChart(); });
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
darkMq.addEventListener('change', () => { if (state.chart) renderChart(); });

main();
