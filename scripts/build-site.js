'use strict';
// Rebuild docs/data/index.json: the manifest the frontend reads. It lists every
// configured URL with its latest curl result (read from docs/data/http/<id>.json)
// plus the sorted list of distinct domains used to populate the dropdown.
// Run at publish time AND every minute in the Jenkins "Commit & push" stage so
// the manifest tracks the latest per-URL snapshots.

const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./http-targets');

const DATA_DIR = path.join(ROOT, 'docs', 'data');
const HTTP_DIR = path.join(DATA_DIR, 'http');

function readRec(id) {
  try { return JSON.parse(fs.readFileSync(path.join(HTTP_DIR, `${id}.json`), 'utf8')); }
  catch (_) { return null; }
}

function main() {
  const cfg = loadConfig();

  const urls = cfg.urls.map((t) => {
    const rec = readRec(t.id) || {};
    return {
      id: t.id,
      url: t.url,
      label: t.label,
      domain: t.domain,
      http_code: rec.http_code != null ? rec.http_code : null,
      ms: rec.ms != null ? rec.ms : null,
      ok: rec.ok != null ? rec.ok : null,
      err: rec.err != null ? rec.err : null,
      ts: rec.ts || null,
    };
  });

  const domains = [...new Set(urls.map((u) => u.domain))].sort((a, b) => a.localeCompare(b, 'fr'));

  const index = {
    generatedAt: new Date().toISOString(),
    timezone: cfg.timezone,
    domains,
    urls,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`[build-site] index.json written: ${urls.length} urls, ${domains.length} domains`);
}

main();
