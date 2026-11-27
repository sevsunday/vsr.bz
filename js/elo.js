/* js/elo.js — dedicated ELO page controller (elo/index.html).
 *
 * The project's canonical home for both rating ladders: the full sortable
 * VSR-T leaderboard with per-row expandable detail panels (moved here from
 * the dashboard's All Matches view, which now shows a top-5 teaser), the
 * VSR-C commander ladder, and four explainer tabs that present the ratings
 * in layman-first language:
 *
 *   VSR-C Elo (default)    — sortable experimental commander-ladder
 *                             table (explainer lives on How).
 *   VSR-T                  — tier-grouped ladder + detail panels
 *                             (no # ranks; noise-band tie chips).
 *   How it works            — plain copy first: the short version, how
 *                             VSR-T moves (with the worked example), why
 *                             winning doesn't move it, bands and tiers,
 *                             VSR-C, which ladder rates a game. The
 *                             annotated ΔR = K(P−E) and α-blend stages and
 *                             the VSR-C formula sit in collapsed "The
 *                             math" disclosures (VTSRExplain.mathDetailsHtml
 *                             in the shared js/vtsr-explainers.js).
 *   What counts             — the scored axis (enemy damage share) + what stopped counting.
 *   Commanders & fairness   — the fairness rules as plain-language cards.
 *   Does it work?           — accuracy stats from the committed
 *                             data/processed/validation_summary.json. Lead
 *                             sentences are built from that data; tuning
 *                             tables (λ, α_c) and the which-games-count
 *                             chart are collapsed.
 *
 * Data (all 404-safe): elo_current.json + elo_history.json,
 * elo_commander_current.json + elo_commander_history.json,
 * player_slugs.json (player links), validation_summary.json (noise band
 * + accuracy tab), and match_contributions.json -> VTAggregate.build()
 * for the corpus-wide career_stats[] the leaderboard joins its Ship /
 * K/D / Acc columns from. VSR-T renders as bands and verdicts through
 * js/vtsr-display.js, never as a number; VSR-C keeps its numbers.
 *
 * Corpus-wide and picker-unaware (mirrors the VSR-T contract). The
 * v2.7 thug-only alt pair and the wins-weighted preview are retired.
 * Published VSR-T is always elo_current.json (alpha 0).
 *
 * The 1v1 pill (VSR-1v1, elo_1v1_current.json + elo_1v1_history.json)
 * is a third, separate ladder: plain Elo over recorded head-to-head games.
 * The 2v2C and 2v2T pills (elo_2v2_current.json + elo_2v2_history.json)
 * are separate top-level pills. The thug pane switches between its two
 * ratings with &view=perf|wl|compare. ALL THREE ARE HIDDEN while
 * VTSRDisplay.SMALL_FORMAT_RATINGS_VISIBLE is false: the pills stay
 * d-none, ?tab=1v1|2v2|2v2c|2v2t lands on VSR-C and the files are not
 * fetched. The four explainer pills stay in
 * the markup with d-none; their panes and ?tab= links still work.
 *
 * URL routing: ?tab=vsr-c|vsr-t|1v1|2v2c|2v2t|how|axes|fairness|accuracy (replaceState
 * sync on pill change; deep links boot straight into the right pane). The
 * VSR-C pane is the default and writes no ?tab= at all. `vsr-t` opens
 * the thug board; `vtsr-c` / `vtsr-t` (pre-rebrand) and `leaderboard`
 * (pre-split) are permanent inbound aliases rewritten to the canonical
 * slug. A legacy ?rating=wins with no tab still opens the thug board
 * and the param is dropped.
 */
