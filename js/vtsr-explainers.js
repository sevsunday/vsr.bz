/* js/vtsr-explainers.js — shared VSR-T explainer content + annotated-stage engine.
 *
 * Loaded by BOTH index.html (methodology modal) and elo/index.html (the
 * dedicated ELO page's explainer tabs). Exposes `window.VTSRExplain`.
 *
 * The annotated stage ("chalk talk") is a free-form DOM + SVG diagram:
 * a centerpiece (KaTeX equation or the axes mixing-board) with callout
 * cards absolutely positioned at author-chosen % coordinates, revealed
 * one step at a time, each connected to its anchor glyph/segment by a
 * measured SVG bezier. Connector endpoints are measured from the LIVE
 * DOM every draw (never precomputed) so they survive resizes, font
 * swaps, and tab/modal visibility flips (a ResizeObserver redraws).
 *
 * Engine contract:
 *   - Markup is built by buildStageBlock() -> one `.vt-eq-block[data-eq]`
 *     wrapper holding the stage, the always-in-DOM <ol> copy (sr-only on
 *     desktop, the visible stacked walkthrough under 620px), and the
 *     Back / dots / Next / Show-all controls.
 *   - Steps are registered per data-eq key in STEP_REGISTRY; initIn(root)
 *     finds every block and (re)initializes it. Idempotent: a second
 *     initIn resets existing instances to their opening state.
 *   - Two reveal modes: cumulative (default — step N shows callouts
 *     1..N; show-all shows everything) and `solo` (one callout at a
 *     time — used by the 8-axes board where 8 cards can't coexist).
 *   - KaTeX terms are tagged via \htmlId{...} (requires trust:true,
 *     strict:false — input is author-controlled, never user text).
 *
 * Matching CSS: the `.vt-eq-*` + `.vt-axesboard-*` blocks in
 * css/vtstats-theme.css (loaded by every shell).
 */
