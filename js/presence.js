/**
 * VSR — who is in a VSR lobby right now (window.VTPresence).
 *
 * Loaded by js/cursor-settings.js after who.js (async=false, URL resolved
 * from that script). Does nothing inside a frame.
 *
 * Online = a 17-digit Steam64 in a live session whose host (players[0]) is
 * in data/known-hosts.json, the same rule as the home Online now card.
 *
 * Snapshots: BZ2API.fetchSessions() dispatches `vt-live-sessions` after
 * every successful fetch, so a page that already polls (home, Game Watch,
 * Tools, matches) feeds this module. It fetches on its own only when no
 * snapshot is newer than FRESH_MS here or in another tab (localStorage
 * vt.presence.v1), one attempt per poll (BZ2API presence mode).
 *
 * Own polling: player/ and elo/ always; any other page only while a player
 * is followed (the navbar pill). Never on a page that sets
 * window.__vtPresenceFed (home). Paused while the tab is hidden.
 *
 * Row highlights (generated <style id="vt-presence-style">) apply only on
 * home, player/ and elo/ (html[data-vt-presence-rows]).
 *
 * API: has(steam64), state(steam64) -> 'InGame' | 'PreGame' | 'PostGame' |
 * 'Unknown' | '', ids() -> { steam64: state }, at() -> ms of the snapshot.
 * Event: `vt-presence-change` on document, detail { at, ids }.
 */
