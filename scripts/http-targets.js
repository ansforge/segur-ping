'use strict';
// Shared loader for the HTTP supervision config (urls.json). Both collect-http.js
// (which writes one JSON file per URL) and build-site.js (which aggregates them
// into the manifest) use this so they agree on the per-URL id and the domain.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'urls.json');

// Hostname of a URL, used as the default "domain" for the dropdown grouping.
// Falls back to the raw string if the URL can't be parsed.
function hostOf(u) {
  try { return new URL(u).hostname; } catch (_) { return String(u); }
}

// Filename-safe short slug (letters/digits/dot/dash only).
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Deterministic, collision-safe id per URL: readable host + short hash of the
// full URL (so two paths on the same host get distinct files).
function idOf(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  return `${slug(hostOf(url)) || 'url'}-${h}`;
}

// Load urls.json and normalise each entry to { url, label, domain, id }.
// `domain` defaults to the URL hostname but can be overridden per entry.
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const urls = (cfg.urls || [])
    .filter((u) => u && u.url)
    .map((u) => ({
      url: u.url,
      label: u.label || u.url,
      domain: u.domain || hostOf(u.url),
      id: idOf(u.url),
    }));
  return {
    timezone: cfg.timezone || 'UTC',
    timeoutSec: cfg.timeoutSec || 10,
    concurrency: cfg.concurrency || 50,
    followRedirects: !!cfg.followRedirects,
    urls,
  };
}

module.exports = { loadConfig, idOf, hostOf, ROOT, CONFIG_PATH };