(function () {
  'use strict';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function katexOrNull() {
    return (window.katex && typeof window.katex.renderToString === 'function')
      ? window.katex : null;
  }

  // Render display-mode KaTeX with \htmlId tagging enabled. Returns null
  // when KaTeX hasn't loaded yet so callers can retry on next open.
  function renderEq(tex) {
    const k = katexOrNull();
    if (!k) return null;
    try {
      return k.renderToString(tex,
        { displayMode: true, trust: true, strict: false, throwOnError: false });
    } catch (_e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Step configs. Each step: { term | sel, title, body, x, y } where
  // x/y place the callout card's top-left corner as a % of the stage
  // (the free-form placement knob — no grid). Cards are ~27% of the
  // stage wide, so keep top (3/36/70) and bottom (8/63) lanes
  // collision-free in the cumulative show-all state.
  // ------------------------------------------------------------------

  const DELTA_R_STEPS = [
    { term: 'eq-perf', title: 'Your match score', x: 8, y: 63,
      body: 'Your share of all the damage your lobby did to the enemy. Players, scavs, extractors, AI units and buildings pay the same per point. Building damage in the last three minutes is left out, because the game is decided by then.' },
    { term: 'eq-exp', title: 'Your bar', x: 63, y: 63,
      body: 'What a player with your rating should score against the other team. A higher rating raises it. Stronger opponents lower it. Your teammates do not move it.' },
    { term: 'eq-gap', title: 'The surprise', x: 70, y: 5,
      body: 'Beat your bar and this is positive. Fall short and it is negative. Play to your rating and it lands near zero.' },
    { term: 'eq-k', title: 'Move speed', x: 36, y: 5,
      body: 'How far one game can move you. New players move fast while the rating finds their level. Veterans move a little each game.' },
    { term: 'eq-dr', title: 'Your rating change', x: 3, y: 5,
      body: 'Added to your VSR-T after the match.' },
  ];
  const DELTA_R_TEX = '\\htmlId{eq-dr}{\\Delta R} \\;=\\; \\htmlId{eq-k}{K}\\,'
    + '\\htmlId{eq-gap}{\\bigl(\\, \\htmlId{eq-perf}{P} - \\htmlId{eq-exp}{E} \\,\\bigr)}';

  // 13.1 final equation: VSR-T is a mix of two ratings. The win/loss
  // rating is real and updates every rated game; only its share is 0.
  const BLEND_STEPS = [
    { term: 'eq-rt', title: 'Performance rating', x: 63, y: 63,
      body: 'The damage-share rating described above. Today it is all of your VSR-T.' },
    { term: 'eq-rw', title: 'Win/loss rating', x: 8, y: 63,
      body: 'A plain win/loss rating. It is <strong>real</strong> and it updates after every rated game.' },
    { term: 'eq-alpha', title: 'The mix', x: 36, y: 5,
      body: 'How much the win/loss rating counts. It is <strong>set to 0</strong>, so VSR-T is 100% performance.' },
    { term: 'eq-vtsr', title: 'Your VSR-T', x: 3, y: 5,
      body: 'The rating behind your band: the two ratings, mixed.' },
  ];
  const BLEND_TEX = '\\htmlId{eq-vtsr}{\\text{VSR-T}} \\;=\\; '
    + '\\htmlId{eq-alpha}{\\alpha} \\cdot \\htmlId{eq-rw}{R^{W}} \\;+\\; '
    + '(1 - \\alpha) \\cdot \\htmlId{eq-rt}{R^{T}}';

  // The scored axis (v2.14). Single source for the mixing board, the
  // weights table, and the methodology modal table; mirrors THUG_WEIGHTS
  // in scripts/elo.py. v2.14 replaced net damage share, thug kill rate,
  // PvE share and mobility (critique/decisions/vtsr-t-enemy-damage.md).
  // Snipes, T-key usage and the accuracy column are display stats.
  const AXES = [
    { key: 'enemy_damage_share', label: 'Enemy damage share', weight: 1.0,
      blurb: 'Your damage to the enemy as a share of all the damage your lobby did to the enemy. Players, scavengers, extractors, AI units and buildings all count the same per point. Damage to your own team&rsquo;s units, loose scrap and map props does not count.' },
  ];
  // Copy for the retired v2.13 axes, used where a page explains what
  // stopped counting.
  const RETIRED_AXES_NOTE = 'Kills, map coverage and PvE share stopped counting in v2.14. Kills mostly repeated damage and missed bail-outs and snipes, coverage mostly repeated damage, and PvE share paid for the mix of your damage rather than the amount. Shot accuracy and fight efficiency are not rating inputs either.';

  // Share of the match score when every axis is present. Raw weights
  // stay in AXES so they keep matching THUG_WEIGHTS; the scorer divides
  // by their sum, and that share is what the table and callouts show.
  function axisShareLabel(weight) {
    const total = AXES.reduce((s, a) => s + a.weight, 0) || 1;
    const rounded = Math.round((weight / total) * 1000) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return text + '%';
  }

  // Mixing-board steps (solo mode: one callout at a time, anchored to
  // the bar segments). Callouts alternate above/below the bar.
  const AXES_STEPS = AXES.map((a, i) => ({
    sel: `[data-axis="${a.key}"]`,
    title: `${a.label} \u00b7 ${axisShareLabel(a.weight)}`,
    body: a.blurb + (i >= 6 ? '' : ''),
    x: Math.min(70, 3 + (i % 3) * 33.5),
    y: i % 2 === 0 ? 5 : 63,
  }));

  // ------------------------------------------------------------------
  // Stage markup builder.
  // ------------------------------------------------------------------

  // Build one annotated-stage block. `key` indexes STEP_REGISTRY;
  // `centerHtml` is the stage centerpiece (KaTeX equation HTML or the
  // axes board); opts: { mode: 'cumulative'|'solo', hint }.
  function buildStageBlock(key, steps, centerHtml, opts = {}) {
    const mode = opts.mode === 'solo' ? 'solo' : 'cumulative';
    const hint = opts.hint
      || 'Press <strong>Next</strong> to unpack each piece.';
    const callouts = steps.map((s, i) => `
      <div class="vt-eq-callout" data-step="${i + 1}"
           data-x="${s.x}" data-y="${s.y}" aria-hidden="true">
        <div class="vt-eq-callout-title">${s.title}</div>
        <div class="vt-eq-callout-body">${s.body}</div>
      </div>`).join('');
    // Canonical always-in-DOM copy: sr-only on desktop, the visible
    // stacked walkthrough under 620px where free-form arrows collide.
    const list = steps.map((s, i) =>
      `<li data-step="${i + 1}"><strong>${s.title}.</strong> ${s.body}</li>`).join('');
    const dots = ['Start', ...steps.map((s) => s.title), 'Show all']
      .map((label, i) => `<button type="button" class="vt-eq-dot" data-state="${i}"
        title="${esc(label.replace(/<[^>]*>/g, ''))}" aria-label="${esc(label.replace(/<[^>]*>/g, ''))}"></button>`)
      .join('');
    return `<div class="vt-eq-block" data-eq="${key}" data-eq-mode="${mode}">
      <div class="vt-eq-stage">
        <svg class="vt-eq-svg" aria-hidden="true"></svg>
        <div class="vt-eq-center">${centerHtml}</div>
        ${callouts}
        <div class="vt-eq-hint">${hint}</div>
      </div>
      <ol class="vt-eq-list">${list}</ol>
      <div class="vt-eq-controls">
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-prev" aria-label="Previous step"><i class="bi bi-chevron-left"></i></button>
        <div class="vt-eq-dots">${dots}</div>
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-next">Next<i class="bi bi-chevron-right ms-1"></i></button>
        <button type="button" class="btn btn-sm vt-eq-btn vt-eq-btn-primary vt-eq-all">Show all</button>
      </div>
    </div>`;
  }

  const STEP_REGISTRY = {
    deltaR: DELTA_R_STEPS,
    blend: BLEND_STEPS,
    axes: AXES_STEPS,
  };

  // ------------------------------------------------------------------
  // Stage engine.
  // ------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let arrowMarkerSeq = 0;

  function initStageBlock(block) {
    if (block.__vtEq) { block.__vtEq.reset(); return; }
    const steps = STEP_REGISTRY[block.dataset.eq];
    const stage = block.querySelector('.vt-eq-stage');
    const svg = block.querySelector('.vt-eq-svg');
    const controls = block.querySelector('.vt-eq-controls');
    if (!steps || !stage || !svg || !controls) return;
    const solo = block.dataset.eqMode === 'solo';
    const callouts = [...stage.querySelectorAll('.vt-eq-callout')];
    const hint = stage.querySelector('.vt-eq-hint');
    const listItems = [...block.querySelectorAll('.vt-eq-list [data-step]')];
    const prevBtn = controls.querySelector('.vt-eq-prev');
    const nextBtn = controls.querySelector('.vt-eq-next');
    const allBtn = controls.querySelector('.vt-eq-all');
    const dots = [...controls.querySelectorAll('.vt-eq-dot')];

    const N = steps.length;
    const ALL = N + 1;                 // states: 0 bare, 1..N steps, ALL
    const compactMq = window.matchMedia('(max-width: 620px)');
    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Unique arrowhead marker id per block (several stages per page).
    const markerId = `vt-eq-arrow-${++arrowMarkerSeq}`;
    let state = 0;

    // Free-form placement: each card's top-left from its data-x/data-y %.
    for (const c of callouts) {
      c.style.left = `${c.dataset.x}%`;
      c.style.top = `${c.dataset.y}%`;
    }

    // Anchor resolution: KaTeX \htmlId id (term) or any selector (sel).
    const anchorEl = (i) => {
      const s = steps[i];
      if (s.term) return stage.querySelector(`#${CSS.escape(s.term)}`);
      if (s.sel) return stage.querySelector(s.sel);
      return null;
    };
    steps.forEach((s, i) => {
      const el = anchorEl(i);
      if (el) el.classList.add('vt-eq-term');
    });

    function drawConnectors() {
      if (compactMq.matches) { svg.replaceChildren(); return; }
      const sr = stage.getBoundingClientRect();
      if (!sr.width || !sr.height) return;
      svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
      const defs = document.createElementNS(SVG_NS, 'defs');
      defs.innerHTML = `<marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5"`
        + ' markerWidth="7" markerHeight="7" orient="auto">'
        + '<path d="M 0 1 L 9 5 L 0 9" fill="none" stroke-linecap="round"'
        + ' stroke-linejoin="round"/></marker>';
      svg.replaceChildren(defs);
      callouts.forEach((c, i) => {
        if (!c.classList.contains('is-shown')) return;
        const t = anchorEl(i);
        if (!t) return;
        const tr = t.getBoundingClientRect();
        if (!tr.width || !c.offsetWidth) return;
        // Term anchor: live rect (anchors carry no transforms). Card
        // anchor: LAYOUT geometry (offsetLeft/Top vs the relative stage)
        // so the entrance transform can't skew the endpoint.
        const cLeft = c.offsetLeft;
        const cTop = c.offsetTop;
        const tx = tr.left + tr.width / 2 - sr.left;
        const tcy = tr.top + tr.height / 2 - sr.top;
        const above = (cTop + c.offsetHeight / 2) < tcy;
        const ty = (above ? tr.top - 6 : tr.bottom + 6) - sr.top;
        const cx = Math.max(cLeft + 14, Math.min(tx, cLeft + c.offsetWidth - 14));
        const cy = above ? cTop + c.offsetHeight + 2 : cTop - 2;
        const dy = cy - ty;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d',
          `M ${tx} ${ty} C ${tx} ${ty + dy * 0.45}, ${cx} ${cy - dy * 0.45}, ${cx} ${cy}`);
        path.setAttribute('class',
          'vt-eq-connector' + (c.classList.contains('is-current') ? ' is-current' : ''));
        path.setAttribute('marker-end', `url(#${markerId})`);
        svg.appendChild(path);
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', tx);
        dot.setAttribute('cy', ty);
        dot.setAttribute('r', '3');
        dot.setAttribute('class', 'vt-eq-anchor-dot');
        svg.appendChild(dot);
      });
    }

    function apply(next) {
      state = Math.max(0, Math.min(ALL, next));
      const current = state >= 1 && state <= N ? state : 0;
      // Cumulative: shown when step <= state (everything at ALL).
      // Solo: only the current step's callout is on stage (none at ALL —
      // the anchors all light up instead and the list/table carries it).
      const calloutShown = (sIdx) => (solo
        ? sIdx === current
        : (state === ALL ? true : sIdx <= state));
      const litAt = (sIdx) => (state === ALL ? true : sIdx <= state);
      callouts.forEach((c) => {
        const sIdx = +c.dataset.step;
        c.classList.toggle('is-shown', calloutShown(sIdx));
        c.classList.toggle('is-current', sIdx === current);
      });
      listItems.forEach((li) => {
        const sIdx = +li.dataset.step;
        li.classList.toggle('is-shown', litAt(sIdx));
        li.classList.toggle('is-current', sIdx === current);
      });
      steps.forEach((s, i) => {
        const el = anchorEl(i);
        if (!el) return;
        el.classList.toggle('is-lit', litAt(i + 1));
        el.classList.toggle('is-current', (i + 1) === current);
      });
      if (hint) hint.classList.toggle('is-gone', state !== 0);
      if (prevBtn) prevBtn.disabled = state === 0;
      if (nextBtn) nextBtn.disabled = state === ALL;
      if (allBtn) allBtn.disabled = state === ALL;
      dots.forEach((d) => d.classList.toggle('is-active', +d.dataset.state === state));
      drawConnectors();
    }

    if (prevBtn) prevBtn.onclick = () => apply(state - 1);
    if (nextBtn) nextBtn.onclick = () => apply(state + 1);
    if (allBtn) allBtn.onclick = () => apply(ALL);
    dots.forEach((d) => { d.onclick = () => apply(+d.dataset.state); });

    // Left/Right step the walkthrough. Bound on the closest modal when
    // hosted in one (Bootstrap keeps focus there); otherwise on the
    // block itself, where keydown from the focused controls bubbles up.
    const keyHost = block.closest('.modal') || block;
    keyHost.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      apply(state + (e.key === 'ArrowRight' ? 1 : -1));
    });

    // Redraw on any stage resize — also fires when the stage becomes
    // visible (size 0 -> real) after a tab/modal flip, which makes the
    // connectors self-healing without explicit visibility hooks.
    const ro = new ResizeObserver(() => drawConnectors());
    ro.observe(stage);
    if (compactMq.addEventListener) {
      compactMq.addEventListener('change', () => drawConnectors());
    }

    const reset = () => apply(reducedMq.matches ? ALL : 0);
    block.__vtEq = { reset };
    reset();
  }

  // (Re)initialize every annotated-stage block under `root`. Waits for
  // the webfonts so KaTeX glyph rects are final before first measure;
  // safe to call repeatedly (existing instances reset to step 0).
  function initIn(root) {
    if (!root) return;
    const run = () => {
      root.querySelectorAll('.vt-eq-block[data-eq]').forEach(initStageBlock);
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(run);
    } else {
      run();
    }
  }

  // ------------------------------------------------------------------
  // Content builders.
  // ------------------------------------------------------------------

  // The core update formula as an annotated stage. Null until KaTeX loads.
  function deltaRBlockHtml() {
    const eq = renderEq(DELTA_R_TEX);
    if (!eq) return null;
    return buildStageBlock('deltaR', DELTA_R_STEPS, eq,
      { hint: 'Press <strong>Next</strong> to unpack each piece of the formula.' });
  }

  // The 13.1 final equation (alpha blend) as an annotated stage.
  function blendBlockHtml() {
    const eq = renderEq(BLEND_TEX);
    if (!eq) return null;
    return buildStageBlock('blend', BLEND_STEPS, eq,
      { hint: 'Press <strong>Next</strong> to unpack each piece.' });
  }

  // Collapsed disclosure for formulas and tuning tables, so the plain
  // copy above it reads on its own. `summary` is the visible label and
  // `inner` is trusted, author-written HTML. A stage block inside it
  // draws its connectors when the disclosure opens (the stage's
  // ResizeObserver fires on the 0 -> real size change).
  function mathDetailsHtml(summary, inner) {
    if (!inner) return '';
    return `<details class="vt-explain-math">
      <summary>${summary}</summary>
      <div class="vt-explain-math-body">${inner}</div>
    </details>`;
  }

  // The 4-axes mixing board: a horizontal weight bar whose segments are
  // the step anchors (solo mode — one spotlight at a time). No KaTeX.
  function axesBoardHtml() {
    const totalW = AXES.reduce((s, a) => s + a.weight, 0);
    const segs = AXES.map((a) => {
      const pct = (a.weight / totalW) * 100;
      const label = `<span class="vt-axesboard-seg-label">${a.label}</span>`;
      return `<span class="vt-axesboard-seg"
        data-axis="${a.key}" style="flex-basis:${pct.toFixed(2)}%;"
        title="${esc(a.label)} \u00b7 ${axisShareLabel(a.weight)}">${label}</span>`;
    }).join('');
    const board = `<div class="vt-axesboard" role="img"
      aria-label="The scoring axes sized by weight">${segs}</div>`;
    return buildStageBlock('axes', AXES_STEPS, board,
      { mode: 'solo', hint: 'Press <strong>Next</strong> to spotlight each axis.' });
  }

  // Plain shares table (shared by the modal + the axes tab).
  // Raw AXES weights are renormalized the same way elo.py does, so the
  // column is the share of the match score and the total row is 100%.
  function weightsTableHtml() {
    const rows = AXES.map((a) =>
      `<tr><td><strong>${a.label}</strong><br><small class="text-muted">${a.blurb}</small></td>
       <td class="text-end align-top">${axisShareLabel(a.weight)}</td></tr>`).join('');
    return `<table class="vt-katex-weights">
      <thead><tr><th>Axis</th><th class="text-end">Share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Plain tier-ladder table (shared by the modal + the How tab).
  // Rows come from VTSRDisplay.tiers() (elo_current.json band_config).
  function tierTableHtml() {
    const tiers = window.VTSRDisplay ? window.VTSRDisplay.tiers() : [];
    const last = tiers.length - 1;
    const rows = tiers.map((t, i) => {
      const range = t.max === Infinity ? `&ge; ${t.min}` : `${t.min} \u2013 ${t.max - 1}`;
      const note = i === 0 ? 'top tier, no upper limit'
        : t.min === 1500 ? 'everyone starts here, at 1500'
          : i === last ? `ratings stop falling at ${t.min}` : '';
      return [t.label, range, note];
    }).map(([n, r, note]) =>
      `<tr><td><strong>${n}</strong></td><td class="text-end"><code>${r}</code></td>
       <td class="text-muted"><small>${esc(note)}</small></td></tr>`).join('');
    return `<table class="vt-katex-tiers">
      <thead><tr><th>Tier</th><th class="text-end">Rating range</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Shared prose sections (modal + How tab reuse these verbatim).
  function commanderSectionHtml() {
    return `<p class="mb-2">Commanders spend most of the game at base, so they deal less damage than thugs. When you command, your bar drops by the usual commander shortfall, measured from past commander games.</p>
      <p class="mb-0 text-muted small">A commander who also fights well clears the lower bar and goes up.</p>`;
  }

  // Worked example (real numbers from data/processed/elo_history.json,
  // ELO_SCHEMA_VERSION 22: Domakus 2026-10-09T01-20-18 — before=1946.67,
  // after=1967.88, delta=+21.21, performance=+0.9509, expected=+0.4320,
  // K back-solved = 21.21 / (2.5 * 0.5189) = 16.35, so one full point of
  // surprise is worth K * ELO_RATING_SCALE = 16.35 * 2.5 = 40.9 rating
  // points — the "about 41" below). Re-read that history entry after any
  // re-rate; the values shift even though the story doesn't. Gate:
  // _investigation/check_explainer_examples.mjs.
  function workedExampleHtml() {
    return `<p class="mb-2">A real game from October 2026: <strong>Domakus</strong> went from <strong>1946.7</strong> to <strong>1967.9</strong>.</p>
      <ul class="mb-0">
        <li>His match score was <strong>+0.95</strong>, the best in the lobby. The scale runs from about &minus;1 to +1, and 0 is an average game.</li>
        <li>His bar was <strong>+0.43</strong>. He was already rated high, so a lot was expected of him.</li>
        <li>He beat the bar by 0.52. At his move speed a full point of surprise is worth about 41 rating points, so he gained 21.2.</li>
      </ul>`;
  }

  // ------------------------------------------------------------------
  // The commander ladder (VSR-C) — static section for the ELO page's
  // How tab. Plain copy first: what the duel is, why the thugs matter,
  // a worked example, the F9bomber games, and the economy read
  // (recorded, not scored). The KaTeX handicap formula, K, the economy
  // rule and the ranking gates sit in a collapsed mathDetailsHtml()
  // block. Worked-example digits are real corpus
  // numbers (elo_commander_history.json, CMDR_ELO_SCHEMA_VERSION 15,
  // 2026-08-23T03-25-36 Oldboy: team_handicap.diff=23.67, F9bomber
  // before 1607.44 expected 0.6895 delta -13.79, mort before 1492.49
  // expected 0.3105 delta +13.79.
  // Re-read that duel after any re-rate; the values shift even though
  // the story doesn't).
  // Returns '' while KaTeX is still loading (callers render it after
  // deltaRBlockHtml succeeded, so in practice KaTeX is present).
  // ------------------------------------------------------------------
  // `tail` is optional trusted HTML appended to the closing plain
  // paragraph (the ELO page passes its link to the ladder tab).
  function commanderLadderHtml(tail) {
    const eq = renderEq(
      'E_A \\;=\\; \\frac{1}{1 + 10^{-\\left(\\left(R_A - R_B\\right)'
      + ' + \\lambda\\,\\left(T_A - T_B\\right)\\right) / 400}}'
    ) || '';
    const math = `${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2"><em>E</em> is a commander&rsquo;s chance of winning. <em>R</em> is each commander&rsquo;s rating and <em>T</em> is the average VSR-T of that team&rsquo;s thugs before the game. <em>&lambda;</em> is 1, so a 100-point thug edge counts the same as a 100-point commander edge.</p>
      <p class="mb-2">A commander&rsquo;s move speed K starts at 40 and falls to 20 over their first 5 duels. There is no loss discount and no floor.</p>
      <p class="mb-2">F9bomber&rsquo;s games move ratings as much as recorded ones. For games played before any thug ratings existed, the thug term is zero.</p>
      <p class="mb-2">The economy read is four stats measured over the whole game: pools held, time the scrap bank spent out of green, scrap spent on combat ships (empty scouts and empty Xypos left out), and upgrades held. It would count only after a fresh batch of games, recorded after 23 Oct 2026, passes a rule written in advance. Leading a stat in a game you also won is not enough to pass it. Three more readouts are shown and never scored: ships built per ship lost, the same without empty scouts, and how much of the scrap earned was loose collected by scavengers.</p>
      <p class="mb-0">A numbered rank needs 8 games recorded with economy data or 25 older games (earlier recordings and F9bomber&rsquo;s log), a game within 90 days of the newest match, and a game as commander within 90 days. A commander who kept playing thug but stopped commanding needs 3 commander games to get the rank back.</p>`;
    return `<p class="mb-2">VSR-C rates commanding, and it counts wins and losses only. Each rated game is a duel between the two commanders. Beat a commander you were expected to lose to and you gain a lot. Beat one you were expected to beat and you gain a little.</p>
      <p class="mb-2">Two things decide who is expected to win: the two commanders&rsquo; ratings, and <strong>which side has the stronger thugs</strong>. A commander with a stacked team is supposed to win, so that win pays less and a loss costs more.</p>
      <p class="mb-2">A real game: on Oldboy (2026-08-23), F9bomber was rated 1607 and mort 1492, and F9bomber&rsquo;s thugs averaged <strong>+24 stronger</strong>. That made him the <strong>69% favorite</strong>, and he lost. The result was <strong>&minus;13.8</strong> for F9bomber and <strong>+13.8</strong> for mort.</p>
      <p class="mb-2">The ladder also counts hundreds of games from <a href="https://f9bomber.com" target="_blank" rel="noopener">F9bomber</a>&rsquo;s hand-kept match log: 3v3, 4v4 and 5v5 games from 2025 on. When we have our own recording of a game, the recording is used and the log entry is dropped. Logged games are tagged on the ladder and in every duel log.</p>
      <p class="mb-2">Newer recordings also track how each commander ran their economy. That is <strong>recorded, not scored</strong>. It does not move VSR-C.</p>
      <p class="mb-0 text-muted small">A commander is <strong>provisional</strong> for their first 5 rated games. A numbered rank takes more games and recent play. Everyone else is listed in the Unranked table.${tail || ''}</p>
      ${mathDetailsHtml('The math: formula, thug handicap and ranking rules', math)}`;
  }

  // ------------------------------------------------------------------
  // The 1v1 ladder (VSR-1v1) — static How-tab section. Plain Elo, no
  // handicap. Worked-example digits are real (elo_1v1_history.json,
  // 2026-10-15T23-37-32 Mojave: Maverick 1500.00 expected 0.5076, Nomad
  // 1494.74 expected 0.4924, shared K 32, delta 16.24). Re-read that
  // game after any re-rate.
  // ------------------------------------------------------------------
  function oneVOneLadderHtml() {
    const eq = renderEq(
      'E_A \\;=\\; \\frac{1}{1 + 10^{-\\left(R_A - R_B\\right) / 400}}'
    ) || '';
    const math = `${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2">There are no thugs, so there is no thug term. Both players use the same K: the average of their two schedules, each 40 for a first game falling to 20 after five. That is why one player&rsquo;s gain equals the other&rsquo;s loss.</p>
      <p class="mb-0">Draws are not rated and game length does not matter. A player is provisional below 5 rated 1v1s. A numbered rank needs 5 rated 1v1s and a game of any kind within 90 days of the newest match.</p>`;
    return `<p class="mb-2">A 1v1 has its own rating, VSR-1v1. Both players command and nobody else is on the field, so neither VSR-T nor VSR-C applies. It is plain win/loss Elo: what one player gains, the other loses.</p>
      <p class="mb-2">A game counts when one player sits on each side (camera pods don&rsquo;t count) and it has a recorded winner. Only recorded games count. F9bomber&rsquo;s log lists just the two commanders for most games, so a 1v1 there looks the same as a team game.</p>
      <p class="mb-0 text-muted small">A real game: on Mojave (2026-10-15), Maverick played his first 1v1 at 1500 against Nomad at 1495, which made Maverick a <strong>51% favorite</strong>. Nomad won. The result was <strong>+16.2</strong> for Nomad and <strong>&minus;16.2</strong> for Maverick.</p>
      ${mathDetailsHtml('The math: formula and ranking rules', math)}`;
  }

  // ------------------------------------------------------------------
  // The 2v2 ladders (VSR-2v2C + VSR-2v2T) — static How-tab section.
  // Worked-example digits are real (elo_2v2_history.json,
  // 2026-10-27T04-00-33 Oasis: mort 1520.00 + HappyOtter 1481.00 vs
  // VTrider 1500.00 + DraconisMarch 1500.00, expected 0.5014, K 38/38,
  // delta 19.05; performance expected 0.4861 vs share 0.3845, K 38,
  // delta 3.86). Re-read that game after any re-rate.
  // ------------------------------------------------------------------
  function twoVTwoLaddersHtml() {
    const eq = renderEq(
      'E_1 \\;=\\; \\frac{1}{1 + 10^{-\\left(\\left(C_1 - C_2\\right)'
      + ' + \\lambda\\,\\left(T_1 - T_2\\right)\\right) / 400}}'
    ) || '';
    const math = `${eq ? `<div class="text-center my-2" style="overflow-x: auto;">${eq}</div>` : ''}
      <p class="mb-2"><em>E</em> is a side&rsquo;s chance of winning. <em>C</em> is each commander&rsquo;s 2v2C and <em>T</em> is each thug&rsquo;s win/loss 2v2T. <em>&lambda;</em> is 1, as in VSR-C.</p>
      <p class="mb-2">Every rating starts at 1500, with K falling from 40 to 20 over a player&rsquo;s first five games on that ladder. Both players in a role share one K, so one player&rsquo;s gain equals the other&rsquo;s loss.</p>
      <p class="mb-0">Only recorded games with a recorded winner count. A recording shows who commanded and who stayed active, and a hand-kept result does not. A player is provisional below 5 games on a ladder. A numbered rank needs 5 games and one within 90 days of the newest match.</p>`;
    return `<p class="mb-2">A 2v2 is a commander and one thug on each side. It has its own ratings, shown as numbers and kept separate from VSR-T and VSR-C.</p>
      <p class="mb-2"><strong>VSR-2v2C</strong> rates the commanders on wins and losses. All four players&rsquo; ratings decide which side is expected to win.</p>
      <p class="mb-2">Thugs have <strong>two ratings for now</strong>. <strong>Win/loss</strong> moves with the result. <strong>Performance</strong> compares the two thugs: your share of their combined damage to the enemy, against the share your ratings predicted. Once 30 recorded 2v2s exist, a rule written in advance keeps whichever one predicts winners better, or both if neither does.</p>
      <p class="mb-0 text-muted small">A real game: on Oasis (2026-10-27), mort (1520) and HappyOtter (1481) faced VTrider and DraconisMarch, both playing their first 2v2 at 1500. The ratings cancelled out, so it was a <strong>coin flip (50%)</strong>. VTrider&rsquo;s side won and each player took <strong>+19.1</strong>. mort and HappyOtter each took <strong>&minus;19.1</strong>. On performance, HappyOtter was expected to deal 49% of the two thugs&rsquo; damage and dealt 38%, so <strong>3.9</strong> points went from him to DraconisMarch.</p>
      ${mathDetailsHtml('The math: formula and ranking rules', math)}`;
  }

  // "Which ladder rates my game?" — the format lines, shared by the How
  // tab. Mirrors scripts/match_format.py.
  function formatLinesHtml() {
    // VSR-1v1 / VSR-2v2 are hidden while the js/vtsr-display.js switch
    // is false, so those two rows read as not rated.
    const smallFormat = !!(window.VTSRDisplay && window.VTSRDisplay.SMALL_FORMAT_RATINGS_VISIBLE);
    const smallRows = smallFormat
      ? `<tr><td>1 and 1</td><td>VSR-1v1</td><td>Both players command.</td></tr>
          <tr><td>2 and 2</td><td>VSR-2v2C + VSR-2v2T</td><td>A commander and one thug per side. Nobody left early and both thugs dealt damage.</td></tr>`
      : `<tr><td>1 and 1</td><td>None</td><td>1v1 games are not rated.</td></tr>
          <tr><td>2 and 2</td><td>None</td><td>2v2 games are not rated.</td></tr>`;
    const otherNote = smallFormat
      ? '2v1, 3v1, 3v2, 4v2, or a 2v2 where a player sat idle or left.'
      : '2v1, 3v1, 3v2 or 4v2.';
    return `<div class="vt-elo-format-lines">
      <p class="mb-2">Count the players on each side. Leave out anyone who spent more than a quarter of the game in a camera pod.</p>
      <table class="table table-sm align-middle mb-2" style="font-size: 0.85rem;">
        <thead><tr><th>Players per side</th><th>Rated by</th><th>Notes</th></tr></thead>
        <tbody>
          ${smallRows}
          <tr><td>3 or more on each side</td><td>VSR-T + VSR-C</td><td>VSR-T rates every player. VSR-C rates the two commanders.</td></tr>
          <tr><td>Anything else</td><td>None</td><td>${otherNote}</td></tr>
        </tbody>
      </table>
      <p class="mb-0 text-muted small">A rated game also needs a recorded winner: the host&rsquo;s result, a destroyed recycler or factory, or a reviewer&rsquo;s sign-off. Draws are not rated. Game length does not matter.</p>
    </div>`;
  }

  // ------------------------------------------------------------------
  // Dashboard methodology modal body (quick reference). Preserves the
  // v3 5-section structure but the "How it works" section is now the
  // annotated deltaR stage. Cached after first successful build; null
  // until KaTeX loads (caller retries on next modal open).
  // ------------------------------------------------------------------
  let methodologyCache = null;
  function methodologyModal() {
    if (methodologyCache) return methodologyCache;
    const deltaBlock = deltaRBlockHtml();
    if (!deltaBlock) return null;
    methodologyCache = `<div class="vt-katex-tooltip-body">

      <section class="vt-vtsr-doc-section">
        <h6>How it works</h6>
        <p class="mb-1">VSR-T rates how well you fight. After each rated game we take your share of all the damage your lobby did to the enemy and compare it with what a player at your rating was expected to deal against that team. Beat that bar and you go up. Fall short and you go down. Winning the game does not move it. Everyone starts at <strong>1500</strong>.</p>
        ${deltaBlock}
        <p class="mb-0 mt-2 text-muted small">A drop is cut to 85% of what the formula says, and no rating falls below <strong>1000</strong>.</p>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>What counts</h6>
        ${weightsTableHtml()}
        <div class="vt-katex-caveat">${RETIRED_AXES_NOTE}</div>
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>If you commanded the match</h6>
        ${commanderSectionHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Tier ladder</h6>
        <p class="mb-2">Tiers are fixed point ranges, not percentiles, so the top tier can be nearly empty. Each tier splits into an Upper and a Lower half. Players with fewer than 10 rated games show <strong>Provisional</strong> instead of a tier. A place on the ladder needs <strong>25 rated games</strong> and a game within 90 days of the newest recorded match, or 3 games after a longer break. Everyone else is listed under <strong>Not on the ladder yet</strong>.</p>
        ${tierTableHtml()}
      </section>

      <section class="vt-vtsr-doc-section">
        <h6>Real example</h6>
        ${workedExampleHtml()}
      </section>

    </div>`;
    return methodologyCache;
  }

  window.VTSRExplain = {
    AXES,
    RETIRED_AXES_NOTE,
    initIn,
    deltaRBlockHtml,
    blendBlockHtml,
    mathDetailsHtml,
    axesBoardHtml,
    weightsTableHtml,
    tierTableHtml,
    commanderSectionHtml,
    commanderLadderHtml,
    oneVOneLadderHtml,
    twoVTwoLaddersHtml,
    formatLinesHtml,
    workedExampleHtml,
    methodologyModal,
  };
})();