(function () {
  'use strict';

  if (window.VTPresence) return;

  const KEY = 'vt.presence.v1';
  const STEAM_RE = /^\d{17}$/;
  const POLL_MS = 60000;
  const POLL_JITTER_MS = 5000;
  const FRESH_MS = 55000;
  const STALE_MS = 180000;
  const MAX_BACKOFF_MS = 120000;
  const BOOT_DELAY_MS = 800;
  const ROW_PAGES = ['', 'player', 'elo'];
  const SRC = (document.currentScript && document.currentScript.src) || '';

  let framed = false;
  try { framed = window.top !== window.self; } catch (_) { framed = true; }

  let ids = {};
  let at = 0;
  let lastKey = '';
  let lastRef = null;
  let knownHosts = null;
  let hostsPromise = null;
  let apiPromise = null;
  let timer = null;
  let staleTimer = null;
  let inFlight = false;
  let booted = false;
  let nextDue = 0;
  let backoff = POLL_MS;

  function effective() {
    return at && Date.now() - at <= STALE_MS ? ids : {};
  }

  const api = {
    has: function (steam64) {
      return Object.prototype.hasOwnProperty.call(effective(), String(steam64 || ''));
    },
    state: function (steam64) {
      return effective()[String(steam64 || '')] || '';
    },
    ids: function () { return Object.assign({}, effective()); },
    at: function () { return at; },
  };
  window.VTPresence = api;
  if (framed) return;

  function siteUrl(path) {
    if (!SRC) return '';
    try { return new URL('../' + path, SRC).href; } catch (_) { return ''; }
  }

  function pageSegment() {
    const root = siteUrl('');
    if (!root) return null;
    let rootPath = '';
    try { rootPath = new URL(root).pathname; } catch (_) { return null; }
    const path = window.location.pathname;
    if (path.indexOf(rootPath) !== 0) return null;
    const seg = path.slice(rootPath.length).split('/')[0];
    return seg === 'index.html' ? '' : seg;
  }

  const segment = pageSegment();
  const rowsOn = segment !== null && ROW_PAGES.indexOf(segment) !== -1;
  if (rowsOn) document.documentElement.setAttribute('data-vt-presence-rows', '');

  function rank(state) {
    if (state === 'InGame') return 3;
    if (state === 'PreGame') return 2;
    return 1;
  }

  function idsFrom(sessions) {
    const out = {};
    if (!knownHosts || !Array.isArray(sessions)) return out;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const players = s && Array.isArray(s.players) ? s.players : [];
      const host = players[0];
      const hostId = host && host.steamId ? String(host.steamId) : '';
      if (!hostId || !knownHosts.has(hostId)) continue;
      const state = typeof s.state === 'string' && s.state ? s.state : 'Unknown';
      for (let k = 0; k < players.length; k++) {
        const id = players[k] && players[k].steamId ? String(players[k].steamId) : '';
        if (!STEAM_RE.test(id)) continue;
        if (!out[id] || rank(state) > rank(out[id])) out[id] = state;
      }
    }
    return out;
  }

  function clean(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach((id) => {
      if (STEAM_RE.test(id) && typeof raw[id] === 'string') out[id] = raw[id];
    });
    return out;
  }

  function readCache() {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isFinite(parsed.at)) return null;
      return { at: parsed.at, ids: clean(parsed.ids) };
    } catch (_) {
      return null;
    }
  }

  function writeCache() {
    try { window.localStorage.setItem(KEY, JSON.stringify({ at: at, ids: ids })); } catch (_) { /* */ }
  }

  function paintStyle(list) {
    let el = document.getElementById('vt-presence-style');
    if (!el) {
      el = document.createElement('style');
      el.id = 'vt-presence-style';
      (document.head || document.documentElement).appendChild(el);
    }
    if (!rowsOn || !list.length) {
      el.textContent = '';
      return;
    }
    const root = ':root[data-vt-presence-rows]';
    // A row whose cell spans columns is an expanded detail panel or a group
    // header, and a row holding a nested table wraps other rows.
    const leaf = ':not(:has(> [colspan])):not(:has(tr))';
    const rows = [];
    const cards = [];
    const home = [];
    const dots = [];
    list.forEach((id) => {
      const q = '"' + id + '"';
      rows.push(
        root + ' tr[data-steam64=' + q + ']' + leaf,
        root + ' tr[data-vtsr-steam64=' + q + ']' + leaf,
        root + ' tr:has(a[data-steam64=' + q + '])' + leaf
      );
      cards.push(
        root + ' .vt-player-card[data-steam64=' + q + ']',
        root + ' .vt-compare-mini-card[data-steam64=' + q + ']',
        root + ' .vt-highlight-tile:has(a[data-steam64=' + q + '])'
      );
      // The followed player's own block (.vt-home-you) stays unwashed: its
      // last-10 bars are green and red already, and the navbar pill says live.
      home.push(
        root + ' .vt-home-rise[data-steam64=' + q + ']',
        root + ' .vt-home-near[data-steam64=' + q + ']'
      );
      dots.push(
        root + ' a[data-steam64=' + q + ']:not(.vt-player-card):not(.vt-home-rise):not(.vt-home-near)::before'
      );
    });
    const tint = 'color-mix(in oklab, var(--kb-success) 14%, transparent)';
    el.textContent = rows.join(',\n') + ' {\n'
      + '  background: ' + tint + ';\n'
      + '}\n'
      + rows.map((s) => s + ' > :first-child').join(',\n') + ' {\n'
      + '  background-image: linear-gradient(var(--kb-success), var(--kb-success));\n'
      + '  background-size: 3px 100%;\n'
      + '  background-repeat: no-repeat;\n'
      + '}\n'
      + cards.join(',\n') + ' {\n'
      + '  border-color: color-mix(in oklab, var(--kb-success) 60%, var(--kb-border-subtle));\n'
      + '  box-shadow: inset 0 0 0 9999px color-mix(in oklab, var(--kb-success) 8%, transparent),'
      + ' 0 0 0 1px color-mix(in oklab, var(--kb-success) 60%, transparent);\n'
      + '}\n'
      + home.join(',\n') + ' {\n'
      + '  background: ' + tint + ';\n'
      + '  box-shadow: inset 3px 0 0 var(--kb-success);\n'
      + '}\n'
      + dots.join(',\n') + ' {\n'
      + '  content: "";\n'
      + '  display: inline-block;\n'
      + '  width: 0.45em;\n'
      + '  height: 0.45em;\n'
      + '  margin-right: 0.3em;\n'
      + '  border-radius: 50%;\n'
      + '  background: var(--kb-success);\n'
      + '  vertical-align: 0.1em;\n'
      + '}\n';
  }

  function refresh() {
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
    if (at) {
      const left = at + STALE_MS - Date.now();
      if (left > 0) staleTimer = setTimeout(refresh, left + 50);
    }
    const eff = effective();
    const key = Object.keys(eff).sort().map((id) => id + ':' + eff[id]).join(',');
    if (key === lastKey) return;
    lastKey = key;
    paintStyle(Object.keys(eff));
    document.dispatchEvent(new CustomEvent('vt-presence-change', {
      detail: { at: at, ids: Object.assign({}, eff) },
    }));
  }

  function adopt(nextIds, nextAt, persist) {
    if (!Number.isFinite(nextAt) || nextAt < at) return false;
    ids = clean(nextIds);
    at = nextAt;
    if (persist) writeCache();
    nextDue = at + POLL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
    backoff = POLL_MS;
    refresh();
    schedule();
    return true;
  }

  function loadHosts() {
    if (knownHosts) return Promise.resolve(knownHosts);
    if (hostsPromise) return hostsPromise;
    const url = siteUrl('data/known-hosts.json') || 'data/known-hosts.json';
    hostsPromise = fetch(url, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((data) => {
        const set = new Set();
        const hosts = data && Array.isArray(data.hosts) ? data.hosts : [];
        hosts.forEach((h) => {
          if (h && typeof h.steam_id === 'string' && STEAM_RE.test(h.steam_id)) set.add(h.steam_id);
        });
        knownHosts = set;
        return set;
      });
    return hostsPromise;
  }

  function loadApi() {
    if (window.BZ2API) return Promise.resolve(window.BZ2API);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      try { s.src = new URL('bz2api.js', SRC).href; } catch (_) { s.src = 'js/bz2api.js'; }
      s.async = true;
      s.onload = () => (window.BZ2API ? resolve(window.BZ2API) : reject(new Error('BZ2API missing')));
      s.onerror = () => {
        apiPromise = null;
        s.remove();
        reject(new Error('bz2api.js failed to load'));
      };
      (document.head || document.documentElement).appendChild(s);
    });
    return apiPromise;
  }

  function onSessions(ev) {
    const d = ev && ev.detail;
    if (!d || !Array.isArray(d.sessions)) return;
    lastRef = d.sessions;
    const when = Number(d.at) || Date.now();
    loadHosts().then(() => adopt(idsFrom(d.sessions), when, true));
  }

  function shouldPoll() {
    if (window.__vtPresenceFed) return false;
    if (rowsOn) return true;
    const who = window.VTWho;
    return !!(who && typeof who.status === 'function' && who.status() === 'set');
  }

  function schedule() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!booted || inFlight || document.hidden || !shouldPoll()) return;
    timer = setTimeout(tick, Math.max(0, nextDue - Date.now()));
  }

  function tick() {
    timer = null;
    if (inFlight || document.hidden || !shouldPoll()) return;
    const cached = readCache();
    if (cached && cached.at > at) adopt(cached.ids, cached.at, false);
    if (at && Date.now() - at < FRESH_MS) {
      schedule();
      return;
    }
    inFlight = true;
    Promise.all([loadApi(), loadHosts()])
      .then((parts) => parts[0].fetchSessions({ presence: true, quiet: true }))
      .then((res) => {
        const sessions = res && Array.isArray(res.sessions) ? res.sessions : [];
        if (sessions !== lastRef) adopt(idsFrom(sessions), Date.now(), true);
      })
      .catch(() => {
        nextDue = Date.now() + backoff;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      })
      .then(() => {
        inFlight = false;
        schedule();
      });
  }

  document.addEventListener('vt-live-sessions', onSessions);
  document.addEventListener('vt-who-change', schedule);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      schedule();
      return;
    }
    const cached = readCache();
    if (cached && cached.at > at) adopt(cached.ids, cached.at, false);
    refresh();
    schedule();
  });
  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return;
    const cached = readCache();
    if (cached) adopt(cached.ids, cached.at, false);
  });

  const cached = readCache();
  if (cached) adopt(cached.ids, cached.at, false);
  if (window.__vtLiveSnapshot) onSessions({ detail: window.__vtLiveSnapshot });

  function boot() {
    setTimeout(() => {
      booted = true;
      schedule();
    }, BOOT_DELAY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
