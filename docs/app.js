'use strict';
// Frontend for the DSFR dashboard. Loads the manifest (data/index.json) which
// lists every supervised URL with its latest curl result (HTTP status code),
// then renders KPI cards and a status table filterable by domain.
// Fully static — no framework/build step.

// Le manifeste (data/index.json) est reconstruit chaque minute par Jenkins et
// poussé dans git, mais le site Pages n'est redéployé que toutes les 2 h : il sert
// donc un snapshot figé. Pour que « Actualiser » affiche les statuts quasi-live, on
// lit le JSON directement depuis le contenu brut de git (dernier commit, cache CDN
// ~5 min, CORS *) plutôt que depuis le snapshot Pages. Les assets statiques
// (HTML/CSS/JS) restent servis par Pages. Pour un dev local sur d'autres données,
// remplacer DATA_BASE par './data'.
const DATA_BASE = 'https://raw.githubusercontent.com/ansforge/segur-ping/main/docs/data';
function dataUrl(name) { return `${DATA_BASE}/${name}?t=${Date.now()}`; }

// Latest run of the Pages deploy workflow (api.github.com sends CORS: *, but is
// rate-limited to 60 req/h per IP for unauthenticated calls — fine on load/refresh).
const CI_RUNS_URL = 'https://api.github.com/repos/ansforge/segur-ping/actions/workflows/pages.yml/runs?per_page=1';

const state = { index: null, domain: 'all' };

const $ = (s) => document.querySelector(s);

async function fetchJSON(url) {
  // `reload` bypasses the browser HTTP cache entirely and sends `Cache-Control:
  // no-cache`, which compliant intermediary proxies honour by revalidating with
  // the origin — needed because some proxies ignore the `?t=` cache-buster.
  const r = await fetch(url, { cache: 'reload' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
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

// ---- classification ------------------------------------------------------
// Bucket a URL record for KPI counts and row styling.
//   ok        -> 2xx/3xx (curl ok, code < 400)
//   http_err  -> 4xx/5xx
//   down      -> no response (DNS/TLS/timeout, http_code null)
//   unknown   -> never measured yet
function bucketOf(u) {
  if (u.http_code == null) return u.ts ? 'down' : 'unknown';
  if (u.http_code >= 400) return 'http_err';
  return 'ok';
}

function statusBadge(u) {
  const c = u.http_code;
  if (c == null) {
    if (!u.ts) return '<span class="badge unknown">Inconnu</span>';
    return '<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>Injoignable</span>';
  }
  if (c >= 400) return `<span class="badge down"><span class="fr-icon-error-warning-line" style="font-size:14px;"></span>HTTP ${c}</span>`;
  if (c >= 300) return `<span class="badge warn"><span class="fr-icon-arrow-right-line" style="font-size:14px;"></span>Redirection</span>`;
  return '<span class="badge up"><span class="fr-icon-checkbox-circle-line" style="font-size:14px;"></span>En ligne</span>';
}

// ---- rendering -----------------------------------------------------------
// Reads the last GitHub Actions deploy run and reflects it in the header badge.
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
  const counts = { ok: 0, http_err: 0, down: 0, unknown: 0 };
  for (const u of urls) counts[bucketOf(u)]++;

  const kpis = [
    { label: 'URLs supervisées', value: nf.format(total), unit: '', note: `${state.index.domains ? state.index.domains.length : 0} domaine(s)` },
    { label: 'En ligne', value: nf.format(counts.ok), unit: '', note: '2xx / 3xx' },
    { label: 'Erreurs HTTP', value: nf.format(counts.http_err), unit: '', note: '4xx / 5xx' },
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
  // Keep the current selection if it still exists, else fall back to "all".
  if (state.domain !== 'all' && !domains.includes(state.domain)) state.domain = 'all';
  sel.value = state.domain;
}

function renderTable() {
  const all = state.index.urls || [];
  const urls = state.domain === 'all' ? all : all.filter((u) => u.domain === state.domain);

  const rows = urls.map((u) => {
    const bucket = bucketOf(u);
    const rowBg = (bucket === 'http_err' || bucket === 'down') ? 'background:#FEF1F6;' : '';
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
        <td class="r num muted">${u.ms == null ? '—' : `${nf.format(u.ms)} ms`}</td>
        <td class="r muted">${relTime(u.ts)}</td>
      </tr>`;
  }).join('');

  $('#rows').innerHTML = rows || '<tr><td class="l muted" colspan="7" style="padding:20px 14px;">Aucune URL pour ce domaine.</td></tr>';
  const label = state.domain === 'all' ? 'tous domaines' : state.domain;
  $('#filterCount').textContent = `${nf.format(urls.length)} URL(s) · ${label}`;
}

async function main() {
  renderCiBadge(); // independent of the data fetch — fire and forget
  try {
    state.index = await fetchJSON(dataUrl('index.json'));
  } catch (err) {
    $('#tablefoot').textContent = 'Aucune donnée disponible (data/index.json introuvable).';
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
    renderTable();
  } catch (err) {
    $('#tablefoot').textContent = `Erreur de rendu : ${err.message}`;
    console.error(err);
  }
}

// ---- bootstrap ----------------------------------------------------------
$('#domain').addEventListener('change', (e) => { state.domain = e.target.value; renderTable(); });
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.innerHTML = '<span class="fr-icon-refresh-line" style="font-size:14px;"></span>Actualisation…';
  try {
    await main();
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.innerHTML = prev;
  }
});

main();