(function () {
  'use strict';

  const DATA = '../data/processed/';

  // VSR-1v1 / VSR-2v2 are hidden site-wide while this is false (the
  // switch lives in js/vtsr-display.js). Hidden: their pills stay
  // d-none, their ?tab= slugs land on VSR-C, their How sections are
  // left out and their JSON is never fetched.
  const SMALL_FORMAT_RATINGS = !!(window.VTSRDisplay && window.VTSRDisplay.SMALL_FORMAT_RATINGS_VISIBLE);

  // ----------------------------------------------------------------------
  // Generic helpers (local copies of the small app.js utilities — the
  // player.js precedent: standalone pages don't import the dashboard
  // monolith).
  // ----------------------------------------------------------------------

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmt(n) { return Math.round(n || 0).toLocaleString(); }
  function ensureTooltips(container) {
    if (!container || !window.bootstrap || !window.bootstrap.Tooltip) return;
    container.querySelectorAll('[data-bs-toggle="tooltip"]')
      .forEach(el => bootstrap.Tooltip.getOrCreateInstance(el));
  }
  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ----------------------------------------------------------------------
  // Tier ladder (render-layer policy — mirrors js/app.js + the duplicate
  // in scripts/generate_player_pages.py).
  // ----------------------------------------------------------------------

  const ELO_PROVISIONAL_THRESHOLD = 10;
  // Display-only ranked-ladder gate. Live value comes from
  // elo_current.json `leaderboard_min_matches`. Mirrors
  // scripts/elo.py ELO_LADDER_MIN_MATCHES. Independent of the
  // 10-match Provisional badge.
  const ELO_LADDER_MIN_MATCHES_FALLBACK = 25;
  // Tier list (top first) from elo_current.json band_config via
  // js/vtsr-display.js. Tier 0 is a real tier; provisional rows use the
  // PROVISIONAL_TIER id instead.
  const PROVISIONAL_TIER = 'provisional';
  const vtsrTiers = () => VTSRDisplay.tiers();
  function resolveTier(vtsr, matchesPlayed) {
    if (matchesPlayed < ELO_PROVISIONAL_THRESHOLD) {
      return { id: PROVISIONAL_TIER, label: 'Provisional', short: '?' };
    }
    return VTSRDisplay.tierFor(vtsr);
  }
  function vtsrLadderMinMatches(elo) {
    return (elo && elo.leaderboard_min_matches != null)
      ? elo.leaderboard_min_matches
      : ELO_LADDER_MIN_MATCHES_FALLBACK;
  }

  function vtsrLadderEligible(r, elo) {
    if (typeof r.leaderboard_eligible === 'boolean') return r.leaderboard_eligible;
    return (r.matches_played || 0) >= vtsrLadderMinMatches(elo);
  }

  function inactivityWindowDays(src) {
    return (src && src.inactivity_window_days != null) ? src.inactivity_window_days : 90;
  }
  function comebackGamesRequired(src) {
    return (src && src.comeback_games_required != null) ? src.comeback_games_required : 3;
  }
  function commandStaleWindowDays(src) {
    return (src && src.command_stale_window_days != null) ? src.command_stale_window_days : 90;
  }

  function statusChipHtml(cls, label, title) {
    return ` <span class="${cls}" data-bs-toggle="tooltip" data-bs-placement="top"
              title="${esc(title)}">${esc(label)}</span>`;
  }

  function vtsrProgressChipHtml(r, elo) {
    const status = r.inactive_status || 'active';
    const need = comebackGamesRequired(elo);
    if (status === 'returning') {
      const n = r.comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need}`,
        `${n} of ${need} games since returning. Play ${Math.max(0, need - n)} more to rejoin the ladder.`
      );
    }
    if (status === 'inactive') {
      const d = r.days_since_last_match || 0;
      const win = inactivityWindowDays(elo);
      const seen = r.last_seen_date;
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match in the corpus. Play ${need} games within ${win} days to rejoin the ladder.`
        : `No recorded appearance in the corpus or community ledger. Play ${need} games within ${win} days to join the ladder.`;
      return statusChipHtml('vt-vtsr-inactive-chip', label, title);
    }
    const n = r.matches_played || 0;
    const min = vtsrLadderMinMatches(elo);
    const title = `${n} of ${min} rated matches to appear on the ladder.`;
    const label = n === 1 ? '1 match' : `${n} matches`;
    return statusChipHtml('vt-cmdr-progress-chip', label, title);
  }

  // ----------------------------------------------------------------------
  // Page state + data loading.
  // ----------------------------------------------------------------------

  const state = {
    elo: null,            // canonical elo_current.json (null on 404)
    eloHistory: null,
    cmdrElo: null,        // elo_commander_current.json (null on 404 — VSR-C card hides)
    cmdrHistory: null,    // elo_commander_history.json (null on 404 — detail panels degrade)
    v1Elo: null,          // elo_1v1_current.json (null on 404 — 1v1 card hides)
    v1History: null,      // elo_1v1_history.json (null on 404 — game logs degrade)
    v2Elo: null,          // elo_2v2_current.json (null on 404 — 2v2 cards hide)
    v2History: null,      // elo_2v2_history.json (null on 404 — game logs degrade)
    slugMap: null,
    validation: null,
    careerStats: [],      // corpus-wide aggregate join source
    historyChart: null,   // Chart.js instance on the accuracy tab
  };

  // The retired wins-weighted preview used ?rating=wins&w=. Old links
  // still land on the thug pane; the params are dropped on boot.
  function stripLegacyRatingParams() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('rating') && !url.searchParams.has('w')) return;
    url.searchParams.delete('rating');
    url.searchParams.delete('w');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  // Player links resolve to the canonical player/<slug>/ from this page's
  // subdirectory (../player/...); fall back to the runtime ?p= route.
  function playerHref(steam64) {
    const sid = String(steam64 || '').trim();
    if (!sid) return null;
    const slugs = (state.slugMap && state.slugMap.slugs) || null;
    const entry = slugs ? slugs[sid] : null;
    if (entry && entry.slug) return `../player/${entry.slug}/`;
    return `../player/index.html?p=${encodeURIComponent(sid)}`;
  }
  function playerLinkHtml(name, steam64) {
    const safeName = esc(name == null ? '' : name);
    const href = playerHref(steam64);
    if (!href) return `<span class="vt-player-link-fallback">${safeName}</span>`;
    const slugs = (state.slugMap && state.slugMap.slugs) || null;
    const cls = (slugs && slugs[String(steam64)] && slugs[String(steam64)].slug)
      ? 'vt-player-link' : 'vt-player-link vt-player-link-fallback';
    const sid = /^\d{17}$/.test(String(steam64 || '')) ? String(steam64) : '';
    const attr = sid ? ` data-steam64="${sid}"` : '';
    return `<a class="${cls}" href="${href}"${attr}>${safeName}</a>`;
  }

  // Bootstrap resampling noise floor (±σ ELO) from validation_summary.json.
  function ratingNoiseSigma() {
    const sigma = state.validation && state.validation.latest
      && state.validation.latest.bootstrap_proxy_std_median;
    if (typeof sigma !== 'number' || !isFinite(sigma) || sigma <= 0) return null;
    return Math.round(sigma);
  }

  // ----------------------------------------------------------------------
  // Leaderboard (moved from js/app.js renderVtsrLeaderboard + helpers).
  // Corpus-wide: no picker filter exists here, so every rated player shows.
  // ----------------------------------------------------------------------

  let vtsrSortState = { key: 'position', asc: false };
  const expandedVtsrRows = new Set();
  let _vtsrCareerStats = null;

  function vtsrCareerByName(eloRow) {
    if (!_vtsrCareerStats) return null;
    if (eloRow.steam64) {
      const r = _vtsrCareerStats.find(c => c.steam64 === eloRow.steam64);
      if (r) return r;
    }
    if (eloRow.name) {
      const lower = eloRow.name.toLowerCase();
      return _vtsrCareerStats.find(c => (c.name || '').toLowerCase() === lower) || null;
    }
    return null;
  }

  function vtsrRowKey(r) {
    const raw = r.steam64 || r.name || '';
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function vtsrSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':           va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'last_delta':     va = a.last_delta || 0;            vb = b.last_delta || 0;            break;
        case 'peak_vtsr':      va = a.peak_vtsr || 0;             vb = b.peak_vtsr || 0;             break;
        case 'matches_played': va = a.matches_played || 0;        vb = b.matches_played || 0;        break;
        case 'pvp_kd': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? (ca.total_pvp_kills || 0) / Math.max(1, ca.total_pvp_deaths || 0) : -1;
          vb = cb ? (cb.total_pvp_kills || 0) / Math.max(1, cb.total_pvp_deaths || 0) : -1;
          break;
        }
        case 'win_rate': {
          const rate = (row) => {
            const rec = row.wins_record || {};
            const w = rec.w || 0;
            const l = rec.l || 0;
            const d = rec.d || 0;
            const n = w + l + d;
            return n > 0 ? (w + 0.5 * d) / n : -1;
          };
          va = rate(a);
          vb = rate(b);
          break;
        }
        case 'accuracy': {
          const ca = vtsrCareerByName(a);
          const cb = vtsrCareerByName(b);
          va = ca ? ((ca.overall_accuracy_est != null ? ca.overall_accuracy_est : ca.overall_accuracy) || 0) : -1;
          vb = cb ? ((cb.overall_accuracy_est != null ? cb.overall_accuracy_est : cb.overall_accuracy) || 0) : -1;
          break;
        }
        case 'position': {
          const pin = (row) => {
            const p = VTSRDisplay.positionPinPct(row);
            return p == null ? -1 : p;
          };
          va = pin(a);
          vb = pin(b);
          break;
        }
        case 'band':
        default:               va = VTSRDisplay.bandFor(a).index; vb = VTSRDisplay.bandFor(b).index; break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  // Per-axis metadata for the expand panel's hover tooltips (local copy of
  // the catalog in js/app.js — keys mirror elo_current.json `weights`).
  const VTSR_AXIS_META = {
    enemy_damage_share: {
      label: 'Enemy damage share',
      formula: 'enemy_dealt / sum_lobby(enemy_dealt)',
      desc:    'Your damage to the enemy as a share of all the damage your lobby did to the enemy. Players, scavengers, extractors, AI units and buildings all count the same per point. Damage to your own team\u2019s units, loose scrap and map props does not count.',
    },
  };

  function buildAxisTooltipHtml(axisName, z, mode, weight) {
    const meta = VTSR_AXIS_META[axisName] || { label: axisName, formula: '', desc: '' };
    const zSign = z >= 0 ? '+' : '';
    const zRounded = z.toFixed(2);
    let interp;
    const matchPhrase = mode === 'last_match' ? ' for that match' : '';
    if (Math.abs(z) < 0.05) {
      interp = `About average for the lobby${matchPhrase}.`;
    } else if (z > 0) {
      interp = `<span style="color:var(--kb-success);">Above lobby average${matchPhrase}.</span> Higher than peers.`;
    } else {
      interp = `<span style="color:var(--kb-danger);">Below lobby average${matchPhrase}.</span> Lower than peers.`;
    }
    const formulaLine = meta.formula
      ? `<div style="margin-top:0.3rem;"><code style="font-size:0.75rem;">${esc(meta.formula)}</code></div>`
      : '';
    const descLine = meta.desc
      ? `<div style="margin-top:0.3rem;">${esc(meta.desc)}</div>`
      : '';
    let weightLine = '';
    if (weight != null) {
      const wc = z * weight;
      const wcSign = wc >= 0 ? '+' : '';
      weightLine = `<div style="margin-top:0.3rem;">Weight ${weight.toFixed(2)} \u2192 contribution ${wcSign}${wc.toFixed(3)}</div>`;
    }
    return `<div><strong>${esc(meta.label)}</strong> &middot; ${zSign}${zRounded}\u03c3</div>
            ${formulaLine}
            ${descLine}
            ${weightLine}
            <div style="margin-top:0.3rem;">${interp}</div>`;
  }

  function renderVtsrAxisGrid(axisMap, mode, weightsMap) {
    const axes = Object.keys(axisMap || {});
    if (!axes.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>${mode === 'career' ? 'Career axis profile' : 'Last-match axis breakdown'}</h6>
        <div class="text-muted small">No per-axis data available.</div>
      </section>`;
    }
    const sorted = axes.slice().sort((a, b) =>
      Math.abs(axisMap[b]) - Math.abs(axisMap[a])
    );
    const rows = sorted.map(a => {
      const z = axisMap[a] || 0;
      const cls = z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
      const widthPct = Math.min(100, Math.abs(z) * 50);
      const fillStyle = z >= 0
        ? `left:50%; width:${widthPct.toFixed(2)}%;`
        : `right:50%; width:${widthPct.toFixed(2)}%;`;
      const label = (VTSR_AXIS_META[a] && VTSR_AXIS_META[a].label) || a;
      const reading = Math.abs(z) < 0.05 ? 'Average' : (z > 0 ? 'Above avg' : 'Below avg');
      const weight = (weightsMap && weightsMap[a] != null) ? weightsMap[a] : null;
      const tipHtml = buildAxisTooltipHtml(a, z, mode, weight);
      return `<div class="vt-axis-bar-row ${cls}"
                   data-bs-toggle="tooltip" data-bs-html="true"
                   data-bs-placement="top"
                   data-bs-custom-class="vt-axis-tooltip"
                   title="${esc(tipHtml)}">
        <span class="vt-axis-bar-name">${esc(label)}</span>
        <span class="vt-axis-bar-track">
          <span class="vt-axis-bar-center"></span>
          <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
        </span>
        <span class="vt-axis-bar-z">${reading}</span>
      </div>`;
    }).join('');
    const careerSub = 'typical showing across rated matches';
    const heading = mode === 'career'
      ? `Career axis profile <span class="vt-vtsr-detail-sub text-muted">(${careerSub})</span>`
      : 'Last-match axis breakdown';
    return `<section class="vt-vtsr-detail-section">
      <h6>${heading}</h6>
      <div class="vt-axis-bar-grid">${rows}</div>
    </section>`;
  }

  function renderVtsrLastMatchSection(eloRow) {
    const hist = state.eloHistory;
    if (hist == null) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Last-match axis breakdown</h6>
        <div class="text-muted small">Axis breakdown unavailable (elo_history.json missing).</div>
      </section>`;
    }
    const targetSteam64 = eloRow.steam64 || '';
    const targetName = eloRow.name || '';
    const history = (hist.history || []);
    let lastDelta = null;
    let lastEntry = null;
    for (let i = history.length - 1; i >= 0 && !lastDelta; i--) {
      const h = history[i];
      if (h.match_excluded) continue;
      const found = (h.deltas || []).find(d =>
        (targetSteam64 && d.steam64 === targetSteam64) || d.name === targetName
      );
      if (found) { lastDelta = found; lastEntry = h; }
    }
    if (!lastDelta) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Last-match axis breakdown</h6>
        <div class="text-muted small">No rated match history for this player yet.</div>
      </section>`;
    }
    const ac = lastDelta.axis_contributions || {};
    const matchId = lastEntry.match_id || '';
    const perfStr = (lastDelta.performance != null ? lastDelta.performance : 0).toFixed(2);
    const perfSign = lastDelta.performance > 0 ? '+' : '';
    const expStr = (lastDelta.expected != null ? lastDelta.expected : 0).toFixed(2);
    const expSign = lastDelta.expected > 0 ? '+' : '';

    // Pro-rata redistribute weights over only the axes present
    // (matches Python compute_performance_index() rule).
    const activeElo = state.elo;
    const weightsAll = (activeElo && activeElo.weights) || {};
    const availableAxes = Object.keys(ac);
    const totalWeight = availableAxes.reduce((s, a) => s + (weightsAll[a] || 0), 0);
    const weightsRedistributed = {};
    if (totalWeight > 0) {
      for (const a of availableAxes) {
        weightsRedistributed[a] = (weightsAll[a] || 0) / totalWeight;
      }
    }
    const grid = renderVtsrAxisGrid(ac, 'last_match', weightsRedistributed);
    const verdict = VTSRDisplay.verdictChipHtml(lastDelta.delta, { long: true });
    const formulaLine = `<div class="vt-vtsr-detail-formula"><strong>${esc(matchId)}</strong> &middot; Scored ${perfSign}${perfStr} vs ${expSign}${expStr} expected \u2192 ${verdict}</div>`;
    return grid.replace('</h6>', `</h6>${formulaLine}`);
  }

  function renderVtsrCombatSection(careerRow) {
    if (!careerRow) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Combat split</h6>
        <div class="text-muted small">No career data for this player yet.</div>
      </section>`;
    }
    const pvpK = careerRow.total_pvp_kills  || 0;
    const pveK = careerRow.total_pve_kills  || 0;
    const pvpD = careerRow.total_pvp_deaths || 0;
    const pveD = careerRow.total_pve_deaths || 0;
    const totalDealt = careerRow.total_dealt || 0;
    const activeSec = (careerRow.career_loadout && careerRow.career_loadout.active_seconds) || 0;
    const activeHrs = activeSec >= 3600
      ? (activeSec / 3600).toFixed(1) + 'h'
      : Math.round(activeSec / 60) + 'm';
    return `<section class="vt-vtsr-detail-section">
      <h6>Combat split</h6>
      <div class="vt-vtsr-detail-stats">
        <div><span class="vt-stat-label">PvP Kills</span><span class="vt-stat-value">${pvpK}</span></div>
        <div><span class="vt-stat-label">PvE Kills</span><span class="vt-stat-value">${pveK}</span></div>
        <div><span class="vt-stat-label">PvP Deaths</span><span class="vt-stat-value">${pvpD}</span></div>
        <div><span class="vt-stat-label">PvE Deaths</span><span class="vt-stat-value">${pveD}</span></div>
        <div><span class="vt-stat-label">Total Dmg</span><span class="vt-stat-value">${fmt(totalDealt)}</span></div>
        <div><span class="vt-stat-label">Active</span><span class="vt-stat-value">${activeHrs}</span></div>
      </div>
    </section>`;
  }

  function renderVtsrShipLoadoutSection(careerRow) {
    const list = (careerRow && careerRow.career_per_ship_combat) || [];
    if (!list.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Ship loadout</h6>
        <div class="text-muted small">No ship-level data available.</div>
      </section>`;
    }
    const top = list.slice(0, 5);
    const totalActiveSec = (careerRow && careerRow.career_loadout && careerRow.career_loadout.active_seconds) || 0;
    const rows = top.map(s => {
      const share = totalActiveSec > 0 ? (s.time_seconds || 0) / totalActiveSec : 0;
      const widthPct = (share * 100).toFixed(1);
      const kd = s.kd != null ? s.kd.toFixed(2) : '\u2014';
      const timeStr = (s.time_seconds || 0) >= 3600
        ? ((s.time_seconds || 0) / 3600).toFixed(1) + 'h'
        : Math.round((s.time_seconds || 0) / 60) + 'm';
      return `<div class="vt-vtsr-detail-loadout-row">
        <span class="vt-vtsr-detail-loadout-name">${esc(s.ship_name || s.ship)}</span>
        <span class="vt-vtsr-detail-loadout-bar">
          <span class="vt-vtsr-detail-loadout-bar-fill" style="width:${widthPct}%;"></span>
        </span>
        <span class="vt-vtsr-detail-loadout-share">${(share * 100).toFixed(1)}%</span>
        <span class="vt-vtsr-detail-loadout-time">${timeStr}</span>
        <span class="vt-vtsr-detail-loadout-kd">${kd} K/D</span>
      </div>`;
    }).join('');
    const more = list.length > 5
      ? `<div class="vt-vtsr-detail-loadout-more text-muted small">+ ${list.length - 5} more ${list.length - 5 === 1 ? 'ship' : 'ships'}</div>`
      : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Ship distribution <span class="vt-vtsr-detail-sub text-muted">(top ${Math.min(5, list.length)} by time)</span></h6>
      ${rows}
      ${more}
    </section>`;
  }

  function renderVtsrWeaponDistributionSection(careerRow) {
    const wb = (careerRow && careerRow.weapon_breakdown) || {};
    const list = Object.entries(wb)
      .filter(([, w]) => (w && (w.dealt || 0) > 0))
      .sort(([, a], [, b]) => (b.dealt || 0) - (a.dealt || 0));
    if (!list.length) {
      return `<section class="vt-vtsr-detail-section">
        <h6>Weapon distribution</h6>
        <div class="text-muted small">No weapon data available.</div>
      </section>`;
    }
    const top = list.slice(0, 5);
    const totalDealt = list.reduce((s, [, w]) => s + (w.dealt || 0), 0);
    const rows = top.map(([wname, w]) => {
      const share = totalDealt > 0 ? (w.dealt || 0) / totalDealt : 0;
      const widthPct = (share * 100).toFixed(1);
      const accStr = (w.shots || 0) > 0
        ? ((w.accuracy || 0) * 100).toFixed(1) + '%'
        : '\u2014';
      return `<div class="vt-vtsr-detail-loadout-row">
        <span class="vt-vtsr-detail-loadout-name">${esc(wname)}</span>
        <span class="vt-vtsr-detail-loadout-bar">
          <span class="vt-vtsr-detail-loadout-bar-fill" style="width:${widthPct}%;"></span>
        </span>
        <span class="vt-vtsr-detail-loadout-share">${(share * 100).toFixed(1)}%</span>
        <span class="vt-vtsr-detail-loadout-time">${fmt(w.dealt || 0)}</span>
        <span class="vt-vtsr-detail-loadout-kd">${accStr}</span>
      </div>`;
    }).join('');
    const more = list.length > 5
      ? `<div class="vt-vtsr-detail-loadout-more text-muted small">+ ${list.length - 5} more ${list.length - 5 === 1 ? 'weapon' : 'weapons'}</div>`
      : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Weapon distribution <span class="vt-vtsr-detail-sub text-muted">(top ${Math.min(5, list.length)} by damage)</span></h6>
      ${rows}
      ${more}
    </section>`;
  }

  function renderVtsrPeakSection(eloRow) {
    const peakBand = VTSRDisplay.rawBandFor(eloRow.peak_vtsr || eloRow.vtsr || 0);
    const peakAt = eloRow.peak_at || '';
    const peakStr = peakAt ? `Reached at <strong>${esc(peakAt)}</strong>` : '';
    return `<section class="vt-vtsr-detail-section">
      <h6>Highest band</h6>
      <div class="vt-vtsr-detail-peak">
        <span class="vt-vtsr-detail-peak-value">${VTSRDisplay.bandChipHtml(peakBand, { title: '' })}</span>
        <span class="vt-vtsr-detail-peak-label text-muted">${peakStr}</span>
      </div>
    </section>`;
  }

  function buildVtsrDetailPanel(eloRow, careerRow) {
    const sectA = renderVtsrCombatSection(careerRow);
    const sectB = renderVtsrAxisGrid(eloRow.axis_means || {}, 'career', null);
    const sectC = renderVtsrLastMatchSection(eloRow);
    const sectD = renderVtsrShipLoadoutSection(careerRow);
    const sectE = renderVtsrPeakSection(eloRow);
    const sectF = renderVtsrWeaponDistributionSection(careerRow);
    return `<div class="vt-vtsr-detail-grid">
      <div class="vt-vtsr-detail-col">
        ${sectA}
        ${sectD}
        ${sectF}
        ${sectE}
      </div>
      <div class="vt-vtsr-detail-col">
        ${sectB}
        ${sectC}
      </div>
    </div>`;
  }

  function vtsrTierGroupHeaderHtml(tier, count, colSpan) {
    const badge = tier.id === PROVISIONAL_TIER
      ? '<span class="vt-vtsr-provisional">?</span>'
      : `<span class="vt-tier-badge vt-tier-${tier.id}">${tier.short}</span>`;
    const nLabel = count === 1 ? '1 player' : `${count} players`;
    return `<tr class="vt-vtsr-tier-group" aria-hidden="true">
      <td colspan="${colSpan}">
        <span class="vt-vtsr-tier-group-badge">${badge}</span>
        <span class="vt-vtsr-tier-group-label">${esc(tier.label)}</span>
        <span class="vt-vtsr-tier-group-count">${esc(nLabel)}</span>
      </td>
    </tr>`;
  }

  function vtsrHalfGroupHeaderHtml(halfLabel, count, colSpan) {
    const nLabel = count === 1 ? '1 player' : `${count} players`;
    return `<tr class="vt-vtsr-half-group" aria-hidden="true">
      <td colspan="${colSpan}">
        <span class="vt-vtsr-half-group-label">${esc(halfLabel)}</span>
        <span class="vt-vtsr-tier-group-count">${esc(nLabel)}</span>
      </td>
    </tr>`;
  }

  function renderVtsrLadderRow(r, elo, opts = {}) {
    const { noiseSigma = null, showProgress = false } = opts;
    const band = VTSRDisplay.bandFor(r);
    const bandTip = band.provisional
      ? `Provisional · play ${ELO_PROVISIONAL_THRESHOLD - r.matches_played} more rated matches to leave Provisional`
      : `${band.label}. ${VTSRDisplay.BAND_EXPLAINER}`;
    const badge = VTSRDisplay.bandChipHtml(band, { title: bandTip });
    const bar = VTSRDisplay.positionBarHtml(r, noiseSigma, { band, compact: true });
    const rowKey = vtsrRowKey(r);
    const detailId = `vtsr-detail-${rowKey}`;
    const expanded = expandedVtsrRows.has(rowKey);

    const careerRow = vtsrCareerByName(r);

    let playerCellAttrs = '';
    const playerTipParts = [];
    if (r.steam64) playerTipParts.push(`Steam64: ${r.steam64}`);
    const inGameNick = (careerRow && careerRow.in_game_nick) || null;
    if (inGameNick && inGameNick.toLowerCase() !== (r.name || '').toLowerCase()) {
      playerTipParts.push(`In-game nick: ${inGameNick}`);
    }
    if (playerTipParts.length) {
      playerCellAttrs = ` data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(playerTipParts.join(' \u00b7 '))}"`;
    }

    const pvpK = careerRow ? (careerRow.total_pvp_kills || 0) : 0;
    const pvpD = careerRow ? (careerRow.total_pvp_deaths || 0) : 0;
    const fmtKd = (k, d) => {
      if (d === 0 && k === 0) return '\u2014';
      if (d === 0) return '\u221e';
      return (k / d).toFixed(2);
    };
    const pvpKdStr = (pvpK + pvpD > 0) ? fmtKd(pvpK, pvpD) : '\u2014';
    const pvpKdTip = (pvpK + pvpD > 0) ? `${pvpK} PvP kills / ${pvpD} PvP deaths` : 'No PvP combat';

    const totalShots = careerRow ? (careerRow.total_shots_fired || 0) : 0;
    const totalHits  = careerRow ? (careerRow.total_shots_hit_est != null ? careerRow.total_shots_hit_est : (careerRow.total_shots_hit || 0)) : 0;
    const accRate = careerRow
      ? ((careerRow.overall_accuracy_est != null ? careerRow.overall_accuracy_est : careerRow.overall_accuracy) || 0)
      : 0;
    const accStr = careerRow
      ? `${careerRow.overall_accuracy_est != null ? '~' : ''}${(accRate * 100).toFixed(1)}%`
      : '\u2014';
    const accTip = totalShots > 0
      ? `${totalHits.toLocaleString()} hits / ${totalShots.toLocaleString()} shots = ${(accRate * 100).toFixed(2)}%${careerRow.overall_accuracy_est != null ? ' (est.)' : ''}`
      : 'No shots fired this career';

    const winRec = r.wins_record || {};
    const winW = winRec.w || 0;
    const winL = winRec.l || 0;
    const winD = winRec.d || 0;
    const winN = winW + winL + winD;
    const winRateStr = winN > 0 ? `${Math.round(((winW + 0.5 * winD) / winN) * 100)}%` : '\u2014';
    const winRecordStr = winD > 0 ? `${winW}\u2013${winL}\u2013${winD}` : `${winW}\u2013${winL}`;
    const winRateTip = winN > 0
      ? `${winRecordStr} \u00b7 ${winN} decided rated ${winN === 1 ? 'match' : 'matches'}. How often this player's team won. Camera-pod, partial, and idle rows are left out; only matches with a recorded winner are rated. This does not move VSR-T.`
      : 'No decided rated matches';

    const peakBand = VTSRDisplay.rawBandFor(r.peak_vtsr || r.vtsr);
    const peakAt = r.peak_at || '';
    const peakTip = peakAt
      ? `Highest band reached: ${peakBand ? peakBand.label : ''}, at ${peakAt}`
      : `Highest band reached: ${peakBand ? peakBand.label : ''}`;

    const matchesTip = `${r.matches_played} rated ${r.matches_played === 1 ? 'match' : 'matches'} \u00b7 excludes matches with <6 players or no recorded winner`;

    const detailHtml = buildVtsrDetailPanel(r, careerRow);
    const progressChip = showProgress ? vtsrProgressChipHtml(r, elo) : '';
    const colSpan = 9;

    return `<tr data-vtsr-name="${esc(r.name)}" data-vtsr-steam64="${esc(r.steam64 || '')}" data-vtsr-key="${esc(rowKey)}">
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle row details">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      <td class="vt-vtsr-tier-col">${badge}</td>
      <td class="fw-semibold"${playerCellAttrs}>${playerLinkHtml(r.name, r.steam64)}${progressChip}</td>
      <td class="vt-vtsr-position-col">${bar}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(winRateTip)}">${winRateStr}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(pvpKdTip)}">${pvpKdStr}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(accTip)}">${accStr}</td>
      <td class="text-end">${VTSRDisplay.bandChipHtml(peakBand, { compact: true, muted: true, title: peakTip })}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(matchesTip)}">${r.matches_played}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="${colSpan}">${detailHtml}</td>
    </tr>`;
  }

  // Tier groups (0 -> 5, reversed when the Band column sorts ascending).
  // Band and Position each keep the Upper / Lower sub-groups. Band
  // sorts names A-Z inside a half; Position sorts by the white pin
  // inside that half and does not flip which half comes first. Any
  // other column sort reorders rows inside the whole tier group.
  function renderVtsrGroupedRows(ranked, elo, noiseSigma) {
    const colSpan = 9;
    const sorter = vtsrSort(vtsrSortState.key, vtsrSortState.asc);
    const bandSort = vtsrSortState.key === 'band';
    const halfSort = bandSort || vtsrSortState.key === 'position';

    const buckets = new Map();
    for (const r of ranked) {
      const tier = resolveTier(r.vtsr, r.matches_played);
      const band = VTSRDisplay.bandFor(r);
      const id = band.provisional ? PROVISIONAL_TIER : band.tier;
      const t = id === PROVISIONAL_TIER ? tier : (vtsrTiers().find(x => x.id === id) || tier);
      if (!buckets.has(id)) buckets.set(id, { tier: t, rows: [] });
      buckets.get(id).rows.push(r);
    }
    for (const b of buckets.values()) b.rows.sort(sorter);

    let tierOrder = vtsrTiers().map(t => t.id);
    if (bandSort && vtsrSortState.asc) tierOrder = tierOrder.slice().reverse();
    if (buckets.has(PROVISIONAL_TIER)) tierOrder = [...tierOrder, PROVISIONAL_TIER];

    const rowHtml = r => renderVtsrLadderRow(r, elo, { noiseSigma, showProgress: false });
    let html = '';
    for (const id of tierOrder) {
      const b = buckets.get(id);
      if (!b || !b.rows.length) continue;
      html += vtsrTierGroupHeaderHtml(b.tier, b.rows.length, colSpan);
      if (halfSort && id !== PROVISIONAL_TIER) {
        // Only the Band column reverses half order. Position keeps
        // Upper above Lower and reorders players inside each half.
        const halves = (bandSort && vtsrSortState.asc) ? ['lower', 'upper'] : ['upper', 'lower'];
        for (const half of halves) {
          const rows = b.rows.filter(r => VTSRDisplay.bandFor(r).half === half);
          if (!rows.length) continue;
          html += vtsrHalfGroupHeaderHtml(half === 'upper' ? 'Upper' : 'Lower', rows.length, colSpan);
          html += rows.map(rowHtml).join('');
        }
      } else {
        html += b.rows.map(rowHtml).join('');
      }
    }
    return html;
  }

  function renderLeaderboard() {
    const elo = state.elo;
    const $card = document.getElementById('section-vtsr');
    const $empty = document.getElementById('elo-leaderboard-empty');
    if (!$card) return;

    if (!elo || !Array.isArray(elo.ratings) || elo.ratings.length === 0) {
      $card.classList.add('d-none');
      if ($empty) $empty.classList.remove('d-none');
      return;
    }
    if ($empty) $empty.classList.add('d-none');
    $card.classList.remove('d-none');

    // Rating uncertainty (plain words in the rating tooltip; the rigorous
    // treatment lives on the How / Does-it-work tabs).
    const noiseSigma = ratingNoiseSigma();

    _vtsrCareerStats = state.careerStats || [];

    const minMatches = vtsrLadderMinMatches(elo);
    const win = inactivityWindowDays(elo);
    const need = comebackGamesRequired(elo);
    const $banner = document.getElementById('vtsr-ladder-banner');
    if ($banner) {
      $banner.innerHTML = `<div class="alert alert-secondary py-2 px-3 mb-3 small">
        VSR-T is a performance rating, not a win/loss Elo. It moves when you play better or worse than expected, and winning the game does not move it.
      </div>`;
    }

    const ratings = elo.ratings;
    const sorter = vtsrSort(vtsrSortState.key, vtsrSortState.asc);
    const ranked = ratings.filter(r => vtsrLadderEligible(r, elo)).slice().sort(sorter);
    const unranked = ratings.filter(r => !vtsrLadderEligible(r, elo)).slice().sort(sorter);

    const tbody = $card.querySelector('#vtsr-table tbody');
    tbody.innerHTML = renderVtsrGroupedRows(ranked, elo, noiseSigma);

    const $unrankedWrap = document.getElementById('vtsr-unranked-wrap');
    if ($unrankedWrap) {
      if (unranked.length) {
        const thead = document.querySelector('#vtsr-table thead');
        const theadHtml = thead ? thead.outerHTML : '';
        $unrankedWrap.innerHTML = `<div class="vt-vtsr-unranked">
          <h6 class="vt-vtsr-unranked-title">Not on the ladder yet</h6>
          <p class="vt-vtsr-unranked-blurb">Need ${fmt(minMatches)} rated matches, and a game within ${fmt(win)} days of the newest match (or ${fmt(need)} games after returning), to appear on the ladder.</p>
          <table id="vtsr-unranked-table" class="table table-hover align-middle mb-2" style="font-size: 0.85rem;">
            ${theadHtml}
            <tbody>${unranked.map(r => renderVtsrLadderRow(r, elo, {
              noiseSigma,
              showProgress: true,
            })).join('')}</tbody>
          </table>
        </div>`;
      } else {
        $unrankedWrap.replaceChildren();
      }
    }

    // Track expand/collapse on the persistent card body (covers both
    // tables; survives sort re-renders).
    const $body = document.getElementById('vtsr-card-body') || $card;
    if (!$body.dataset.vtCollapseListenersBound) {
      $body.dataset.vtCollapseListenersBound = '1';
      $body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.add(id.slice('vtsr-detail-'.length));
      });
      $body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-detail-')) expandedVtsrRows.delete(id.slice('vtsr-detail-'.length));
      });
    }

    // Shared column sort drives both tables.
    $card.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === vtsrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (vtsrSortState.key === th.dataset.sort) vtsrSortState.asc = !vtsrSortState.asc;
        else { vtsrSortState.key = th.dataset.sort; vtsrSortState.asc = th.dataset.sort === 'name'; }
        renderLeaderboard();
      };
    });

    ensureTooltips($card);
  }

  // ----------------------------------------------------------------------
  // VSR-C commander ladder (experimental). Separate ladder from VSR-T:
  // outcome-pure win/loss ELO between the two commanders of every
  // determined match, with a team-strength handicap in the expected
  // score. 404-safe (card hidden when elo_commander_current.json is
  // absent).
  // ----------------------------------------------------------------------

  // Friendly labels for the VSR-C economy axes (mirror of the frozen
  // formulas in critique/decisions/vtsr-c-v2-composite.md, 2026-10-23).
  // Every axis is measured across the whole game.
  const CMDR_ECON_AXIS_META = {
    pool_lead:              { label: 'Pools held',          desc: 'Average number of pools held across the whole game.' },
    non_green_share:        { label: 'Time out of green',   desc: 'Share of time the scrap bank sat in red or yellow, while the recycler was alive. Green is the slow band (1/3 scrap a second, nothing at the cap), so less green is better.' },
    combat_conversion:      { label: 'Real-ship spending',  desc: 'Scrap spent on combat ships, as a share of scrap earned. Empty scouts and empty Xypos do not count; pods, scavengers and constructor builds never do.' },
    upgrade_time:           { label: 'Upgrades held',       desc: 'Average number of upgraded pools held across the whole game. Two upgrades kept all game beat two that were built earlier and then half lost.' },
    replacement_ratio:      { label: 'Ships per loss',      desc: 'Combat ships built per human ship lost, across the whole game. Shown, not scored: it mostly restates who was winning.' },
    replacement_ratio_real: { label: 'Real ships per loss', desc: 'The same, without empty scouts and empty Xypos among the ships built. Shown, not scored.' },
    loose_share:            { label: 'Loose share',         desc: 'Across the whole match, how much of the scrap earned was loose collected by scavengers. Shown, not scored. The recording sees the pickup, not how long the scrap sat on the ground.' },
  };

  const cmdrEconPct = (x) => `${Math.round(x * 100)}%`;
  const CMDR_ECON_VALUE_FMT = {
    pool_lead: (x) => x.toFixed(1),
    non_green_share: cmdrEconPct,
    combat_conversion: cmdrEconPct,
    upgrade_time: (x) => x.toFixed(1),
    replacement_ratio: (x) => x.toFixed(2),
    replacement_ratio_real: (x) => x.toFixed(2),
    loose_share: cmdrEconPct,
  };

  /** All duels involving one commander, newest first, each tagged with
      their side. Empty when elo_commander_history.json is absent. */
  function cmdrDuelsFor(r) {
    const duels = (state.cmdrHistory && state.cmdrHistory.duels) || [];
    const sid = String(r.steam64 || '');
    const out = [];
    for (const duel of duels) {
      const sides = duel.commanders || {};
      for (const sideKey of ['1', '2']) {
        const side = sides[sideKey];
        if (!side) continue;
        const match = sid
          ? String(side.steam64 || '') === sid
          : (side.name || '') === (r.name || '');
        if (match) out.push({ duel, side: Number(sideKey) });
      }
    }
    out.reverse(); // history is chronological; newest first for display
    return out;
  }

  /** Expandable detail panel for one VSR-C ladder row: duel log (last 5)
      + the most recent telemetry duel's econ-axis breakdown (v2). */
  function renderCmdrDetail(r) {
    const entries = cmdrDuelsFor(r);
    if (!entries.length) {
      return `<div class="text-muted small p-2">
        Match-by-match detail unavailable (elo_commander_history.json missing).
      </div>`;
    }

    const duelRows = entries.slice(0, 5).map(({ duel, side }) => {
      const me = duel.commanders[String(side)] || {};
      const opp = duel.commanders[String(3 - side)] || {};
      const res = me.score === 1 ? 'W' : me.score === 0 ? 'L' : 'D';
      const resCls = me.score === 1 ? 'vt-vtsr-delta-positive'
        : me.score === 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const d = me.delta || 0;
      const dCls = d > 0 ? 'vt-vtsr-delta-positive' : d < 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const th = duel.team_handicap || {};
      const myThugDiff = (th.diff != null) ? (side === 1 ? th.diff : -th.diff) : null;
      const ce = state.cmdrElo || {};
      const thugShift = myThugDiff == null ? null
        : VTSRDisplay.gapToWinShift(myThugDiff, ce.lambda_team_handicap, ce.logistic_scale);
      const thugShiftStr = thugShift == null ? '\u2014' : VTSRDisplay.winShiftText(thugShift);
      const thugTip = thugShift == null ? ''
        : `How much this commander's thugs, compared with the opponent's, moved the win chance on their own (${thugShiftStr}). The expected score already credits or discounts this.`;
      const telem = (duel.performance || {}).available
        ? `<span class="badge vt-cmdr-telem-chip" data-bs-toggle="tooltip" data-bs-placement="top"
             title="This match carried proto v4 economy telemetry — its econ composite is recorded (inert while \u03b1_c = 1).">v4</span>`
        : '';
      // v3: external community-ledger duels carry source "f9" and no
      // match id — tag them instead of pretending they were recorded.
      const community = duel.source === 'f9'
        ? `<span class="vt-f9-chip" data-bs-toggle="tooltip" data-bs-placement="top"
             title="F9Stats match from F9bomber's ledger (f9bomber.com)${duel.map ? ' \u2014 ' + esc(duel.map) : ''}.">F9Stats</span>`
        : '';
      return `<tr>
        <td class="text-muted">${esc(String(duel.date || '').slice(0, 10))}</td>
        <td>vs ${playerLinkHtml(opp.name || '?', opp.steam64)} ${telem}${community}</td>
        <td class="text-center ${resCls} fw-semibold">${res}</td>
        <td class="text-end ${dCls}">${d > 0 ? '+' : ''}${(d || 0).toFixed(1)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Pre-match win probability from rating + team-strength handicap.">${((me.expected || 0) * 100).toFixed(0)}%</td>
        <td class="text-end text-muted" data-bs-toggle="tooltip" data-bs-placement="top"
            title="${esc(thugTip)}">${thugShiftStr}</td>
      </tr>`;
    }).join('');

    // Most recent telemetry duel involving this commander -> axis bars.
    let econHtml = '';
    const telemEntry = entries.find(e => (e.duel.performance || {}).available);
    if (telemEntry) {
      const perf = telemEntry.duel.performance;
      const sign = telemEntry.side === 1 ? 1 : -1;
      const axisRows = Object.entries(perf.axes || {}).map(([axis, a]) => {
        const z = sign * (a.z || 0);
        const cls = z > 0 ? 'is-positive' : z < 0 ? 'is-negative' : '';
        const widthPct = Math.min(100, Math.abs(z) * 100);
        const fillStyle = z >= 0
          ? `left:50%; width:${(widthPct / 2).toFixed(2)}%;`
          : `right:50%; width:${(widthPct / 2).toFixed(2)}%;`;
        const meta = CMDR_ECON_AXIS_META[axis] || { label: axis, desc: '' };
        const unscored = a.weight === 0;
        const label = unscored ? `${meta.label} (not scored)` : meta.label;
        const vals = a.values || {};
        const fmt = CMDR_ECON_VALUE_FMT[axis];
        const mine = vals[String(telemEntry.side)];
        const theirs = vals[String(3 - telemEntry.side)];
        const hasVals = fmt && typeof mine === 'number' && typeof theirs === 'number';
        const valueTxt = hasVals ? ` This commander ${fmt(mine)}, opponent ${fmt(theirs)}.` : '';
        const valueChip = hasVals
          ? `<span class="vt-axis-bar-weighted">${esc(fmt(mine))} vs ${esc(fmt(theirs))}</span>` : '';
        return `<div class="vt-axis-bar-row ${cls}"
                     data-bs-toggle="tooltip" data-bs-placement="top"
                     title="${esc(meta.desc)}${esc(valueTxt)} Differential z vs the opposing commander: ${z >= 0 ? '+' : ''}${z.toFixed(2)}">
          <span class="vt-axis-bar-name">${esc(label)}</span>
          <span class="vt-axis-bar-track">
            <span class="vt-axis-bar-center"></span>
            <span class="vt-axis-bar-fill" style="${fillStyle}"></span>
          </span>
          <span class="vt-axis-bar-z">${z >= 0 ? '+' : ''}${z.toFixed(2)}${valueChip}</span>
        </div>`;
      }).join('');
      const p = sign * (perf.p || 0);
      econHtml = `<section class="vt-vtsr-detail-section">
        <h6>Latest econ telemetry <span class="vt-vtsr-detail-sub text-muted">(${esc(String(telemEntry.duel.date || '').slice(0, 10))} &middot; composite P = ${p >= 0 ? '+' : ''}${p.toFixed(2)} &middot; recorded, not yet scored — \u03b1_c = 1)</span></h6>
        <div class="vt-axis-bar-grid">${axisRows}</div>
      </section>`;
    }

    const telemCount = r.duels_with_telemetry || 0;
    const extCount = r.duels_external || 0;
    const extStat = extCount > 0
      ? `<div data-bs-toggle="tooltip" data-bs-placement="top"
             title="Matches from F9bomber's hand-kept community ledger — rated at the same K, counted in the record."><span class="vt-stat-label">F9Stats</span><span class="vt-stat-value">${extCount} match${extCount === 1 ? '' : 'es'}</span></div>`
      : '';
    const statsHtml = `<section class="vt-vtsr-detail-section">
      <h6>Commander record</h6>
      <div class="vt-vtsr-detail-stats">
        <div><span class="vt-stat-label">Record</span><span class="vt-stat-value">${r.wins}-${r.losses}-${r.draws}</span></div>
        <div><span class="vt-stat-label">Peak</span><span class="vt-stat-value">${Math.round(r.peak_vtsr_c || r.vtsr_c)}</span></div>
        <div><span class="vt-stat-label">Rated games</span><span class="vt-stat-value">${r.matches_commanded_rated}</span></div>
        <div><span class="vt-stat-label">v4 telemetry</span><span class="vt-stat-value">${telemCount} match${telemCount === 1 ? '' : 'es'}</span></div>
        ${extStat}
      </div>
    </section>`;

    const logHtml = `<section class="vt-vtsr-detail-section">
      <h6>Match log <span class="vt-vtsr-detail-sub text-muted">(most recent ${Math.min(5, entries.length)})</span></h6>
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0" style="font-size: 0.8rem;">
          <thead><tr>
            <th>Date</th><th>Opponent</th><th class="text-center">Result</th>
            <th class="text-end">\u0394</th>
            <th class="text-end">Expected</th>
            <th class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
                title="How much this commander's thugs moved the win chance compared with the opponent's (the handicap input).">Thug edge</th>
          </tr></thead>
          <tbody>${duelRows}</tbody>
        </table>
      </div>
    </section>`;

    return `<div class="vt-vtsr-detail-body">${statsHtml}${econHtml}${logHtml}</div>`;
  }

  let cmdrSortState = { key: 'vtsr_c', asc: false };
  const expandedCmdrRows = new Set();

  // Display-only ladder-gate fallbacks. Live values come from
  // elo_commander_current.json `leaderboard_min_*` (schema 4).
  // Mirrors scripts/elo_commander.py CMDR_LADDER_MIN_V4 / _NON_V4.
  const CMDR_LADDER_MIN_V4_FALLBACK = 8;
  const CMDR_LADDER_MIN_NON_V4_FALLBACK = 25;

  function cmdrLadderMins(c) {
    return {
      minV4: (c && c.leaderboard_min_v4 != null) ? c.leaderboard_min_v4 : CMDR_LADDER_MIN_V4_FALLBACK,
      minNonV4: (c && c.leaderboard_min_non_v4 != null) ? c.leaderboard_min_non_v4 : CMDR_LADDER_MIN_NON_V4_FALLBACK,
    };
  }

  function cmdrDuelsNonV4(r) {
    if (typeof r.duels_non_v4 === 'number') return r.duels_non_v4;
    return Math.max(0, (r.matches_commanded_rated || 0) - (r.duels_with_telemetry || 0));
  }

  function cmdrLadderEligible(r, c) {
    if (typeof r.leaderboard_eligible === 'boolean') return r.leaderboard_eligible;
    const { minV4, minNonV4 } = cmdrLadderMins(c);
    return (r.duels_with_telemetry || 0) >= minV4 || cmdrDuelsNonV4(r) >= minNonV4;
  }

  function cmdrProgressChipHtml(r, c) {
    const need = comebackGamesRequired(c);
    const gStatus = r.inactive_status || 'active';
    if (gStatus === 'inactive') {
      const d = r.days_since_last_match || 0;
      const win = inactivityWindowDays(c);
      const seen = r.last_seen_date;
      const label = seen ? `Inactive \u00b7 ${d}d ago` : 'Inactive';
      const title = seen
        ? `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match. Play ${need} games within ${win} days to rejoin.`
        : `No recorded appearance in the corpus or community ledger. Play ${need} games within ${win} days to join.`;
      return statusChipHtml('vt-vtsr-inactive-chip', label, title);
    }
    if (gStatus === 'returning') {
      const n = r.comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need}`,
        `${n} of ${need} games since returning. Play ${Math.max(0, need - n)} more to rejoin the ranked ladder.`
      );
    }
    const cStatus = r.command_status || 'active';
    if (cStatus === 'stale') {
      const d = r.days_since_last_command || 0;
      const staleWin = commandStaleWindowDays(c);
      return statusChipHtml(
        'vt-vtsr-stale-chip',
        `Not commanded \u00b7 ${d}d`,
        `Last commanded ${d} day${d === 1 ? '' : 's'} ago (grace is ${staleWin} days while still playing as a thug). Command ${need} games to rejoin the commander ladder.`
      );
    }
    if (cStatus === 'returning') {
      const n = r.command_comeback_games_played || 0;
      return statusChipHtml(
        'vt-vtsr-returning-chip',
        `Returning \u00b7 ${n} of ${need} cmdr games`,
        `${n} of ${need} commander games since the command clock reset. Command ${Math.max(0, need - n)} more to rejoin.`
      );
    }
    const { minV4, minNonV4 } = cmdrLadderMins(c);
    const v4 = r.duels_with_telemetry || 0;
    const older = cmdrDuelsNonV4(r);
    const title = `${v4} of ${minV4} proto-v4 commander games, or ${older} of ${minNonV4} older games (pre-v4 recordings and F9Stats) to join the ranked ladder.`;
    return statusChipHtml('vt-cmdr-progress-chip', `${v4} / ${minV4} v4 \u00b7 ${older} older`, title);
  }

  function cmdrRowKey(r) {
    const raw = r.steam64 || r.name || '';
    return String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function cmdrSort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':                     va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'record':                   va = (a.wins || 0) - (a.losses || 0); vb = (b.wins || 0) - (b.losses || 0); break;
        case 'win_pct':                  va = a.win_pct || 0;              vb = b.win_pct || 0;              break;
        case 'matches_commanded_rated': va = a.matches_commanded_rated || 0; vb = b.matches_commanded_rated || 0; break;
        case 'peak_vtsr_c':             va = a.peak_vtsr_c || 0;            vb = b.peak_vtsr_c || 0;            break;
        case 'last_delta':              va = a.last_delta || 0;             vb = b.last_delta || 0;             break;
        case 'vtsr_c':
        default:                         va = a.vtsr_c || 0;               vb = b.vtsr_c || 0;               break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    };
  }

  function renderCmdrLadderRow(r, c, rank) {
    const rowKey = cmdrRowKey(r);
    const expanded = expandedCmdrRows.has(rowKey);
    const prov = r.provisional
      ? ` <span class="vt-vtsr-provisional" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Provisional — fewer than ${c.provisional_threshold ?? 5} rated commander games.">?</span>`
      : '';
    const record = `${r.wins}-${r.losses}-${r.draws}`;
    const lastDelta = r.last_delta || 0;
    const lastClass = lastDelta > 0 ? 'text-success' : (lastDelta < 0 ? 'text-danger' : 'text-muted');
    const lastSign = lastDelta > 0 ? '+' : '';
    const peakTip = r.peak_date ? `Reached ${String(r.peak_date).slice(0, 10)}` : '';
    const detailId = `vtsr-c-detail-${rowKey}`;
    const telemChip = (r.duels_with_telemetry || 0) > 0
      ? ` <span class="badge vt-cmdr-telem-chip" data-bs-toggle="tooltip" data-bs-placement="top"
            title="${r.duels_with_telemetry} duel${r.duels_with_telemetry === 1 ? '' : 's'} with proto v4 economy telemetry.">v4\u00d7${r.duels_with_telemetry}</span>`
      : '';
    const progressChip = rank == null ? cmdrProgressChipHtml(r, c) : '';
    const rankCell = rank == null
      ? '<td class="text-muted">\u2014</td>'
      : `<td class="text-muted">${rank}</td>`;
    return `<tr>
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle commander details">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      ${rankCell}
      <td class="fw-semibold">${playerLinkHtml(r.name, r.steam64)}${prov}${telemChip}${progressChip}</td>
      <td class="text-end vt-vtsr-rating">${Math.round(r.vtsr_c)}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
          title="Wins-Losses-Draws across rated commander games.">${record}</td>
      <td class="text-end">${((r.win_pct || 0) * 100).toFixed(0)}%</td>
      <td class="text-end"${(r.duels_external || 0) > 0
        ? ` data-bs-toggle="tooltip" data-bs-placement="top" title="${r.duels_external} of these games came from F9bomber's match records"`
        : ''}>${r.matches_commanded_rated}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(peakTip)}">${Math.round(r.peak_vtsr_c || r.vtsr_c)}</td>
      <td class="text-end ${lastClass}">${lastSign}${lastDelta.toFixed(1)}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="9">${renderCmdrDetail(r)}</td>
    </tr>`;
  }

  function renderCmdrTableHtml(tableId, tbodyId, rows, c, ranked) {
    const bodyRows = rows.map((r, i) => renderCmdrLadderRow(r, c, ranked ? i + 1 : null)).join('');
    return `<div class="table-responsive">
      <table id="${tableId}" class="table table-hover align-middle mb-2" style="font-size: 0.85rem;">
        <thead>
          <tr>
            <th class="vt-vtsr-expand-col"></th>
            <th>#</th>
            <th data-sort="name">Commander</th>
            <th data-sort="vtsr_c" class="text-end${cmdrSortState.key === 'vtsr_c' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top" data-bs-html="true"
                title="<strong>VSR-C</strong><br>Commander rating. Classic win/loss ELO (anchor 1500, scale 400, symmetric K 40&rarr;20) with a team-strength handicap in the expected score.">VSR-C</th>
            <th data-sort="record" class="text-end${cmdrSortState.key === 'record' ? ' sort-active' : ''}">Record</th>
            <th data-sort="win_pct" class="text-end${cmdrSortState.key === 'win_pct' ? ' sort-active' : ''}">Win %</th>
            <th data-sort="matches_commanded_rated" class="text-end${cmdrSortState.key === 'matches_commanded_rated' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top"
                title="Rated commander games (matches with a verified outcome where this player led a team).">Games</th>
            <th data-sort="peak_vtsr_c" class="text-end${cmdrSortState.key === 'peak_vtsr_c' ? ' sort-active' : ''}">Peak</th>
            <th data-sort="last_delta" class="text-end${cmdrSortState.key === 'last_delta' ? ' sort-active' : ''}" data-bs-toggle="tooltip" data-bs-placement="top"
                title="Most recent rated-duel rating change.">Last</th>
          </tr>
        </thead>
        <tbody id="${tbodyId}">${bodyRows}</tbody>
      </table>
    </div>`;
  }

  // The VSR-C pill is a sortable table (mirrors the VSR-T pane); the
  // ladder's explainer lives on the How-it-works pill. Lazy first paint
  // like the explainer tabs — sort clicks re-call this directly.
  // Ranked vs Unranked is a display split (schema 4 eligibility flag);
  // ratings themselves are unchanged.
  function renderCommanderLadder() {
    const card = document.getElementById('section-vtsr-c');
    const body = document.getElementById('vtsr-c-body');
    const $empty = document.getElementById('elo-vtsr-c-empty');
    if (!card || !body) return;
    const c = state.cmdrElo;
    const ratings = (c && Array.isArray(c.ratings)) ? c.ratings : [];
    if (!ratings.length) {
      card.classList.add('d-none');
      if ($empty) $empty.classList.remove('d-none');
      const $credit = document.getElementById('vtsr-c-f9-credit');
      if ($credit) { $credit.replaceChildren(); $credit.hidden = true; }
      return;
    }
    if ($empty) $empty.classList.add('d-none');
    card.classList.remove('d-none');

    const { minV4, minNonV4 } = cmdrLadderMins(c);
    const provN = c.provisional_threshold ?? 5;
    const win = inactivityWindowDays(c);
    const need = comebackGamesRequired(c);
    const staleWin = commandStaleWindowDays(c);
    const banner = `<div class="alert alert-secondary py-2 px-3 mb-3 small">
      Winning with a weaker group of thugs raises the rating more than winning with a stronger one.
      Ranked commanders have at least ${fmt(minV4)} proto-v4 games or ${fmt(minNonV4)} older games (pre-v4 recordings and F9Stats),
      have played within ${fmt(win)} days of the newest match, and have commanded within ${fmt(staleWin)} days
      (or ${fmt(need)} commander games after going stale).
      Commanders with fewer than ${fmt(provN)} rated games are still settling in.
    </div>`;

    const sorter = cmdrSort(cmdrSortState.key, cmdrSortState.asc);
    const ranked = ratings.filter(r => cmdrLadderEligible(r, c)).slice().sort(sorter);
    const unranked = ratings.filter(r => !cmdrLadderEligible(r, c)).slice().sort(sorter);

    const unrankedHtml = unranked.length
      ? `<div class="vt-vtsr-c-unranked">
          <h6 class="vt-vtsr-c-unranked-title">Unranked</h6>
          <p class="vt-vtsr-c-unranked-blurb">Need ${fmt(minV4)} proto-v4 commander games or ${fmt(minNonV4)} older games (pre-v4 recordings and F9Stats), a game within ${fmt(win)} days of the newest match, and a command game within ${fmt(staleWin)} days (or ${fmt(need)} commander games after the ${fmt(staleWin)}-day grace while still thugging). No rank is assigned here.</p>
          ${renderCmdrTableHtml('vtsr-c-unranked-table', 'vtsr-c-unranked-tbody', unranked, c, false)}
        </div>`
      : '';

    body.innerHTML = `${banner}
      ${renderCmdrTableHtml('vtsr-c-table', 'vtsr-c-tbody', ranked, c, true)}
      ${unrankedHtml}
      <p class="text-muted small mb-0">
        Matches with no recorded winner, and draws, are not rated.
      </p>`;

    const $credit = document.getElementById('vtsr-c-f9-credit');
    if ($credit) {
      if ((c.external_duels_rated || 0) > 0) {
        const prov = c.external_provider || {};
        $credit.innerHTML = `Includes ${fmt(c.external_duels_rated)} games from
             <a href="#vtsr-c-f9-modal" data-bs-toggle="modal" data-bs-target="#vtsr-c-f9-modal">${esc(prov.name || 'F9bomber')}</a>.`;
        $credit.hidden = false;
      } else {
        $credit.replaceChildren();
        $credit.hidden = true;
      }
    }

    // Track expand/collapse on the persistent card body (covers both
    // tables; survives sort re-renders).
    if (!body.dataset.vtCollapseListenersBound) {
      body.dataset.vtCollapseListenersBound = '1';
      body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-c-detail-')) expandedCmdrRows.add(id.slice('vtsr-c-detail-'.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'true');
      });
      body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith('vtsr-c-detail-')) expandedCmdrRows.delete(id.slice('vtsr-c-detail-'.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }

    card.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === cmdrSortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (cmdrSortState.key === th.dataset.sort) cmdrSortState.asc = !cmdrSortState.asc;
        else { cmdrSortState.key = th.dataset.sort; cmdrSortState.asc = false; }
        renderCommanderLadder();
      };
    });

    ensureTooltips(card);
  }

  // ----------------------------------------------------------------------
  // 1v1 ladder (VSR-1v1). Same Ranked / Unranked split and expandable
  // rows as VSR-C; no handicap, no telemetry chips, no F9 games.
  // ----------------------------------------------------------------------

  let v1SortState = { key: 'rating', asc: false };
  const expandedV1Rows = new Set();
  const V1_LADDER_MIN_GAMES_FALLBACK = 5;

  function v1LadderMinGames(c) {
    return (c && c.leaderboard_min_games != null) ? c.leaderboard_min_games : V1_LADDER_MIN_GAMES_FALLBACK;
  }

  function v1DuelsFor(r) {
    const duels = (state.v1History && state.v1History.duels) || [];
    const sid = String(r.steam64 || '');
    const out = [];
    for (const duel of duels) {
      for (const sideKey of ['1', '2']) {
        const side = (duel.players || {})[sideKey];
        if (!side) continue;
        const match = sid ? String(side.steam64 || '') === sid : (side.name || '') === (r.name || '');
        if (match) out.push({ duel, side: Number(sideKey) });
      }
    }
    out.reverse();
    return out;
  }

  function renderV1Detail(r) {
    const entries = v1DuelsFor(r);
    if (!entries.length) {
      return `<div class="text-muted small p-2">
        Game-by-game detail unavailable (elo_1v1_history.json missing).
      </div>`;
    }
    const rows = entries.map(({ duel, side }) => {
      const me = duel.players[String(side)] || {};
      const opp = duel.players[String(3 - side)] || {};
      const res = me.score === 1 ? 'W' : me.score === 0 ? 'L' : 'D';
      const resCls = me.score === 1 ? 'vt-vtsr-delta-positive'
        : me.score === 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const d = me.delta || 0;
      const dCls = d > 0 ? 'vt-vtsr-delta-positive' : d < 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      const facs = duel.factions || {};
      const myFac = facs[String(side)] || '?';
      const oppFac = facs[String(3 - side)] || '?';
      const matchLink = duel.match_id
        ? `<a href="../matches/?match=${encodeURIComponent(duel.match_id)}" class="text-muted"
              title="Open this match on the dashboard" aria-label="Open this match on the dashboard"><i class="bi bi-box-arrow-up-right"></i></a>`
        : '';
      return `<tr>
        <td class="text-muted">${esc(String(duel.date || '').slice(0, 10))}</td>
        <td>vs ${playerLinkHtml(opp.name || '?', opp.steam64)}</td>
        <td>${esc(duel.map || '')}</td>
        <td class="text-muted">${esc(myFac)} v ${esc(oppFac)}</td>
        <td class="text-center ${resCls} fw-semibold">${res}</td>
        <td class="text-end ${dCls}">${d > 0 ? '+' : ''}${d.toFixed(1)}</td>
        <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Pre-match win probability from the two ratings.">${((me.expected || 0) * 100).toFixed(0)}%</td>
        <td class="text-end">${matchLink}</td>
      </tr>`;
    }).join('');
    return `<div class="vt-vtsr-detail-body">
      <section class="vt-vtsr-detail-section">
        <h6>1v1 record</h6>
        <div class="vt-vtsr-detail-stats">
          <div><span class="vt-stat-label">Record</span><span class="vt-stat-value">${r.wins}-${r.losses}-${r.draws}</span></div>
          <div><span class="vt-stat-label">Peak</span><span class="vt-stat-value">${Math.round(r.peak || r.rating)}</span></div>
          <div><span class="vt-stat-label">Rated 1v1s</span><span class="vt-stat-value">${r.games}</span></div>
        </div>
      </section>
      <section class="vt-vtsr-detail-section">
        <h6>Game log</h6>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0" style="font-size: 0.8rem;">
            <thead><tr>
              <th>Date</th><th>Opponent</th><th>Map</th><th>Factions</th>
              <th class="text-center">Result</th><th class="text-end">\u0394</th>
              <th class="text-end">Expected</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>`;
  }

  function v1ProgressChipHtml(r, c) {
    const status = r.inactive_status || 'active';
    const need = comebackGamesRequired(c);
    const win = inactivityWindowDays(c);
    if (status === 'inactive') {
      const d = r.days_since_last_match || 0;
      return statusChipHtml('vt-vtsr-inactive-chip', `Inactive \u00b7 ${d}d ago`,
        `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match. Play ${need} games within ${win} days to rejoin.`);
    }
    if (status === 'returning') {
      return statusChipHtml('vt-vtsr-returning-chip', 'Returning',
        `Play ${r.comeback_games_remaining || 0} more game${(r.comeback_games_remaining || 0) === 1 ? '' : 's'} of any kind to rejoin.`);
    }
    const min = v1LadderMinGames(c);
    return statusChipHtml('vt-cmdr-progress-chip', `${r.games} / ${min} 1v1s`,
      `${r.games} of ${min} rated 1v1s to join the ranked table.`);
  }

  function v1Sort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':   va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'record': va = (a.wins || 0) - (a.losses || 0); vb = (b.wins || 0) - (b.losses || 0); break;
        case 'win_pct': va = a.win_pct || 0; vb = b.win_pct || 0; break;
        case 'games':  va = a.games || 0; vb = b.games || 0; break;
        case 'peak':   va = a.peak || 0; vb = b.peak || 0; break;
        case 'last_1v1_date': va = a.last_1v1_date || ''; vb = b.last_1v1_date || ''; break;
        case 'rating':
        default:       va = a.rating || 0; vb = b.rating || 0; break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    };
  }

  function renderV1Row(r, c, rank) {
    const rowKey = cmdrRowKey(r);
    const expanded = expandedV1Rows.has(rowKey);
    const detailId = `vtsr-1v1-detail-${rowKey}`;
    const prov = r.provisional
      ? ` <span class="vt-vtsr-provisional" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Provisional \u2014 fewer than ${c.provisional_threshold ?? 5} rated 1v1s.">?</span>`
      : '';
    const chip = rank == null ? v1ProgressChipHtml(r, c) : '';
    const peakTip = r.peak_date ? `Reached ${String(r.peak_date).slice(0, 10)}` : '';
    return `<tr>
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle 1v1 game log">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      <td class="text-muted">${rank == null ? '\u2014' : rank}</td>
      <td class="fw-semibold">${playerLinkHtml(r.name, r.steam64)}${prov}${chip}</td>
      <td class="text-end vt-vtsr-rating">${Math.round(r.rating)}</td>
      <td class="text-end">${r.wins}-${r.losses}-${r.draws}</td>
      <td class="text-end">${((r.win_pct || 0) * 100).toFixed(0)}%</td>
      <td class="text-end">${r.games}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(peakTip)}">${Math.round(r.peak || r.rating)}</td>
      <td class="text-end text-muted">${esc(r.last_1v1_date || '\u2014')}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="9">${renderV1Detail(r)}</td>
    </tr>`;
  }

  function renderV1TableHtml(tableId, rows, c, ranked) {
    const th = (key, label, extra = '') =>
      `<th data-sort="${key}" class="text-end${v1SortState.key === key ? ' sort-active' : ''}"${extra}>${label}</th>`;
    const body = rows.map((r, i) => renderV1Row(r, c, ranked ? i + 1 : null)).join('');
    return `<div class="table-responsive">
      <table id="${tableId}" class="table table-hover align-middle mb-2" style="font-size: 0.85rem;">
        <thead><tr>
          <th class="vt-vtsr-expand-col"></th>
          <th>#</th>
          <th data-sort="name">Player</th>
          ${th('rating', 'Rating', ` data-bs-toggle="tooltip" data-bs-placement="top" title="VSR-1v1: plain win/loss Elo over recorded 1v1s (anchor 1500, scale 400, shared K 40 to 20)."`)}
          ${th('record', 'W-L-D')}
          ${th('win_pct', 'Win %')}
          ${th('games', 'Games')}
          ${th('peak', 'Peak')}
          ${th('last_1v1_date', 'Last 1v1')}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  function render1v1Ladder() {
    const card = document.getElementById('section-vtsr-1v1');
    const body = document.getElementById('vtsr-1v1-body');
    const $empty = document.getElementById('elo-vtsr-1v1-empty');
    if (!card || !body) return;
    const c = state.v1Elo;
    const ratings = (c && Array.isArray(c.ratings)) ? c.ratings : [];
    if (!ratings.length) {
      card.classList.add('d-none');
      if ($empty) $empty.classList.remove('d-none');
      return;
    }
    if ($empty) $empty.classList.add('d-none');
    card.classList.remove('d-none');

    const min = v1LadderMinGames(c);
    const win = inactivityWindowDays(c);
    const provN = c.provisional_threshold ?? 5;
    const sorter = v1Sort(v1SortState.key, v1SortState.asc);
    const ranked = ratings.filter(r => r.leaderboard_eligible).slice().sort(sorter);
    const unranked = ratings.filter(r => !r.leaderboard_eligible).slice().sort(sorter);

    const banner = `<div class="alert alert-secondary py-2 px-3 mb-3 small">
      Head-to-head games only: one player on each side, both commanding. Plain Elo, no thug handicap,
      and separate from VSR-C and VSR-T. Ranked players have at least ${fmt(min)} rated 1v1s and a game
      of any kind within ${fmt(win)} days of the newest match. Players with fewer than ${fmt(provN)} rated
      1v1s are still settling in.
    </div>`;
    const rankedHtml = ranked.length
      ? renderV1TableHtml('vtsr-1v1-table', ranked, c, true)
      : `<p class="text-muted small">Nobody has ${fmt(min)} rated 1v1s yet.</p>`;
    const unrankedHtml = unranked.length
      ? `<div class="vt-vtsr-c-unranked">
          <h6 class="vt-vtsr-c-unranked-title">Unranked</h6>
          <p class="vt-vtsr-c-unranked-blurb">Need ${fmt(min)} rated 1v1s and a game within ${fmt(win)} days of the newest match. No rank is assigned here.</p>
          ${renderV1TableHtml('vtsr-1v1-unranked-table', unranked, c, false)}
        </div>`
      : '';

    body.innerHTML = `${banner}
      ${rankedHtml}
      ${unrankedHtml}`;

    if (!body.dataset.vtCollapseListenersBound) {
      body.dataset.vtCollapseListenersBound = '1';
      const prefix = 'vtsr-1v1-detail-';
      body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith(prefix)) expandedV1Rows.add(id.slice(prefix.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'true');
      });
      body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith(prefix)) expandedV1Rows.delete(id.slice(prefix.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }

    card.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('sort-active', th.dataset.sort === v1SortState.key);
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (v1SortState.key === th.dataset.sort) v1SortState.asc = !v1SortState.asc;
        else { v1SortState.key = th.dataset.sort; v1SortState.asc = false; }
        render1v1Ladder();
      };
    });
    ensureTooltips(card);
  }

  // ----------------------------------------------------------------------
  // 2v2 ladders (VSR-2v2C + VSR-2v2T). Three ratings from
  // elo_2v2_current.json `ladders`: commander (win/loss), thug_wl
  // (win/loss, same walk) and thug_perf (thug-vs-thug damage duel).
  // ----------------------------------------------------------------------

  const V2_VIEWS = ['perf', 'wl', 'compare'];
  const V2_LADDER_FOR_VIEW = { perf: 'thug_perf', wl: 'thug_wl' };
  const v2SortState = {
    commander: { key: 'rating', asc: false },
    thug_wl: { key: 'rating', asc: false },
    thug_perf: { key: 'rating', asc: false },
    compare: { key: 'perf', asc: false },
  };
  const expandedV2Rows = new Set();
  let v2View = 'perf';

  function v2Ladder(name) {
    const l = state.v2Elo && state.v2Elo.ladders && state.v2Elo.ladders[name];
    return (l && Array.isArray(l.ratings)) ? l.ratings : [];
  }

  function v2Key(p) {
    return p && p.steam64 ? String(p.steam64) : `name:${(p && p.name) || ''}`;
  }

  // Game log rows for one player in one ladder, newest first.
  function v2GamesFor(r, ladder) {
    const games = (state.v2History && state.v2History.games) || [];
    const role = ladder === 'commander' ? 'commander' : 'thug';
    const field = ladder === 'thug_perf' ? 'perf' : 'wl';
    const k = v2Key(r);
    const out = [];
    for (const g of games) {
      if (!g[field]) continue;
      for (const s of ['1', '2']) {
        const me = (g.sides && g.sides[s] && g.sides[s][role]) || null;
        if (me && v2Key(me) === k) out.push({ g, side: s, me });
      }
    }
    return out.reverse();
  }

  function renderV2Detail(r, ladder) {
    const entries = v2GamesFor(r, ladder);
    if (!entries.length) {
      return '<div class="text-muted small p-2">Game-by-game detail unavailable (elo_2v2_history.json missing).</div>';
    }
    const perf = ladder === 'thug_perf';
    const role = ladder === 'commander' ? 'commander' : 'thug';
    const partnerRole = role === 'commander' ? 'thug' : 'commander';
    const rows = entries.map(({ g, side, me }) => {
      const opp = String(3 - Number(side));
      const sides = g.sides || {};
      const partner = (sides[side] || {})[partnerRole] || {};
      const oc = (sides[opp] || {}).commander || {};
      const ot = (sides[opp] || {}).thug || {};
      const blk = me[perf ? 'perf' : 'wl'] || {};
      const d = blk.delta || 0;
      const dCls = d > 0 ? 'vt-vtsr-delta-positive' : d < 0 ? 'vt-vtsr-delta-negative' : 'text-muted';
      let res = '\u2014';
      let resCls = 'text-muted';
      if (g.outcome === 'draw') res = 'D';
      else if (g.outcome) {
        const won = g.outcome === `team${side}`;
        res = won ? 'W' : 'L';
        resCls = won ? 'vt-vtsr-delta-positive' : 'vt-vtsr-delta-negative';
      }
      const exp = perf ? (g.perf.expected || {})[side] : (g.wl.expected || {})[side];
      const expCell = perf
        ? `<td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
              title="Damage share expected from the two thugs' ratings, then what happened.">${Math.round((exp || 0) * 100)}% &rarr; ${Math.round(((g.perf.score || {})[side] || 0) * 100)}%</td>`
        : `<td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top"
              title="Pre-game win chance from both commanders' and both thugs' 2v2 ratings.">${Math.round((exp || 0) * 100)}%</td>`;
      const link = g.match_id
        ? `<a href="../matches/?match=${encodeURIComponent(g.match_id)}" class="text-muted"
              title="Open this match on the dashboard" aria-label="Open this match on the dashboard"><i class="bi bi-box-arrow-up-right"></i></a>`
        : '';
      return `<tr>
        <td class="text-muted">${esc(String(g.date || '').slice(0, 10))}</td>
        <td>${playerLinkHtml(partner.name || '?', partner.steam64)}</td>
        <td>${playerLinkHtml(oc.name || '?', oc.steam64)} + ${playerLinkHtml(ot.name || '?', ot.steam64)}</td>
        <td>${esc(g.map || '')}</td>
        <td class="text-center ${resCls} fw-semibold">${res}</td>
        <td class="text-end ${dCls}">${d > 0 ? '+' : ''}${d.toFixed(1)}</td>
        ${expCell}
        <td class="text-end">${link}</td>
      </tr>`;
    }).join('');
    const statsHtml = perf
      ? `<div><span class="vt-stat-label">Beat expectation</span><span class="vt-stat-value">${r.beat_expected || 0} / ${r.games}</span></div>
         <div><span class="vt-stat-label">Avg damage share</span><span class="vt-stat-value">${r.mean_score != null ? Math.round(r.mean_score * 100) + '%' : '\u2014'}</span></div>`
      : `<div><span class="vt-stat-label">Record</span><span class="vt-stat-value">${r.wins}-${r.losses}-${r.draws}</span></div>`;
    return `<div class="vt-vtsr-detail-body">
      <section class="vt-vtsr-detail-section">
        <h6>2v2 summary</h6>
        <div class="vt-vtsr-detail-stats">
          ${statsHtml}
          <div><span class="vt-stat-label">Peak</span><span class="vt-stat-value">${Math.round(r.peak || r.rating)}</span></div>
          <div><span class="vt-stat-label">Rated games</span><span class="vt-stat-value">${r.games}</span></div>
        </div>
      </section>
      <section class="vt-vtsr-detail-section">
        <h6>Game log</h6>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0" style="font-size: 0.8rem;">
            <thead><tr>
              <th>Date</th><th>${role === 'commander' ? 'Thug' : 'Commander'}</th><th>Opponents</th><th>Map</th>
              <th class="text-center">Result</th><th class="text-end">\u0394</th>
              <th class="text-end">${perf ? 'Share: expected &rarr; actual' : 'Win chance'}</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    </div>`;
  }

  function v2ProgressChipHtml(r, c) {
    const status = r.inactive_status || 'active';
    const need = comebackGamesRequired(c);
    const win = inactivityWindowDays(c);
    if (status === 'inactive') {
      const d = r.days_since_last_match || 0;
      return statusChipHtml('vt-vtsr-inactive-chip', `Inactive \u00b7 ${d}d ago`,
        `Last seen ${d} day${d === 1 ? '' : 's'} before the newest match. Play ${need} games within ${win} days to rejoin.`);
    }
    if (status === 'returning') {
      return statusChipHtml('vt-vtsr-returning-chip', 'Returning',
        `Play ${r.comeback_games_remaining || 0} more game${(r.comeback_games_remaining || 0) === 1 ? '' : 's'} of any kind to rejoin.`);
    }
    const min = v1LadderMinGames(c);
    return statusChipHtml('vt-cmdr-progress-chip', `${r.games} / ${min} 2v2s`,
      `${r.games} of ${min} rated games on this ladder to join the ranked table.`);
  }

  function v2Sort(key, asc) {
    return (a, b) => {
      let va; let vb;
      switch (key) {
        case 'name':   va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); break;
        case 'record': va = (a.wins || 0) - (a.losses || 0); vb = (b.wins || 0) - (b.losses || 0); break;
        case 'win_pct': va = a.win_pct || 0; vb = b.win_pct || 0; break;
        case 'beat':   va = a.games ? (a.beat_expected || 0) / a.games : 0; vb = b.games ? (b.beat_expected || 0) / b.games : 0; break;
        case 'share':  va = a.mean_score || 0; vb = b.mean_score || 0; break;
        case 'games':  va = a.games || 0; vb = b.games || 0; break;
        case 'peak':   va = a.peak || 0; vb = b.peak || 0; break;
        case 'last':   va = a.last_2v2_date || ''; vb = b.last_2v2_date || ''; break;
        case 'rating':
        default:       va = a.rating || 0; vb = b.rating || 0; break;
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      const na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    };
  }

  const V2_RATING_TIPS = {
    commander: 'VSR-2v2C: win/loss Elo for 2v2 commanders. The win chance counts both commanders and both thugs (anchor 1500, scale 400, K 40 to 20).',
    thug_wl: 'VSR-2v2T (win/loss): the thug moves with the game result, in the same walk as the commanders.',
    thug_perf: 'VSR-2v2T (performance): each game is a duel between the two thugs over their share of the enemy damage. The result does not move it.',
  };

  function renderV2Row(r, c, rank, ladder) {
    const rowKey = `${ladder}-${cmdrRowKey(r)}`;
    const expanded = expandedV2Rows.has(rowKey);
    const detailId = `vtsr-2v2-detail-${rowKey}`;
    const prov = r.provisional
      ? ` <span class="vt-vtsr-provisional" data-bs-toggle="tooltip" data-bs-placement="top"
            title="Provisional \u2014 fewer than ${c.provisional_threshold ?? 5} rated games on this ladder.">?</span>`
      : '';
    const chip = rank == null ? v2ProgressChipHtml(r, c) : '';
    const peakTip = r.peak_date ? `Reached ${String(r.peak_date).slice(0, 10)}` : '';
    const mid = ladder === 'thug_perf'
      ? `<td class="text-end">${r.beat_expected || 0} / ${r.games}</td>
         <td class="text-end">${r.mean_score != null ? Math.round(r.mean_score * 100) + '%' : '\u2014'}</td>`
      : `<td class="text-end">${r.wins}-${r.losses}-${r.draws}</td>
         <td class="text-end">${r.win_pct != null ? Math.round(r.win_pct * 100) + '%' : '\u2014'}</td>`;
    return `<tr>
      <td class="vt-vtsr-expand-col">
        <button type="button" class="vt-row-expand"
                data-bs-toggle="collapse" data-bs-target="#${detailId}"
                aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${detailId}"
                aria-label="Toggle 2v2 game log">
          <i class="bi bi-chevron-right"></i>
        </button>
      </td>
      <td class="text-muted">${rank == null ? '\u2014' : rank}</td>
      <td class="fw-semibold">${playerLinkHtml(r.name, r.steam64)}${prov}${chip}</td>
      <td class="text-end vt-vtsr-rating">${Math.round(r.rating)}</td>
      ${mid}
      <td class="text-end">${r.games}</td>
      <td class="text-end" data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(peakTip)}">${Math.round(r.peak || r.rating)}</td>
      <td class="text-end text-muted">${esc(r.last_2v2_date || '\u2014')}</td>
    </tr>
    <tr id="${detailId}" class="collapse vt-vtsr-detail${expanded ? ' show' : ''}">
      <td colspan="9">${renderV2Detail(r, ladder)}</td>
    </tr>`;
  }

  function renderV2TableHtml(rows, c, ranked, ladder) {
    const st = v2SortState[ladder];
    const th = (key, label, extra = '') =>
      `<th data-sort="${key}" class="text-end${st.key === key ? ' sort-active' : ''}"${extra}>${label}</th>`;
    const mid = ladder === 'thug_perf'
      ? `${th('beat', 'Beat exp.', ' data-bs-toggle="tooltip" data-bs-placement="top" title="Games where this thug&#39;s damage share beat what the two ratings predicted."')}
         ${th('share', 'Avg share', ' data-bs-toggle="tooltip" data-bs-placement="top" title="Average share of the two thugs&#39; enemy damage."')}`
      : `${th('record', 'W-L-D')}${th('win_pct', 'Win %')}`;
    const body = rows.map((r, i) => renderV2Row(r, c, ranked ? i + 1 : null, ladder)).join('');
    return `<div class="table-responsive">
      <table class="table table-hover align-middle mb-2" data-v2-ladder="${ladder}" style="font-size: 0.85rem;">
        <thead><tr>
          <th class="vt-vtsr-expand-col"></th>
          <th>#</th>
          <th data-sort="name">Player</th>
          ${th('rating', 'Rating', ` data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(V2_RATING_TIPS[ladder])}"`)}
          ${mid}
          ${th('games', 'Games')}
          ${th('peak', 'Peak')}
          ${th('last', 'Last 2v2')}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  }

  function v2LadderHtml(ladder, c, noun) {
    const ratings = v2Ladder(ladder);
    const min = v1LadderMinGames(c);
    const win = inactivityWindowDays(c);
    const sorter = v2Sort(v2SortState[ladder].key, v2SortState[ladder].asc);
    const ranked = ratings.filter(r => r.leaderboard_eligible).slice().sort(sorter);
    const unranked = ratings.filter(r => !r.leaderboard_eligible).slice().sort(sorter);
    const rankedHtml = ranked.length
      ? renderV2TableHtml(ranked, c, true, ladder)
      : `<p class="text-muted small">Nobody has ${fmt(min)} rated 2v2s as a ${noun} yet.</p>`;
    const unrankedHtml = unranked.length
      ? `<div class="vt-vtsr-c-unranked">
          <h6 class="vt-vtsr-c-unranked-title">Unranked</h6>
          <p class="vt-vtsr-c-unranked-blurb">Need ${fmt(min)} rated 2v2s as a ${noun} and a game within ${fmt(win)} days of the newest match. No rank is assigned here.</p>
          ${renderV2TableHtml(unranked, c, false, ladder)}
        </div>`
      : '';
    return rankedHtml + unrankedHtml;
  }

  function v2CompareHtml() {
    const perf = new Map(v2Ladder('thug_perf').map(r => [v2Key(r), r]));
    const wl = new Map(v2Ladder('thug_wl').map(r => [v2Key(r), r]));
    const rankOf = (list) => {
      const m = new Map();
      list.slice().sort((a, b) => b.rating - a.rating).forEach((r, i) => m.set(v2Key(r), i + 1));
      return m;
    };
    const pRank = rankOf([...perf.values()]);
    const wRank = rankOf([...wl.values()]);
    const keys = [...new Set([...perf.keys(), ...wl.keys()])];
    const rows = keys.map(k => {
      const p = perf.get(k) || null;
      const w = wl.get(k) || null;
      const base = p || w;
      return { k, name: base.name, steam64: base.steam64, p, w, pr: pRank.get(k), wr: wRank.get(k) };
    });
    const st = v2SortState.compare;
    const val = (row) => {
      switch (st.key) {
        case 'name': return (row.name || '').toLowerCase();
        case 'wl': return row.w ? row.w.rating : -Infinity;
        case 'gap': return (row.pr && row.wr) ? Math.abs(row.pr - row.wr) : -Infinity;
        case 'perf':
        default: return row.p ? row.p.rating : -Infinity;
      }
    };
    rows.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return st.asc ? -1 : 1;
      if (va > vb) return st.asc ? 1 : -1;
      return (a.name || '').toLowerCase() < (b.name || '').toLowerCase() ? -1 : 1;
    });
    const cell = (r, rank) => r
      ? `${Math.round(r.rating)} <span class="text-muted small">#${rank} &middot; ${r.games}g${r.provisional ? ' ?' : ''}</span>`
      : '<span class="text-muted">\u2014</span>';
    const th = (key, label, extra = '') =>
      `<th data-sort="${key}" class="${key === 'name' ? '' : 'text-end'}${st.key === key ? ' sort-active' : ''}"${extra}>${label}</th>`;
    const body = rows.map(row => {
      const gap = (row.pr && row.wr) ? row.pr - row.wr : null;
      const gapHtml = gap == null ? '<span class="text-muted">\u2014</span>'
        : gap === 0 ? 'same rank'
          : `${Math.abs(gap)} place${Math.abs(gap) === 1 ? '' : 's'} ${gap > 0 ? 'higher on win/loss' : 'higher on performance'}`;
      return `<tr>
        <td class="fw-semibold">${playerLinkHtml(row.name, row.steam64)}</td>
        <td class="text-end">${cell(row.p, row.pr)}</td>
        <td class="text-end">${cell(row.w, row.wr)}</td>
        <td class="text-end">${gapHtml}</td>
      </tr>`;
    }).join('');
    return `<p class="small text-muted mb-2">Every thug on either 2v2 thug ladder. The two ratings answer different questions:
      <strong>Performance</strong> asks whether you out-damaged the other thug more than expected (recorded games only);
      <strong>Win/loss</strong> asks whether your team won more than expected (recorded games with a verified winner).
      Both run side by side until enough recorded 2v2s exist to test which one predicts winners better.</p>
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-2" data-v2-ladder="compare" style="font-size: 0.85rem;">
          <thead><tr>
            ${th('name', 'Player')}
            ${th('perf', 'Performance')}
            ${th('wl', 'Win/loss')}
            ${th('gap', 'Rank gap')}
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  function v2Banner(c, kind) {
    const rec = (kind === 'commander' ? c.wl_games_rated : c.games_rated) || 0;
    const lead = kind === 'commander'
      ? 'Two commanders, each with one thug. Win/loss Elo for the commander; the win chance counts both commanders and both thugs.'
      : 'Two commanders, each with one thug. Two thug ratings run side by side for now.';
    return `<div class="alert alert-secondary py-2 px-3 mb-3 small">
      ${lead} Separate from VSR-C, VSR-T and VSR-1v1. Camera-pod spectators don&rsquo;t count as players;
      a 2v2 where someone was idle or left early isn&rsquo;t rated. Built from ${fmt(rec)} recorded
      2v2${rec === 1 ? '' : 's'}. Experimental: everyone started at 1500 and most players have only a few games.
    </div>`;
  }

  function bindV2Body(body, rerender) {
    if (!body.dataset.vtCollapseListenersBound) {
      body.dataset.vtCollapseListenersBound = '1';
      const prefix = 'vtsr-2v2-detail-';
      body.addEventListener('shown.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith(prefix)) expandedV2Rows.add(id.slice(prefix.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'true');
      });
      body.addEventListener('hidden.bs.collapse', (e) => {
        const id = (e.target && e.target.id) || '';
        if (id.startsWith(prefix)) expandedV2Rows.delete(id.slice(prefix.length));
        const btn = body.querySelector(`[data-bs-target="#${id}"]`);
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
    }
    body.querySelectorAll('table[data-v2-ladder] th[data-sort]').forEach(th => {
      const ladder = th.closest('table').dataset.v2Ladder;
      const st = v2SortState[ladder];
      th.style.cursor = 'pointer';
      th.onclick = () => {
        if (st.key === th.dataset.sort) st.asc = !st.asc;
        else { st.key = th.dataset.sort; st.asc = th.dataset.sort === 'name'; }
        rerender();
      };
    });
    ensureTooltips(body);
  }

  function v2ShowOrEmpty(cardId, emptyId) {
    const card = document.getElementById(cardId);
    const $empty = document.getElementById(emptyId);
    const c = state.v2Elo;
    const ok = !!(c && c.ladders && (c.games_rated || 0) > 0);
    if (card) card.classList.toggle('d-none', !ok);
    if ($empty) $empty.classList.toggle('d-none', ok);
    return ok ? c : null;
  }

  function render2v2CommanderLadder() {
    const body = document.getElementById('vtsr-2v2c-body');
    const c = v2ShowOrEmpty('section-vtsr-2v2c', 'elo-vtsr-2v2c-empty');
    if (!body || !c) return;
    body.innerHTML = v2Banner(c, 'commander') + v2LadderHtml('commander', c, 'commander');
    bindV2Body(body, render2v2CommanderLadder);
  }

  function v2ViewFromUrl() {
    const v = new URLSearchParams(window.location.search).get('view');
    return V2_VIEWS.includes(v) ? v : 'perf';
  }

  function setV2View(view, writeUrl) {
    v2View = V2_VIEWS.includes(view) ? view : 'perf';
    document.querySelectorAll('#vtsr-2v2t-view [data-view]').forEach(b => {
      const on = b.dataset.view === v2View;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (writeUrl) {
      const url = new URL(window.location.href);
      if (v2View === 'perf') url.searchParams.delete('view');
      else url.searchParams.set('view', v2View);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }

  function render2v2ThugLadder() {
    const body = document.getElementById('vtsr-2v2t-body');
    const c = v2ShowOrEmpty('section-vtsr-2v2t', 'elo-vtsr-2v2t-empty');
    if (!body || !c) return;
    const group = document.getElementById('vtsr-2v2t-view');
    if (group && !group.dataset.vtBound) {
      group.dataset.vtBound = '1';
      setV2View(v2ViewFromUrl(), false);
      group.addEventListener('click', (e) => {
        const b = e.target.closest('[data-view]');
        if (!b || b.dataset.view === v2View) return;
        setV2View(b.dataset.view, true);
        render2v2ThugLadder();
      });
    }
    const content = v2View === 'compare'
      ? v2CompareHtml()
      : v2LadderHtml(V2_LADDER_FOR_VIEW[v2View], c, 'thug');
    body.innerHTML = v2Banner(c, 'thug') + content;
    bindV2Body(body, render2v2ThugLadder);
  }

  // ----------------------------------------------------------------------
  // Tab routing (?tab=) + lazy renderers.
  // ----------------------------------------------------------------------

  // The VSR-C pane is the default: it never writes a ?tab= at all.
  // The first key per target is the slug that pane emits, so canonical
  // slugs come before their aliases. `vtsr-c` / `vtsr-t` (pre-rebrand) and
  // `leaderboard` (pre-split) stay as permanent inbound aliases.
  const DEFAULT_TAB_TARGET = '#elo-tab-vtsr-c';
  const THUG_TAB_TARGET = '#elo-tab-leaderboard';
  // While the 1v1 / 2v2 ladders are hidden, their slugs resolve to the
  // commander ladder, so an old link lands there and loses its ?tab=.
  const smallFormatTarget = (target) => (SMALL_FORMAT_RATINGS ? target : DEFAULT_TAB_TARGET);
  const TAB_SLUGS = {
    'vsr-c': DEFAULT_TAB_TARGET,
    'vsr-t': THUG_TAB_TARGET,
    '1v1': smallFormatTarget('#elo-tab-1v1'),
    '2v2c': smallFormatTarget('#elo-tab-2v2c'),
    '2v2t': smallFormatTarget('#elo-tab-2v2t'),
    '2v2': smallFormatTarget('#elo-tab-2v2c'),
    how: '#elo-tab-how',
    axes: '#elo-tab-axes',
    fairness: '#elo-tab-fairness',
    accuracy: '#elo-tab-accuracy',
    'vtsr-c': DEFAULT_TAB_TARGET,
    'vtsr-t': THUG_TAB_TARGET,
    leaderboard: THUG_TAB_TARGET,
  };
  const tabRendered = {};
  const tabRenderers = {
    '#elo-tab-vtsr-c': renderCommanderLadder,
    '#elo-tab-1v1': render1v1Ladder,
    '#elo-tab-2v2c': render2v2CommanderLadder,
    '#elo-tab-2v2t': render2v2ThugLadder,
    '#elo-tab-how': renderHowTab,
    '#elo-tab-axes': renderAxesTab,
    '#elo-tab-fairness': renderFairnessTab,
    '#elo-tab-accuracy': renderAccuracyTab,
  };

  function renderTabIfNeeded(target) {
    if (tabRendered[target]) return;
    const fn = tabRenderers[target];
    if (fn) {
      fn();
      tabRendered[target] = true;
    }
  }

  function slugForTarget(target) {
    return Object.keys(TAB_SLUGS).find(k => TAB_SLUGS[k] === target) || 'vsr-c';
  }

  // No tab, and ?tab=vsr-c, land on the commander ladder. A wins preview
  // with no tab still lands on the thug board, because that control lives
  // there. The aliases resolve through TAB_SLUGS to the same panes.
  function landingTargetFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const slug = q.get('tab');
    if (!slug && q.get('rating') === 'wins') return THUG_TAB_TARGET;
    const target = TAB_SLUGS[slug];
    if (!target || target === DEFAULT_TAB_TARGET) return DEFAULT_TAB_TARGET;
    return target;
  }

  let historyWrites = 0;

  function syncUrl(target, mode) {
    if (historyWrites) return;
    const url = new URL(window.location.href);
    if (target === DEFAULT_TAB_TARGET) url.searchParams.delete('tab');
    else url.searchParams.set('tab', slugForTarget(target));
    if (target !== '#elo-tab-2v2t') url.searchParams.delete('view');
    else if (v2View !== 'perf') url.searchParams.set('view', v2View);
    const next = url.pathname + url.search + url.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next === cur) return;
    if (mode === 'replace') history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }

  function activateTabFromUrl() {
    const q = new URLSearchParams(window.location.search);
    const slug = q.get('tab');
    const target = landingTargetFromUrl();
    if (target === DEFAULT_TAB_TARGET) {
      // Normalize a redundant / unknown ?tab= off the commander ladder.
      // That is a replace, not a Back step.
      if (slug) syncUrl(DEFAULT_TAB_TARGET, 'replace');
      const home = document.querySelector(`#elo-tabs [data-bs-target="${DEFAULT_TAB_TARGET}"]`);
      if (home && !home.classList.contains('active')) {
        home._vtQuiet = true;
        window.setTimeout(() => { if (home._vtQuiet) home._vtQuiet = false; }, 1000);
        bootstrap.Tab.getOrCreateInstance(home).show();
      }
      return;
    }
    // Rewrite inbound aliases to the slug this pane actually emits.
    if (slug && slug !== slugForTarget(target)) syncUrl(target, 'replace');
    const btn = document.querySelector(`#elo-tabs [data-bs-target="${target}"]`);
    if (!btn || btn.classList.contains('active')) return;
    btn._vtQuiet = true;
    window.setTimeout(() => { if (btn._vtQuiet) btn._vtQuiet = false; }, 1000);
    bootstrap.Tab.getOrCreateInstance(btn).show();
  }

  // ----------------------------------------------------------------------
  // Tab: How it works.
  // ----------------------------------------------------------------------

  function renderHowTab() {
    const pane = document.getElementById('elo-tab-how');
    if (!pane || !window.VTSRExplain) return;
    const E = window.VTSRExplain;
    const deltaBlock = E.deltaRBlockHtml();
    if (!deltaBlock) {
      // KaTeX still loading (deferred script) — retry shortly. The tab
      // is user-activated, so in practice this only fires on very slow
      // connections; the flag stays unset so the retry re-enters here.
      tabRendered['#elo-tab-how'] = false;
      setTimeout(() => renderTabIfNeeded('#elo-tab-how'), 350);
      return;
    }
    const blendBlock = E.blendBlockHtml() || '';
    // Live constants, with the shipped values as fallbacks.
    const elo = state.elo || {};
    const sigma = ratingNoiseSigma();
    const lossPct = Math.round((elo.k_loss_aversion != null ? elo.k_loss_aversion : 0.85) * 100);
    const floor = Math.round(elo.rating_floor != null ? elo.rating_floor : 1000);
    const bufferPts = fmt((window.VTSRDisplay && VTSRDisplay.config.buffer_pts) || 20);
    const provisional = fmt(elo.provisional_threshold != null ? elo.provisional_threshold : ELO_PROVISIONAL_THRESHOLD);
    const ladderMin = fmt(vtsrLadderMinMatches(elo));
    const windowDays = fmt(inactivityWindowDays(elo));
    const comeback = fmt(comebackGamesRequired(elo));
    // Why a band and not a number. The noise figure is the bootstrap
    // wobble from validation_summary.json; without it the sentence about
    // one game's swing carries the point alone.
    const whyBand = sigma != null
      ? `Why not show the number? Two players within about <strong>${sigma} points</strong> of each other can&rsquo;t be told apart yet, and a single game moves a rating by 10 to 25 points.`
      : 'Why not show the number? A single game moves a rating by 10 to 25 points, and small gaps between players mean little.';
    const sigmaSource = sigma != null
      ? ` The ${sigma}-point figure is measured on the <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab.`
      : '';
    const smallFormatSection = SMALL_FORMAT_RATINGS
      ? `<section class="vt-vtsr-doc-section">
        <h6>1v1 and 2v2</h6>
        <p class="mb-2"><strong>1v1.</strong> The ladder is on the <a href="?tab=1v1" data-elo-tab-link="1v1">1v1</a> tab.</p>
        ${E.oneVOneLadderHtml ? E.oneVOneLadderHtml() : ''}
        <p class="mb-2 mt-4"><strong>2v2.</strong> The ladders are on the <a href="?tab=2v2c" data-elo-tab-link="2v2c">2v2C</a> and <a href="?tab=2v2t" data-elo-tab-link="2v2t">2v2T</a> tabs.</p>
        ${E.twoVTwoLaddersHtml ? E.twoVTwoLaddersHtml() : ''}
      </section>`
      : '';
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>The short version</h6>
        <p class="mb-2">The site keeps two ratings. <strong>VSR-T</strong> rates how well you fight. <strong>VSR-C</strong> rates how often you win as commander. Both start at <strong>1500</strong>.</p>
        <p class="mb-0">A game counts when each side has at least three players and it has a recorded winner. VSR-T is shown as a band such as <em>Tier 2 &middot; Upper</em>, never as a number. VSR-C is shown as a number.${SMALL_FORMAT_RATINGS ? ' 1v1 and 2v2 games have their own ladders, covered at the bottom of this page.' : ''}</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>How VSR-T moves</h6>
        <p class="mb-2">After each rated game we take your share of all the damage your lobby did to the enemy. We compare it with the share a player at your rating was expected to deal against that team. That expected share is your bar.</p>
        <p class="mb-2">Beat your bar and you go up. Fall short and you go down. Each game is labelled <strong>Beat expectation</strong>, <strong>On par</strong> or <strong>Below expectation</strong>. Whether your team won makes no difference.</p>
        <p class="mb-2">Commanding lowers your bar, because commanders spend most of the game at base.</p>
        ${E.workedExampleHtml()}
        <p class="mb-0 mt-2 text-muted small">A drop is cut to ${lossPct}% of what the formula says, and no rating falls below <strong>${floor}</strong>.</p>
        ${E.mathDetailsHtml('The math: the formula, piece by piece', deltaBlock)}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Why winning doesn&rsquo;t move VSR-T</h6>
        <p class="mb-0">A win belongs to the whole team, and VSR-T rates one player&rsquo;s fighting. The site still keeps a win/loss rating for every player and updates it after each rated game. It counts for <strong>0%</strong> of VSR-T. We tried 10%, 25% and 50%, and none of them picked winners more often. The rule for raising it was written before that test ran.</p>
        ${E.mathDetailsHtml('The math: how the two ratings mix', blendBlock)}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Bands and tiers</h6>
        <p class="mb-2">Each tier splits into an <strong>Upper</strong> and a <strong>Lower</strong> half. That half is your band, and it is what every page shows.</p>
        <p class="mb-2">${whyBand} So a band only changes once your rating clears the line by <strong>${bufferPts} points</strong>. One bad game rarely moves it.${sigmaSource}</p>
        <p class="mb-2">Players with fewer than ${provisional} rated games show <strong>Provisional</strong> instead of a tier. A place on the ladder needs <strong>${ladderMin} rated games</strong> and a game within ${windowDays} days of the newest recorded match. After a longer break it takes ${comeback} games to get back on. Everyone else is listed under <strong>Not on the ladder yet</strong>.</p>
        <p class="mb-2">Tiers are fixed point ranges, not percentiles, so the top tier can be nearly empty.</p>
        ${E.tierTableHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Commanders: VSR-C</h6>
        ${E.commanderLadderHtml(' Every commander&rsquo;s rating, record and duel log is on the <a href="?tab=vsr-c" data-elo-tab-link="vsr-c">VSR-C Elo</a> tab.')}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Which ladder rates my game?</h6>
        ${E.formatLinesHtml ? E.formatLinesHtml() : ''}
      </section>

      ${smallFormatSection}
    </div>`;
    E.initIn(pane);
    wireTabLinks(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: What counts (the scored axis).
  // ----------------------------------------------------------------------

  function renderAxesTab() {
    const pane = document.getElementById('elo-tab-axes');
    if (!pane || !window.VTSRExplain) return;
    const E = window.VTSRExplain;
    pane.innerHTML = `<div class="vt-elo-doc">
      <section class="vt-vtsr-doc-section">
        <h6>What gets measured</h6>
        <p class="mb-1">Your match score is <strong>one stat</strong>: your share of the damage your lobby did to the enemy. Hitting an enemy tank, a scavenger, an extractor or a building all pays the same per point of damage.</p>
        ${E.AXES.length > 1 ? E.axesBoardHtml() : ''}
        <p class="mb-0 mt-2 text-muted small">It is scored <em>against the lobby you played in</em> &mdash; an average share earns roughly zero, beating the room earns positive, trailing it earns negative.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Share of the match score</h6>
        ${E.weightsTableHtml()}
        <div class="vt-katex-caveat">${E.RETIRED_AXES_NOTE}</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>What about VSR-C?</h6>
        <p class="mb-1">Enemy damage powers <strong>VSR-T only</strong>. The commander ladder (<a href="?tab=vsr-c" data-elo-tab-link="vsr-c">VSR-C</a>) scores on <strong>wins and losses alone</strong>. Newer matches also record a commander economy read across the whole game &mdash; pools held, time the scrap bank spent out of green, scrap spent on real combat ships (empty scouts excluded), and upgrades held, plus unscored ships-per-loss and loose-share readouts &mdash; but it is <strong>recorded, not scored</strong>. It does not move a rating until a fresh batch of matches, recorded after the 23 Oct 2026 rule change, clears a stricter check than &ldquo;the leader of the stat also won that same match.&rdquo;</p>
        <p class="mb-0 text-muted small">The choice was <strong>checked against real match outcomes</strong> before it shipped (see <code>critique/decisions/vtsr-t-enemy-damage.md</code>); how well it lines up with winning lives on the <a href="?tab=accuracy" data-elo-tab-link="accuracy">Does it work?</a> tab.</p>
      </section>
    </div>`;
    E.initIn(pane);
    wireTabLinks(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: Commanders & fairness.
  // ----------------------------------------------------------------------

  function renderFairnessTab() {
    const pane = document.getElementById('elo-tab-fairness');
    if (!pane) return;
    const E = window.VTSRExplain;
    const cards = [
      {
        icon: 'bi-person-badge', title: 'Commanding doesn\u2019t tank your rating',
        body: E ? E.commanderSectionHtml() : '',
        verdict: '',
      },
      {
        icon: 'bi-camera-video', title: 'Campods don\u2019t count (usually)',
        body: `<p>If you spend more than a quarter of the entire match in a campod, that game doesn\u2019t count for you.</p>`,
        verdict: '',
      },
      {
        icon: 'bi-eye-slash', title: 'Sitting out doesn\u2019t count',
        body: `<p>A thug who deals <strong>no damage at all</strong> in a match that otherwise had fighting is treated the same way. The game doesn\u2019t count for them. A commander who never fires still rates &mdash; building is the job.</p>`,
        verdict: 'Shown with an "Idle" badge on the per-match leaderboard.',
      },
      {
        icon: 'bi-hourglass-split', title: 'Late joins &amp; disconnects don\u2019t count',
        body: `<p>If you were present for less than 75% of a match &mdash; joined late, dropped mid-game &mdash; the match <strong>isn\u2019t rated for you</strong>. Half a game says nothing fair about your skill either way.</p>`,
        verdict: 'Shown with a "Partial" badge on the per-match leaderboard.',
      },
      {
        icon: 'bi-person-x', title: 'Pilot kills don\u2019t count',
        body: `<p>Pilot farm doesn\u2019t count towards kills, and dying as a pilot doesn\u2019t add deaths. <strong>Only vehicle combat counts</strong> toward K/D and the kill-rate axis.</p>`,
        verdict: 'A pilot who destroys a <em>ship</em> still gets full credit &mdash; and damage dealt to or by pilots always counts.',
      },
      {
        icon: 'bi-people-fill', title: 'Your teammates don\u2019t set your bar',
        body: `<p>What you were expected to score is set against <strong>the other team only</strong>. It used to be set against everyone else in the match, teammates included, so thugs on a strong team got an easier bar and thugs carrying a weak one got a harder bar.</p>`,
        verdict: 'Stronger opponents lower the bar; weaker ones raise it.',
      },
      {
        icon: 'bi-building-x', title: 'Knocking down a beaten base doesn\u2019t count',
        body: `<p>Damage to buildings in the <strong>last three minutes</strong> of a match is left out of your match score. By then the game is decided, and that damage mostly measures which team won: it was 8.5% of a winning thug\u2019s damage and 1.9% of a losing thug\u2019s.</p>`,
        verdict: 'Everything else you hit still counts, to the last second.',
      },
      {
        icon: 'bi-person-badge-fill', title: 'The commander ladder (VSR-C)',
        body: `<p>Commanders now have a <strong>separate rating built purely on wins and losses</strong> &mdash; every match with a verified outcome is a 1v1 duel between the two commanders. Outcomes only count when they\u2019re <strong>proven</strong>: host-attested, reviewer-confirmed, or physically evident from the recording (base destroyed). Unverifiable matches simply don\u2019t move it.</p>`,
        verdict: 'Outcome-pure. Full ladder on the <a href="?tab=vsr-c" data-elo-tab-link="vsr-c">VSR-C Elo</a> tab.',
      },
      {
        icon: 'bi-cash-stack', title: 'Economy is recorded, not yet scored',
        body: `<p>Matches recorded with the new collector carry a <strong>commander economy read</strong> against the other commander, measured across the whole game. Four axes are candidates: pools held, time the scrap bank spent out of green (the slow band), scrap spent on real combat ships with empty scouts and empty Xypos excluded, and upgrades held. Three other readouts &mdash; ships built per ship lost, the same without empty scouts, and how much of the scrap earned all match was loose collected &mdash; are shown and <strong>not scored</strong>. None of it moves the rating yet. The blend stays <strong>outcome-pure</strong> until a fresh sample, recorded after 23 Oct 2026, clears the pre-registered rule. The formula is not tuned to fit the matches that judge it.</p>`,
        verdict: 'The first telemetry match is the cautionary tale: the economy composite pointed at the commander who lost.',
      },
      {
        icon: 'bi-people', title: 'Stacked thugs don\u2019t inflate your commander rating',
        body: `<p>VSR-C\u2019s expected score already knows <strong>which side had the stronger thug team</strong> (each team\u2019s average pre-match VSR-T feeds the formula). Win with a stacked roster and you were <em>supposed</em> to win \u2014 small gain. Win with the weaker one and the ladder pays out properly; lose with it and the penalty is tiny.</p>`,
        verdict: 'Commanding the underdog team is never a rating trap.',
      },
      {
        icon: 'bi-arrow-down-circle', title: 'Losses sting less, and there\u2019s a floor',
        body: `<p>On <strong>VSR-T</strong>, rating losses are scaled to <strong>85%</strong> of what the formula says (chasing people off the ladder helps nobody), and no rating can fall below <strong>1000</strong> &mdash; a soft floor with a gradual taper, not a cliff.</p>`,
        verdict: 'VSR-C has neither \u2014 a commander duel is zero-sum, so what one side wins the other loses exactly.',
      },
    ].map(c => `<div class="vt-elo-fairness-card">
        <h6><i class="bi ${c.icon}"></i>${c.title}</h6>
        ${c.body}
        ${c.verdict ? `<div class="vt-elo-fairness-verdict">${c.verdict}</div>` : ''}
      </div>`).join('');
    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1200px;">
      <p class="mb-3">A skill rating is only as good as its blind spots. These are the rules that keep the <strong>two ladders</strong> &mdash; VSR-T for thug play, VSR-C for commanding &mdash; from punishing people for things that aren&rsquo;t skill. Each one is a <strong>pure omission</strong> (the affected match simply doesn&rsquo;t move the rating) or a measured adjustment, never a bonus pool.</p>
      <div class="vt-elo-fairness-grid">${cards}</div>
    </div>`;
    wireTabLinks(pane);
  }

  // ----------------------------------------------------------------------
  // Tab: Does it work? (validation_summary.json)
  // ----------------------------------------------------------------------

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Main-reason record from validate_elo.py (latest_detail.vtsr_c.drivers):
  // how often the favored side won, by why it was favored. The Outcome
  // card's main-reason line uses the same classes.
  function driversTableHtml(drivers) {
    if (!drivers || !drivers.classes) return '';
    const c = drivers.classes;
    const gap = drivers.gap_min != null ? Math.round(drivers.gap_min) : 50;
    const rate = (row) => (row && row.n
      ? `${row.favored_wins} of ${row.n} (${Math.round((row.favored_wins / row.n) * 100)}%)`
      : '\u2014');
    // Labels match the Outcome card's main-reason line (js/balonce-meter.js).
    const rows = [
      ['Commander edge', 'The favorite has the better commander, and that is the main reason.', c.commander_edge],
      ['\u2026 against stronger thugs', 'The better commander faced the stronger thugs and was still the favorite.', c.commander_edge && c.commander_edge.vs_stronger_thugs],
      ['Stacked', `The favorite\u2019s commander is rated at least ${gap} points lower, and stronger thugs more than cover the gap.`, c.stacked],
      ['Thug edge', 'The commanders are close. The favorite has the stronger thugs.', c.thug_edge],
      ['Both edges', 'The favorite has the better commander and the stronger thugs.', c.both],
      ['Even', 'Neither side has a real edge.', c.even],
    ].map(([label, desc, row]) => `<tr>
        <td><strong>${label}</strong><div class="text-muted small">${desc}</div></td>
        <td class="text-end">${rate(row)}</td>
      </tr>`).join('');
    return `<p class="vt-elo-acc-blurb mb-2 mt-3"><strong>Why was the favorite favored?</strong> Each duel is filed under the main reason one side was expected to win. The match page shows the same label on its Outcome card.</p>
      <table class="vt-elo-gap-table">
        <thead><tr><th>Main reason</th><th class="text-end">Favorite won</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderAccuracyTab() {
    const pane = document.getElementById('elo-tab-accuracy');
    if (!pane) return;
    const v = state.validation;
    if (!v || !v.latest) {
      pane.innerHTML = `<div class="card"><div class="card-body text-center text-muted py-5">
        <i class="bi bi-clipboard-data d-block mb-2" style="font-size: 1.6rem;"></i>
        No accuracy data yet. Run the pipeline to generate <code>validation_summary.json</code>.
      </div></div>`;
      return;
    }
    // Formulas and tuning tables sit in a collapsed disclosure so the
    // plain copy reads on its own (shared with the How tab).
    const mathDetails = (summary, inner) => ((window.VTSRExplain && window.VTSRExplain.mathDetailsHtml)
      ? window.VTSRExplain.mathDetailsHtml(summary, inner)
      : inner);
    const L = v.latest;
    const funnel = (v.latest_detail && v.latest_detail.winner_funnel) || null;
    const gaps = (v.latest_detail && v.latest_detail.rating_gap_breakout
      && v.latest_detail.rating_gap_breakout.buckets) || [];
    const sigma = ratingNoiseSigma();

    const pct = (x, digits = 0) => (x == null || !isFinite(x)) ? '\u2014' : (x * 100).toFixed(digits) + '%';

    // ---- Headline stat cards (layman captions; exact methods live in the
    // per-card "Technical definition" disclosure). ----
    // Qualitative badge per metric. Tones: good / ok / bad / info. Thresholds
    // are deliberately simple so the badges auto-upgrade as the corpus grows.
    const badge = (kind, val) => {
      if (val == null || !isFinite(val)) return null;
      switch (kind) {
        case 'sample':
          return val >= 400 ? { label: 'Solid sample', tone: 'good' }
            : val >= 150 ? { label: 'Growing', tone: 'info' }
            : { label: 'Small sample', tone: 'ok' };
        case 'rho':
          return val >= 0.75 ? { label: 'Strong', tone: 'good' }
            : val >= 0.55 ? { label: 'Fair', tone: 'ok' }
            : { label: 'Weak', tone: 'bad' };
        case 'sigma':
          return val <= 25 ? { label: 'Tight', tone: 'good' }
            : val <= 55 ? { label: 'Moderate', tone: 'ok' }
            : { label: 'Noisy', tone: 'bad' };
        case 'accuracy':
          return val >= 0.65 ? { label: 'Strong', tone: 'good' }
            : val >= 0.57 ? { label: 'Fair', tone: 'ok' }
            : { label: 'Coin-flip', tone: 'bad' };
        default: return null;
      }
    };
    const recent = (L.clean_win_accuracy_recent && L.clean_win_accuracy_recent.accuracy != null)
      ? L.clean_win_accuracy_recent : null;
    const pickAcc = recent ? recent.accuracy : L.clean_win_accuracy_hard_max;
    const cards = [
      {
        label: 'Rated games', value: String(L.rated_match_count ?? '\u2014'),
        badge: badge('sample', L.rated_match_count),
        caption: `Played by ${L.players_total ?? '?'} players. Everything on this tab is recomputed from these games on each update.`,
        tech: 'A match is rated when it has at least 6 players, at least 3 per side, and a recorded winner (host result, recycler or factory loss, or reviewer sign-off). Draws are not rated. Match length does not matter.',
      },
      {
        label: 'Rating stability', value: (L.self_consistency_rho != null) ? L.self_consistency_rho.toFixed(2) : '\u2014',
        badge: badge('rho', L.self_consistency_rho),
        caption: 'Split each player\u2019s games into two random halves and compare how the halves rank the players. 1.00 means they agree completely.',
        tech: 'Spearman \u03c1 between random split-halves of each player\u2019s matches.',
      },
      {
        label: 'Too close to call', value: sigma != null ? `\u00b1${sigma}` : '\u2014',
        badge: badge('sigma', sigma),
        caption: 'How far a rating moves when we recompute it on a random 80% of the games. Players closer together than this are effectively tied.',
        tech: 'Median per-player \u03c3 over 100 bootstrap resamples of 80% of matches.',
      },
      {
        label: 'Picks the winner',
        value: pct(pickAcc),
        badge: badge('accuracy', pickAcc),
        caption: (recent && recent.n)
          ? `In the last ${recent.n} rated games`
            + (recent.since_date ? ` (since ${esc(recent.since_date)})` : '')
            + `, this is how often the team with the highest-rated player won. Over all ${L.clean_win_n ?? 0} games it is ${pct(L.clean_win_accuracy_hard_max)}. A coin flip is 50%.`
          : `Across ${L.clean_win_n ?? 0} rated games, this is how often the team with the highest-rated player won. A coin flip is 50%.`,
        tech: 'Highest pre-match VSR-T on each team (hard max). Games with a single recorded winner only.',
      },
    ].map(c => `<div class="vt-elo-statcard">
        <div class="vt-elo-stat-head">
          <span class="vt-elo-stat-label">${c.label}</span>
          ${c.badge ? `<span class="vt-elo-badge is-${c.badge.tone}">${c.badge.label}</span>` : ''}
        </div>
        <div class="vt-elo-stat-value">${c.value}</div>
        <div class="vt-elo-stat-caption">${c.caption}</div>
        <details class="vt-elo-stat-tech">
          <summary>Technical definition</summary>
          <div class="vt-elo-stat-tech-body">${c.tech}</div>
        </details>
      </div>`).join('');

    // ---- Winner funnel. ----
    let funnelHtml = '';
    if (funnel) {
      const total = funnel.rated_history_entries || 0;
      // Contested matches (both bases fell) are a legitimate but rare outcome
      // that isn't usable as "provable winner" data, so they're grouped under
      // unprovable for this chart. Draws (v15 attested) have no winner to
      // predict, so they group there too.
      const unprovable = (funnel.decided_by_unclear || 0) + (funnel.decided_by_contested || 0)
        + (funnel.decided_by_draw || 0);
      const attested = funnel.decided_by_attested || 0;
      const adjudicated = funnel.decided_by_adjudicated || 0;
      const rows = [
        ['All rated games', total, 'total'],
        ['Winner seen in the recording', funnel.decided_by_clean_win || 0, 'provable'],
        // v15: host-attested wins (proto v3 outcome dialog).
        ...(attested > 0 ? [['Host reported the winner', attested, 'provable']] : []),
        // v16: reviewer-confirmed wins (pipeline outcome-review prompt).
        ...(adjudicated > 0 ? [['Reviewer confirmed the winner', adjudicated, 'provable']] : []),
        // Since ELO_SCHEMA_VERSION 21 a game is rated only with a recorded
        // winner, so this row is the rare both-bases-fell game.
        ...(unprovable > 0 ? [['No clear winner', unprovable, 'unprovable']] : []),
      ].map(([label, n, kind]) => {
        const w = total > 0 ? Math.max(0.8, (n / total) * 100) : 0;
        return `<div class="vt-elo-funnel-row is-${kind}">
          <span class="vt-elo-funnel-label">${label}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${n}</span>
        </div>`;
      }).join('');
      const noWinnerLine = unprovable > 0
        ? ` ${unprovable} of ${total} games had no clear winner to pick, usually because both bases fell. ${unprovable === 1 ? 'That game stays' : 'Those games stay'} out of the winner-picking numbers on this tab.`
        : '';
      funnelHtml = `<div class="vt-elo-acc-section">
        ${mathDetails('Which games count', `
          <p class="vt-elo-acc-blurb">A game is rated only when we know who won. That comes from one of three places: the recording shows one team\u2019s base destroyed, the host answered the end-of-game question, or a reviewer signed the result off afterwards.${noWinnerLine}</p>
          <div class="vt-elo-funnel">${rows}</div>
          <p class="vt-elo-acc-blurb mb-0 mt-2 text-muted small">This chart is recorded games only. The <a href="?tab=vsr-c" data-elo-tab-link="vsr-c">commander ladder</a> also counts F9bomber\u2019s logged games, so its duel count is higher.</p>`)}
      </div>`;
    }

    // ---- Gap breakout. ----
    let gapHtml = '';
    if (gaps.length) {
      // Bucket edges come from the validator (25 / 100 today).
      const edge = (x) => fmt(x);
      const rows = gaps.map(b => {
        const label = b.bucket === 'small' ? `Close (under ${edge(b.gap_max ?? 25)} points)`
          : b.bucket === 'mid' ? `Moderate (${edge(b.gap_min ?? 25)} to ${edge(b.gap_max ?? 100)})`
          : `Lopsided (over ${edge(b.gap_min ?? 100)})`;
        const acc = (b.score && b.score.accuracy != null) ? pct(b.score.accuracy) : '\u2014';
        return `<tr>
          <td>${label}</td>
          <td class="text-end">${b.n}</td>
          <td class="text-end">${acc}</td>
        </tr>`;
      }).join('');
      // The lead sentence is built from the buckets so it can never
      // disagree with the table under it.
      const accOf = (b) => ((b && b.n && b.score && b.score.accuracy != null) ? b.score.accuracy : null);
      const close = gaps.find(b => b.bucket === 'small');
      const lopsided = gaps.find(b => b.bucket === 'large');
      const closeAcc = accOf(close);
      const lopAcc = accOf(lopsided);
      let gapLead;
      if (lopsided && !lopsided.n) {
        gapLead = `No rated game so far has had one team more than ${edge(lopsided.gap_min ?? 100)} points stronger than the other, so the ratings have only been tested on close games.`;
      } else if (closeAcc != null && lopAcc != null) {
        const coin = (closeAcc >= 0.4 && closeAcc <= 0.6) ? ', about a coin flip' : '';
        gapLead = `When the two teams\u2019 average VSR-T was within ${edge(close.gap_max ?? 25)} points, the favorite won <strong>${pct(closeAcc)}</strong> of ${close.n} games${coin}. When one side was more than ${edge(lopsided.gap_min ?? 100)} points stronger, it won <strong>${pct(lopAcc)}</strong> of ${lopsided.n}.`;
      } else {
        gapLead = 'The bigger the rating gap between two teams, the more often the stronger one should win.';
      }
      gapHtml = `<div class="vt-elo-acc-section">
        <h6>Bigger gaps, better calls</h6>
        <p class="vt-elo-acc-blurb">${gapLead}</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Gap between the teams</th><th class="text-end">Games</th><th class="text-end">Favorite won</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    // ---- VSR-C commander-ladder accuracy (v1.2; absent-safe). ----
    const vc = (v.latest_detail && v.latest_detail.vtsr_c) || null;
    let cmdrAccHtml = '';
    if (vc && vc.available) {
      const lamRows = (vc.per_lambda || []).map(row => {
        const mark = row.canonical ? ' <span class="badge text-bg-secondary" style="font-size:0.6rem;">current</span>' : '';
        return `<tr${row.canonical ? ' class="fw-semibold"' : ''}>
          <td>\u03bb = ${row.lambda}${mark}</td>
          <td class="text-end">${pct(row.accuracy)}</td>
          <td class="text-end">${row.log_loss != null ? row.log_loss.toFixed(3) : '\u2014'}</td>
        </tr>`;
      }).join('');
      const lamTable = lamRows ? `<p class="vt-elo-acc-blurb mb-2">\u03bb sets how much a gap in thug strength counts next to the gap between the commanders. Every duel is re-scored at each setting. Log-loss measures how far off the win chances were, and lower is better.</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Thug weight</th><th class="text-end">Favorite won</th><th class="text-end">Log-loss</th></tr></thead>
          <tbody>${lamRows}</tbody>
        </table>` : '';
      cmdrAccHtml = `<div class="vt-elo-acc-section">
        <h6>Commander ratings (VSR-C)</h6>
        <p class="vt-elo-acc-blurb">Before each commander duel, VSR-C names a favorite from the two commanders\u2019 ratings and the strength of their thugs. Recorded games and F9bomber\u2019s logged games both count.</p>
        <div class="vt-elo-statgrid" style="margin-bottom: 0.85rem;">
          <div class="vt-elo-statcard">
            <div class="vt-elo-stat-head">
              <span class="vt-elo-stat-label">Favorite won</span>
              ${(() => { const b = badge('accuracy', vc.accuracy); return b ? `<span class="vt-elo-badge is-${b.tone}">${b.label}</span>` : ''; })()}
            </div>
            <div class="vt-elo-stat-value">${pct(vc.accuracy)}</div>
            <div class="vt-elo-stat-caption">Of ${vc.n_scored ?? 0} rated commander duels. A coin flip is 50%.</div>
            <details class="vt-elo-stat-tech">
              <summary>Technical definition</summary>
              <div class="vt-elo-stat-tech-body">Chronological replay from elo_commander_history.json. Draws are left out of the count. Log-loss ${vc.log_loss != null ? vc.log_loss.toFixed(3) : '\u2014'}.</div>
            </details>
          </div>
        </div>
        ${driversTableHtml(vc.drivers)}
        ${lamTable ? mathDetails('The math: how much the thugs should count', lamTable) : ''}
      </div>`;
    }

    // ---- Axis-vs-outcome study (v1.2; absent-safe). ----
    const ao = (v.latest_detail && v.latest_detail.axis_outcome) || null;
    let axisOutcomeHtml = '';
    if (ao && ao.available && Array.isArray(ao.axes) && ao.axes.length) {
      const axisLabel = (key) => (VTSR_AXIS_META[key] && VTSR_AXIS_META[key].label) || key;
      const rows = ao.axes.map(r => {
        const agree = r.sign_agreement;
        const tone = agree == null ? 'is-total'
          : agree >= 0.65 ? 'is-provable'
          : agree >= 0.45 ? 'is-total'
          : 'is-unprovable';
        const w = agree != null ? Math.max(1.5, agree * 100) : 0;
        return `<div class="vt-elo-funnel-row ${tone}">
          <span class="vt-elo-funnel-label" data-bs-toggle="tooltip" data-bs-placement="top"
                title="${r.n} rated games">${esc(axisLabel(r.axis))}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${pct(agree)}</span>
        </div>`;
      }).join('');
      // One scored axis today (enemy damage share). The lead names its
      // figure; with more axes the bars carry the detail.
      const top = ao.axes.length === 1 ? ao.axes[0] : null;
      const lead = (top && top.sign_agreement != null)
        ? `In ${top.n ?? ao.n_matches_determined ?? 0} rated games, the team whose players scored higher on ${esc(axisLabel(top.axis).toLowerCase())} won <strong>${pct(top.sign_agreement)}</strong> of the time.`
        : `Across ${ao.n_matches_determined ?? 0} rated games, this is how often the team that scored higher on each stat also won. At 50% a stat says nothing about winning.`;
      axisOutcomeHtml = `<div class="vt-elo-acc-section">
        <h6>${top && top.axis === 'enemy_damage_share' ? 'Do winners deal more damage?' : 'Which stats go with winning?'}</h6>
        <p class="vt-elo-acc-blurb">${lead} That is measured after the game, inside the same game. It shows that winners deal more damage. It does not show that VSR-T can call a winner before the game starts. The cards at the top test that.</p>
        <div class="vt-elo-funnel">${rows}</div>
      </div>`;
    }

    // ---- VSR-C v2 economy composite proof sections (v1.3; absent-safe). ----
    const vcp = (v.latest_detail && v.latest_detail.vtsr_c_perf) || null;
    let cmdrEconHtml = '';
    // What-if table: the ladder replayed with the economy read mixed in.
    // Tuning detail, so it sits in the section's collapsed disclosure.
    let alphaDetails = '';
    if (vcp && vcp.alpha_ablation && vcp.alpha_ablation.available
        && Array.isArray(vcp.alpha_ablation.per_alpha)) {
      const abRows = vcp.alpha_ablation.per_alpha.map(row => {
        const mark = row.canonical ? ' <span class="badge text-bg-secondary" style="font-size:0.6rem;">current</span>' : '';
        return `<tr${row.canonical ? ' class="fw-semibold"' : ''}>
          <td>\u03b1<sub>c</sub> = ${row.alpha_c}${mark}</td>
          <td class="text-end">${pct(row.accuracy)}</td>
          <td class="text-end">${row.log_loss != null ? row.log_loss.toFixed(3) : '\u2014'}</td>
        </tr>`;
      }).join('');
      alphaDetails = mathDetails('The math: what if the economy counted?', `
        <p class="vt-elo-acc-blurb mb-2">The duels with economy data are replayed with the economy read mixed in. \u03b1<sub>c</sub> is the share that wins and losses keep, so 1 is today\u2019s setting and 0.5 is an even split. A small bump in this table does not switch it on. Only a fresh batch of games that passes the rule written in advance can.</p>
        <table class="vt-elo-gap-table">
          <thead><tr><th>Win/loss share</th><th class="text-end">Favorite won</th><th class="text-end">Log-loss</th></tr></thead>
          <tbody>${abRows}</tbody>
        </table>`);
    }
    if (vcp && vcp.econ_axes && vcp.econ_axes.available
        && Array.isArray(vcp.econ_axes.axes) && vcp.econ_axes.axes.length) {
      const ea = vcp.econ_axes;
      const econLabel = (key) =>
        (CMDR_ECON_AXIS_META[key] && CMDR_ECON_AXIS_META[key].label) || key;
      const rows = ea.axes.map(r => {
        const agree = r.sign_agreement;
        const tone = agree == null ? 'is-total'
          : agree >= 0.65 ? 'is-provable'
          : agree >= 0.45 ? 'is-total'
          : 'is-unprovable';
        const w = agree != null ? Math.max(1.5, agree * 100) : 0;
        // Every stat here is recorded, not scored. The suffix marks the
        // readouts that are not even candidates for scoring.
        const name = econLabel(r.axis) + (r.scored === false ? ' (display only)' : '');
        return `<div class="vt-elo-funnel-row ${tone}">
          <span class="vt-elo-funnel-label" data-bs-toggle="tooltip" data-bs-placement="top"
                title="${r.n} duels with economy data">${esc(name)}</span>
          <span class="vt-elo-funnel-track"><span class="vt-elo-funnel-fill" style="width:${w.toFixed(1)}%;"></span></span>
          <span class="vt-elo-funnel-count">${pct(agree)}</span>
        </div>`;
      }).join('');
      // Promotion status in plain words. HOLD is the validator's verdict
      // while the pre-registered rule has not been passed.
      const promo = vcp.promote;
      let promoHtml = '';
      if (promo && promo.verdict) {
        const have = promo.n_confirmation ?? 0;
        const need = promo.n_confirmation_required ?? 25;
        const since = promo.amended_on ? ` since ${esc(promo.amended_on)}` : '';
        const held = String(promo.verdict).toUpperCase() === 'HOLD';
        const detail = !held
          ? `${have} games recorded${since} have been checked.`
          : have < need
            ? `The rule needs ${need} games recorded${since}, and ${have} exist so far.`
            : `${have} games recorded${since} have been checked, and they did not pass the rule.`;
        promoHtml = `<p class="vt-elo-acc-blurb">Status: <strong>${held ? 'not counted' : esc(promo.verdict)}</strong>. ${detail}</p>`;
      }
      cmdrEconHtml = `<div class="vt-elo-acc-section">
        <h6>Commander economy (recorded, not scored)</h6>
        <p class="vt-elo-acc-blurb">Newer recordings track how each commander ran their economy. In ${ea.n_scored ?? 0} duels with that data, the bars show how often the commander who led a stat also won. Leading a stat in a game you won proves little, because winning produces the lead. So none of this moves VSR-C. It starts counting only if a fresh batch of games passes a rule written before those games were played.</p>
        ${promoHtml}
        <div class="vt-elo-funnel">${rows}</div>
        ${alphaDetails}
      </div>`;
    } else if (alphaDetails) {
      cmdrEconHtml = `<div class="vt-elo-acc-section">
        <h6>Commander economy (recorded, not scored)</h6>
        ${alphaDetails}
      </div>`;
    }

    // ---- New model in testing (v1.13; absent-safe). ----
    // The joint commanding-and-fighting model's switch test, straight from
    // validate_elo.py #24 (the prediction ledger). It changes no rating
    // until a look passes; this section only says where the test stands.
    const jm = (v.latest_detail && v.latest_detail.joint_model) || null;
    let jointHtml = '';
    if (jm && jm.available) {
      const run = jm.running || null;
      const lookList = (Array.isArray(jm.looks_at) && jm.looks_at.length) ? jm.looks_at : [200, 300, 400];
      const lastLook = lookList[lookList.length - 1];
      const looks = lookList.length > 1
        ? `${lookList.slice(0, -1).join(', ')} and ${lastLook}`
        : String(lastLook);
      const STATUS = {
        not_started: ['Not started', 'ok', 'The rules are written but not signed off, so no game counts yet.'],
        running: ['Running', 'info', `It is checked at ${looks} recorded games. The next check is at ${jm.next_look ?? '\u2014'}.`],
        passed: ['Passed', 'good', 'It predicted clearly better at a check. The switch to it is being prepared.'],
        withdrawn: ['Withdrawn', 'bad', 'It fell clearly behind today\u2019s formula at a check, so the preview was taken down.'],
        ended: ['Ended', 'ok', `It did not predict clearly better within ${lastLook} games. Today\u2019s ratings stay.`],
      };
      const [sLabel, sTone, sText] = STATUS[jm.status] || [String(jm.status || 'Unknown'), 'ok', ''];
      const num = (x, d) => (x == null || !isFinite(x)) ? '\u2014' : Number(x).toFixed(d);
      let gapLine = '';
      if (run && run.gain != null && isFinite(run.gain)) {
        const side = run.gain >= 0 ? 'ahead' : 'behind';
        gapLine = `<p class="vt-elo-acc-blurb mt-2 mb-0">So far the new model is ${side} by ${num(Math.abs(run.gain), 3)} log-loss, give or take ${num(run.gain_se, 3)}. To pass a check, its lead has to be at least twice that margin.</p>`;
      }
      const soFar = run
        ? `<table class="vt-elo-gap-table">
            <thead><tr><th>On the ${run.n} games counted so far</th><th class="text-end">New model</th><th class="text-end">Today\u2019s formula</th></tr></thead>
            <tbody>
              <tr><td>Favorite won</td><td class="text-end">${pct(run.accuracy_joint)}</td><td class="text-end">${pct(run.accuracy_baseline)}</td></tr>
              <tr><td>Log-loss (lower is better)</td><td class="text-end">${num(run.log_loss_joint, 3)}</td><td class="text-end">${num(run.log_loss_baseline, 3)}</td></tr>
            </tbody>
          </table>
          ${gapLine}`
        : '';
      jointHtml = `<div class="vt-elo-acc-section" id="elo-joint-test">
        <h6>New model in testing <span class="vt-elo-badge is-${sTone}">${sLabel}</span></h6>
        <p class="vt-elo-acc-blurb">Today VSR-T ignores who won, and VSR-C ignores how well the commander fights. We are testing a model that gives every player <strong>two skills, commanding and fighting</strong>. It learns both from who won and from how much damage each player dealt compared with their teammates. The commander counts as one of the team\u2019s fighters.</p>
        <p class="vt-elo-acc-blurb">It runs alongside today\u2019s ratings and changes none of them. Where it appears, it is the line labelled <em>New model (in testing)</em> beside the Balonce meter.</p>
        <p class="vt-elo-acc-blurb"><strong>${sText}</strong> It replaces today\u2019s ratings only if it predicts recorded games clearly better than today\u2019s formula. That rule was written${jm.freeze_date ? ` on ${esc(jm.freeze_date)},` : ''} before any of the test games were played, and the test stops at ${lastLook} games.</p>
        ${soFar}
      </div>`;
    }

    // ---- History sparkline. ----
    // Prefer match chronology (cumulative + rolling-30) when the validator
    // emitted accuracy_timeline. Fall back to the per-run history chart.
    const hist = Array.isArray(v.history) ? v.history : [];
    const timeline = (v.latest_detail && Array.isArray(v.latest_detail.accuracy_timeline))
      ? v.latest_detail.accuracy_timeline.filter(row => row && row.date)
      : [];
    const showTrend = timeline.length > 1 || hist.length > 1;
    const trendLegend = timeline.length > 1
      ? 'The solid line is how often VSR-T picked the winner over the previous 30 games. The dashed line counts every game up to that date. Above 50% beats a coin flip.'
      : 'One point per update: how often VSR-T picked the winner, and how well ratings lined up with match scores.';
    const histSection = `<div class="vt-elo-acc-section">
      <h6>Is it getting better?</h6>
      ${showTrend
        ? `<p class="vt-elo-acc-blurb">${trendLegend}</p>
           <div class="vt-elo-history-wrap"><canvas id="elo-history-chart"></canvas></div>`
        : '<p class="vt-elo-acc-blurb mb-0 text-muted">The trend chart appears once more updates have been recorded.</p>'}
    </div>`;

    const updated = String(L.generated_at || v.generated_at || '').slice(0, 10);
    pane.innerHTML = `<div class="vt-elo-doc" style="max-width: 1100px;">
      <p class="mb-3">Each time the ratings update, we replay every rated game in order and check what the ratings said before it was played.</p>
      <div class="vt-elo-statgrid">${cards}</div>
      ${gapHtml}
      ${histSection}
      ${cmdrAccHtml}
      ${axisOutcomeHtml}
      ${cmdrEconHtml}
      ${jointHtml}
      ${funnelHtml}
      ${updated ? `<p class="text-muted small mb-0">Updated ${esc(updated)}.</p>` : ''}
    </div>`;

    ensureTooltips(pane);
    wireTabLinks(pane);

    if (showTrend && window.Chart) {
      const ctx = document.getElementById('elo-history-chart');
      if (ctx) {
        if (state.historyChart) { state.historyChart.destroy(); state.historyChart = null; }
        const primary = cssVar('--kb-primary', '#5b8cff');
        const accent = cssVar('--kb-success', '#3dd68c');
        const muted = cssVar('--kb-text-muted', '#888');
        let labels;
        let datasets;
        if (timeline.length > 1) {
          let running = 0;
          const cumulative = timeline.map((row, i) => {
            running += row.correct_hard_max ? 1 : 0;
            return (running / (i + 1)) * 100;
          });
          const rolling = timeline.map((row, i) => {
            const start = Math.max(0, i - 29);
            let hits = 0;
            for (let j = start; j <= i; j++) {
              if (timeline[j].correct_hard_max) hits++;
            }
            return (hits / (i - start + 1)) * 100;
          });
          labels = timeline.map(row => String(row.date).slice(0, 10));
          datasets = [
            {
              label: 'Every game so far (%)',
              data: cumulative,
              borderColor: muted,
              backgroundColor: 'transparent',
              borderDash: [5, 4],
              tension: 0.15,
              pointRadius: 0,
            },
            {
              label: 'Previous 30 games (%)',
              data: rolling,
              borderColor: primary,
              backgroundColor: 'transparent',
              tension: 0.15,
              pointRadius: 0,
            },
            {
              label: 'Coin flip (50%)',
              data: timeline.map(() => 50),
              borderColor: accent,
              backgroundColor: 'transparent',
              borderDash: [2, 3],
              pointRadius: 0,
              tension: 0,
            },
          ];
        } else {
          labels = hist.map(h => (h.generated_at || '').slice(0, 10));
          datasets = [
            {
              label: 'Picks the winner (%)',
              data: hist.map(h => h.clean_win_accuracy_hard_max != null ? h.clean_win_accuracy_hard_max * 100 : null),
              borderColor: primary,
              backgroundColor: 'transparent',
              tension: 0.25,
              pointRadius: 3,
            },
            {
              label: 'Ratings match performance (%)',
              data: hist.map(h => h.spearman_pooled_rho != null ? h.spearman_pooled_rho * 100 : null),
              borderColor: muted,
              backgroundColor: 'transparent',
              borderDash: [5, 4],
              tension: 0.25,
              pointRadius: 3,
            },
          ];
        }
        state.historyChart = new Chart(ctx, {
          type: 'line',
          data: { labels, datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { min: 0, max: 100, ticks: { callback: (val) => val + '%' } },
            },
            plugins: { legend: { labels: { boxWidth: 14 } } },
          },
        });
      }
    }
  }

  // In-page tab cross-links inside rendered content (e.g. the How tab's
  // pointer to the accuracy tab) switch pills instead of reloading.
  function wireTabLinks(root) {
    root.querySelectorAll('[data-elo-tab-link]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = TAB_SLUGS[a.dataset.eloTabLink];
        const btn = target && document.querySelector(`#elo-tabs [data-bs-target="${target}"]`);
        if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
      });
    });
  }

  // ----------------------------------------------------------------------
  // Boot.
  // ----------------------------------------------------------------------

  async function boot() {
    // Orphaned v2.7 thug-only key — the toggle is gone; drop it so a
    // returning user never carries a stale pref that nothing reads.
    try { localStorage.removeItem('vt.elo_mode'); } catch { /* private mode / storage blocked */ }

    // "How It's Calculated" on the leaderboard card switches to the
    // How-it-works pill (no modal on this page — the tab IS the modal).
    const howLinks = ['vtsr-how-link', 'vtsr-1v1-how-link']
      .map(id => document.getElementById(id))
      .concat([...document.querySelectorAll('[data-elo-how-link]')]);
    howLinks.forEach((howLink) => {
      if (!howLink) return;
      howLink.addEventListener('click', () => {
        const btn = document.querySelector('#elo-tabs [data-bs-target="#elo-tab-how"]');
        if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
      });
    });
    // Tab change -> lazy render + URL sync.
    const tabsEl = document.getElementById('elo-tabs');
    if (tabsEl && SMALL_FORMAT_RATINGS) {
      tabsEl.querySelectorAll('[data-vt-small-format]').forEach(li => li.classList.remove('d-none'));
    }
    if (tabsEl) {
      tabsEl.addEventListener('shown.bs.tab', (e) => {
        const target = e.target.getAttribute('data-bs-target');
        if (target) {
          renderTabIfNeeded(target);
          const btn = e.target && e.target.closest ? e.target.closest('[data-bs-target]') : e.target;
          if (btn && btn._vtQuiet) { btn._vtQuiet = false; return; }
          syncUrl(target);
        }
      });
    }

    // Core data, all in parallel + 404-safe.
    const [elo, eloHistory, slugMap, validation, contributions, cmdrElo, cmdrHistory,
      v1Elo, v1History, v2Elo, v2History] = await Promise.all([
      fetchJson(`${DATA}elo_current.json`),
      fetchJson(`${DATA}elo_history.json`),
      fetchJson(`${DATA}player_slugs.json`),
      fetchJson(`${DATA}validation_summary.json`),
      fetchJson(`${DATA}match_contributions.json`),
      fetchJson(`${DATA}elo_commander_current.json`),
      fetchJson(`${DATA}elo_commander_history.json`),
      SMALL_FORMAT_RATINGS ? fetchJson(`${DATA}elo_1v1_current.json`) : null,
      SMALL_FORMAT_RATINGS ? fetchJson(`${DATA}elo_1v1_history.json`) : null,
      SMALL_FORMAT_RATINGS ? fetchJson(`${DATA}elo_2v2_current.json`) : null,
      SMALL_FORMAT_RATINGS ? fetchJson(`${DATA}elo_2v2_history.json`) : null,
    ]);
    if (window.VTSRDisplay) VTSRDisplay.setConfig(elo);
    state.elo = elo;
    state.eloHistory = eloHistory;
    state.slugMap = slugMap;
    state.validation = validation;
    state.cmdrElo = cmdrElo;
    state.cmdrHistory = cmdrHistory;
    state.v1Elo = v1Elo;
    state.v1History = v1History;
    state.v2Elo = v2Elo;
    state.v2History = v2History;

    // Corpus-wide career join source (Primary Ship / K/D / Acc columns +
    // detail panels). Threshold 0 so even fresh players get a join row —
    // the leaderboard's own roster comes from elo.ratings, not from here.
    if (contributions && window.VTAggregate && elo) {
      try {
        const agg = window.VTAggregate.build(contributions, Object.keys(contributions), elo,
          { minMatchesThreshold: 0 });
        state.careerStats = (agg && agg.career_stats) || [];
      } catch (err) {
        console.warn('[elo] aggregate build failed', err);
        state.careerStats = [];
      }
    }

    renderLeaderboard();
    // The thug table is always built. The commander ladder is built now
    // only when this visit lands on it; any other pane still lazy-renders
    // from shown.bs.tab. Its data is already fetched above.
    if (landingTargetFromUrl() === DEFAULT_TAB_TARGET) {
      renderCommanderLadder();
      tabRendered[DEFAULT_TAB_TARGET] = true;
    }

    // Deep links (?tab=...) boot straight into the right pane.
    activateTabFromUrl();
    stripLegacyRatingParams();
    window.addEventListener('popstate', () => {
      historyWrites++;
      try {
        activateTabFromUrl();
      } finally { historyWrites--; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
