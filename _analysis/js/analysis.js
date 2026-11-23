/**
 * Playstyle Analysis (/_analysis/).
 *
 * Renders data/index.json, built by scripts/build_analysis_data.py. The page
 * only sorts, ranks and runs display statistics (rolling means, medians, a
 * rank-sum test, a change-point search) over pre-computed per-match numbers.
 * It computes no ratings. Leader titles and metric copy live here so a rename
 * never needs a data rebuild.
 */
(function () {
  'use strict';

  const DATA_URL = 'data/index.json';
  const MATCH_URL = (id) => `data/match/${encodeURIComponent(id)}.json`;
  // Past this many selected players the charts switch to thin lines and a
  // collapsed chip; it is the number of theme palette colours.
  const CROWD = 6;
  const DAY = 86400000;
  const BIN_MS = 50;

  // ---------------------------------------------------------------------
  // Copy
  // ---------------------------------------------------------------------

  const METRIC_COPY = {
    sw_rate: { label: 'Switches per minute', explain: 'Weapon-group switches per minute spent firing.', fmt: 'num1' },
    sw_1tick: { label: 'One-tick returns', explain: 'Share of round trips, out to a slower weapon and back, where the first weapon fired again on the first tick it could.', fmt: 'pct' },
    sw_median: { label: 'Median return delay', explain: 'Typical time from the moment the first weapon could fire again to its next shot, over round trips out to a slower weapon and back. One tick is the fastest: 50 ms at 20 Hz, less in the rare 30 and 60 Hz recordings.', fmt: 'ms' },
    even_share: { label: 'Even-beat streaks', explain: 'Share of tested alternation streaks whose beat is steadier than 99% of shuffles of their own gaps.', fmt: 'pct' },
    period: { label: 'Alternation cycle', explain: 'Median time for one full cycle back to the slower weapon in alternation streaks.', fmt: 'ms' },
    jitter: { label: 'Beat wobble', explain: 'How far, typically, each slow-weapon shot in a streak lands from a perfectly steady beat. Lower is steadier.', fmt: 'jit' },
    clock_share: { label: 'Clock-steady cycles', explain: 'Share of alternation cycles inside runs of 10+ that stay within 55 ms of a straight beat. A reload that is a whole number of ticks makes this easier.', fmt: 'pct' },
    dot_share: { label: 'On the dot', explain: 'Share of switch-backs fired within 50 ms of the slow weapon becoming ready.', fmt: 'pct' },
    seam_share: { label: 'Seamless', explain: 'Share of switch-backs that cost the fast weapon no more than 50 ms of fire.', fmt: 'pct' },
    perfect_share: { label: 'On the dot and seamless', explain: 'Both at once: back on the slow weapon the moment it is ready, with no fire lost on the fast one.', fmt: 'pct' },
    margin: { label: 'Switch-back margin', explain: 'Median time between the slow weapon becoming ready and the shot that followed.', fmt: 'ms' },
    drops_per_k: { label: 'Mid-cycle drops', explain: 'Mines or other drops released inside an alternation cycle, per 1,000 cycles on a ship carrying one.', fmt: 'num1' },
    multi_share: { label: 'Same-tick fire', explain: 'Share of firing ticks where two weapon groups fired together.', fmt: 'pct' },
    pvp_hit: { label: 'PvP hit share', explain: 'Shots that hit an enemy player, over all shots fired.', fmt: 'pct' },
    accuracy: { label: 'Accuracy', explain: 'Hits over shots fired, from 18 Oct 2026 on, when the recorder started counting every hit.', fmt: 'pct' },
    tkey: { label: 'T-key time', explain: 'Share of time spent with a target locked (T key).', fmt: 'pct' },
    pvp_kd: { label: 'PvP K/D', explain: 'Player kills per player death.', fmt: 'num2' },
    dpm: { label: 'Damage per minute', explain: 'All damage dealt per minute in a ship.', fmt: 'num0' },
    pvp_dpm: { label: 'PvP damage per minute', explain: 'Damage to enemy players per minute in a ship.', fmt: 'num0' },
  };

  const GROUP_LABELS = {
    switching: 'Switching', rhythm: 'Rhythm', reload: 'Reload timing', combat: 'Combat', sanity: 'Sanity checks',
  };

  // `sub` is the rule a board ranks by; `game` is the same rule as a play.
  // Reloads quoted in `game` are the VSR ODF values.
  const SWITCH_BACK_RULE = 'The cleanest switch-backs in one match: the share where the slow weapon fired within 50 ms of '
    + 'reloading and the other weapon lost no more than 50 ms of fire.';
  const LEADER_TITLES = {
    fast_hands: {
      title: 'Fast Hands', icon: 'bi-hand-index-thumb',
      sub: 'The quickest rotation held for a streak: the shortest slow → fast → slow cycle over 10 or more cycles in a row. Ties go to the longer streak.',
      game: 'Dragon Blast reloads in 0.3 s, so Dragon Blast → Shell Gun → Dragon Blast can\'t average under 300 ms. A 300 ms streak means every Dragon Blast left the moment it reloaded.',
      pairGame: (x) => `${x.A} reloads every ${msTxt(x.R)}${x.on}, so ${x.A} → ${x.B} → ${x.A} can't average under `
        + `${msTxt(x.R)} a cycle. That leaves ${msTxt(x.win)} of ${x.B}, ${volleyTxt(x)}. A ${x.R.toLocaleString()} ms streak `
        + `means every ${x.A} left the moment it reloaded.`,
    },
    quick_draw: {
      title: 'Quick Draw', icon: 'bi-stopwatch',
      sub: 'The fastest typical return in one match: the median time from the moment the first weapon could fire again to its next shot, over 30+ round trips out to a slower weapon and back. Ties at 50 ms go to the larger share of one-tick returns.',
      game: 'A Minigun round, one FAF Msl, and the Minigun again on the very next tick. The recording ticks every 50 ms, so 50 ms is the fastest return it can see.',
      pairGame: (x) => `The ${x.B} firing${x.on}, one ${x.A}, and the ${x.B} again on the first tick it can fire. The `
        + 'recording ticks every 50 ms, so 50 ms is the fastest return it can see.',
    },
    button_masher: {
      title: 'Button Masher', icon: 'bi-controller',
      sub: 'Most weapon switches per minute of firing in one match (2+ firing minutes).',
      game: 'Trading FAF Msl and Minigun on every 1 s FAF Msl reload is two switches a cycle, up to 120 a minute. Most players switch 10 to 30 times a minute.',
      pairGame: (x) => `Trading ${x.A} and ${x.B} on every ${msTxt(x.R)} ${x.A} reload${x.on} is two switches a cycle, `
        + `up to ${x.swMax} a minute. Most players switch 10 to 30 times a minute.`,
    },
    metronome: {
      title: 'The Metronome', icon: 'bi-music-note-beamed',
      sub: 'The longest run of alternation cycles that stays inside a 55 ms band (about one tick) around a straight, unchanging beat. 10+ cycles.',
      game: 'Dragon Blast → Shell Gun at a steady 310 ms, cycle after cycle, never drifting a tick ahead or behind. A reload that is a whole number of ticks makes it easier.',
      pairGame: (x) => `${x.A} → ${x.B}${x.on} at a steady ${x.R.toLocaleString()} to ${(x.R + 50).toLocaleString()} ms `
        + `(${x.Rt} to ${x.Rt + 1} ticks), cycle after cycle, never drifting a tick ahead or behind. One tick is `
        + `${x.tick} of this cycle.`,
    },
    swiss_watch: {
      title: 'Swiss Watch', icon: 'bi-watch',
      sub: 'The most evenly timed streak: its shots are compared with 1,000 shuffles of its own gaps, and the lowest p (the rarer it is to be that even by chance) wins. Ties go to the longer streak.',
      game: 'Gaps of 6 6 7 6 6 7 6 6 7 ticks keep a steady beat; the same gaps as 6 6 6 6 6 6 7 7 7 drift two ticks off it and score worse. A streak whose gaps are all 6 can\'t be shuffled, so it isn\'t tested.',
      pairGame: (x) => {
        const a = x.Rt;
        const b = x.Rt + 1;
        return `${x.A}${x.on} reloads in ${a} ticks. Gaps of ${[a, a, b, a, a, b, a, a, b].join(' ')} keep a steady beat; `
          + `the same gaps as ${[a, a, a, a, a, a, b, b, b].join(' ')} drift two ticks off it and score worse. A streak `
          + `whose gaps are all ${a} can't be shuffled, so it isn't tested.`;
      },
    },
    hair_trigger: {
      title: 'Hair Trigger', icon: 'bi-lightning', sub: SWITCH_BACK_RULE,
      game: 'Dragon Blast (0.3 s) with a Shell Gun on a Xares SGS: the gun right up to the tick the Dragon Blast is ready, then the Dragon Blast at once.',
      pairGame: reloadClassGame('hair_trigger', (x) => ` One tick late is ${x.tick} of the cycle.`),
    },
    clockwork: {
      title: 'Clockwork', icon: 'bi-gear', sub: SWITCH_BACK_RULE,
      game: 'FAF Msl (1 s) with a Minigun between shots on an ISDF Scout: a second of Minigun, then the FAF Msl within 50 ms of its reload.',
      pairGame: reloadClassGame('clockwork'),
    },
    right_on_cue: {
      title: 'Right On Cue', icon: 'bi-hourglass-split', sub: SWITCH_BACK_RULE,
      game: 'Arc Cannon (2 s) with a Gauss Gun on a Scion Warrior: two seconds of the gun, then the Arc Cannon within 50 ms of its reload. The longer the wait, the harder it is to time by feel.',
      pairGame: reloadClassGame('right_on_cue', () => ' The longer the wait, the harder it is to time by feel.'),
    },
    sw_rate: {
      title: 'The Juggler', icon: 'bi-arrow-repeat',
      sub: 'Weapon switches per minute of firing, over every match in the range.',
      game: 'FAF Msl with Minigun between shots is two switches every 1 s reload, 120 a minute at most; holding one gun and changing only for a finisher is a handful. Most players sit at 10 to 30.',
      pairGame: (x) => `${x.A} with ${x.B} between shots${x.on} is two switches every ${msTxt(x.R)} reload, `
        + `${x.swMax} a minute at most; holding one gun and changing only for a finisher is a handful. Most players sit at 10 to 30.`,
    },
    sw_1tick: {
      title: 'FastHands.exe', icon: 'bi-lightning-charge-fill',
      sub: 'Share of trips out to a slower weapon and back where the first weapon fired again on the first tick it could (50 ms): right after the slower shot, or the moment its own reload ended. Only the way back is timed, since scrolling out while holding fire costs nothing. Read from the shots: the recording has no switch event.',
      game: 'Minigun, one FAF Msl, then the Minigun again the moment it is ready is a one-tick return. Back 200 ms later, it is not.',
      pairGame: (x) => `${x.onLead ? `${x.onLead}the` : 'The'} ${x.B}, one ${x.A}, then the ${x.B} again the moment it is `
        + 'ready is a one-tick return. Back 200 ms later, it is not.',
    },
    even_share: {
      title: 'Little Drummer Boy', icon: 'bi-music-note',
      sub: 'Share of a player\'s tested streaks whose beat is steadier than 99% of shuffles of their own gaps.',
      game: 'Dragon Blast → Shell Gun falling into a regular 6 6 7 tick pattern streak after streak, not just once.',
      pairGame: (x) => `${x.A} → ${x.B}${x.on} falling into a regular ${x.Rt} ${x.Rt} ${x.Rt + 1} tick pattern streak after `
        + 'streak, not just once.',
    },
    jitter: {
      title: 'Steady Hand', icon: 'bi-activity',
      sub: 'How far a player\'s slow-weapon shots drift from a steady beat during streaks, as the middle value over all '
        + 'their streaks. 0 ms means every shot lands exactly on the beat. Lower is steadier.',
      game: 'In a Dragon Blast → Shell Gun streak, each Dragon Blast lands about this far before or after a perfectly steady '
        + 'beat. 0 ms is every one on the beat; 25 ms is about half a tick early or late, 8% of a 300 ms cycle. Past 40 ms '
        + 'the streak is too uneven to place.',
      pairGame: (x) => `In a ${x.A} → ${x.B} streak${x.on}, each ${x.A} lands about this far before or after a perfectly `
        + `steady beat. 0 ms is every one on the beat; 25 ms is about half a tick early or late, ${pct(25 / x.R, 0)} of a `
        + `${msTxt(x.R)} cycle. Past 40 ms the streak is too uneven to place.`,
    },
    dot_share: {
      title: 'On the Dot', icon: 'bi-record-circle',
      sub: 'Share of switch-backs where the slow weapon fired within 50 ms of reloading.',
      game: 'FAF Msl reloads in 1 s, so the next FAF Msl goes out 1.00 to 1.05 s after the last one.',
      pairGame: (x) => `${x.A} reloads in ${msTxt(x.R)}${x.on}, so the next ${x.A} goes out ${msTxt(x.R)} to `
        + `${msTxt(x.R + 50)} after the last one. That 50 ms window is ${x.tick} of the cycle.`,
    },
    seam_share: {
      title: 'Smooth Operator', icon: 'bi-wind',
      sub: 'Share of switch-backs where the fast weapon lost no more than 50 ms of fire.',
      game: 'The Minigun keeps firing right up to the tick the FAF Msl goes out, instead of going quiet while the player waits for it.',
      pairGame: (x) => `The ${x.B} keeps firing right up to the tick the ${x.A} goes out${x.on}: the ${msTxt(x.win)} between `
        + `${x.A} shots fits ${x.volleys === 1 ? 'one volley' : `${x.volleys} volleys`}, and a seamless switch-back fires `
        + `${x.volleys === 1 ? 'it' : 'every one'}.`,
    },
    margin: {
      title: 'Zero Lag', icon: 'bi-speedometer2',
      sub: 'Median time between the slow weapon reloading and the shot that followed. Lower is quicker.',
      game: 'FAF Msl ready at 1.0 s and fired at 1.0 s is 0 ms; fired at 1.3 s it is 300 ms.',
      pairGame: (x) => `${x.A}${x.on} ready at ${msTxt(x.R)} and fired on that tick is 0 ms; a tick later is 50 ms, `
        + `${x.tick} of its cycle.`,
    },
    drops_per_k: {
      title: 'Butterfingers', icon: 'bi-droplet',
      sub: 'Mines and other drops released inside an alternation cycle, per 1,000 cycles on a ship carrying one. '
        + 'A ship counts when its stock item is one the recording can see, or when the player dropped something from it '
        + 'in that match.',
      game: 'A Prox Mine dropped between two Combat Laser shots on a Xares, with the Particle Gun firing in between.',
      pairGame: (x) => `${x.drop ? withArticle(x.drop) : 'A mine or other drop'} released between two ${x.A} `
        + `shots${x.on}, inside the ${msTxt(x.win)} of ${x.B}, without breaking the rhythm.`,
    },
    // Combat examples stay the most common cases: the Scout is the player ship destroyed most, the
    // Scavenger the AI unit, the Extractor the building; the Chain Gun deals the most damage and the
    // Minigun lands the most hits on players.
    pvp_hit: {
      title: 'Deadeye', icon: 'bi-bullseye',
      sub: 'Shots that hit an enemy player, over every shot fired.',
      game: 'Minigun rounds landing on an enemy Scout count; rounds into a Scavenger, a building or the ground don\'t.',
    },
    accuracy: {
      title: 'Eagle Eye', icon: 'bi-eye',
      sub: 'Hits over shots fired, from 18 Oct 2026 on.',
      game: 'Any hit counts: an enemy Scout, a Scavenger, an Extractor. Before 18 Oct the recorder counted only hits on players.',
    },
    tkey: {
      title: 'Tunnel Vision', icon: 'bi-binoculars',
      sub: 'Median share of a match spent with a target locked (T key).',
      game: 'Pressing T on an enemy Scout and keeping it locked through the fight.',
    },
    pvp_kd: {
      title: 'The Undertaker', icon: 'bi-person-x',
      sub: 'Player kills per player death, over every match in the range.',
      game: 'Destroying an enemy Scout counts. Shooting its ejected pilot afterwards doesn\'t, and neither does dying on foot.',
    },
    dpm: {
      title: 'Wrecking Ball', icon: 'bi-tornado',
      sub: 'All damage dealt per minute in a ship.',
      game: 'Chain Gun fire into an enemy Scavenger counts the same as Chain Gun fire into an enemy Scout.',
    },
    pvp_dpm: {
      title: 'Heavy Hitter', icon: 'bi-hammer',
      sub: 'Damage to enemy players per minute in a ship.',
      game: 'Minigun fire into an enemy Scout counts; the same fire into their Scavenger doesn\'t.',
    },
  };

  const RECORD_BOARDS = ['fast_hands', 'quick_draw', 'button_masher', 'metronome', 'swiss_watch',
    'hair_trigger', 'clockwork', 'right_on_cue'];
  const STREAK_BOARDS = new Set(['fast_hands', 'metronome', 'swiss_watch']);
  // Share of a board's moments that counts toward Most often.
  const MOMENT_TOP = 0.1;
  const CAREER_BOARDS = ['sw_rate', 'sw_1tick', 'even_share', 'dot_share', 'jitter', 'seam_share', 'margin',
    'drops_per_k', 'pvp_hit', 'accuracy', 'tkey', 'pvp_kd', 'dpm', 'pvp_dpm'];
  const RELOAD_CLASSES = {
    hair_trigger: { lo: 0, hi: 499.999, label: 'Reloads under 0.5 s' },
    clockwork: { lo: 500, hi: 1500, label: 'Reloads of 0.5 to 1.5 s' },
    right_on_cue: { lo: 1500.001, hi: Infinity, label: 'Reloads over 1.5 s' },
  };
  const RELOAD_MIN_SB = 30;
  const RELOAD_SORTS = ['name', 'best', 'worst'];
  const QUICK_DRAW_TRIPS = 30;
  // The weapon-pair filter does not reach these boards; their example only illustrates the pair.
  const PAIR_BLIND = new Set(['quick_draw', 'button_masher', 'sw_rate', 'sw_1tick']);
  // Boards the weapon-pair filter reaches: a ship that never used the pair leaves them empty.
  const PAIR_FILTERED = new Set(['even_share', 'jitter', 'dot_share', 'seam_share', 'margin', 'drops_per_k',
    'fast_hands', 'metronome', 'swiss_watch', 'hair_trigger', 'clockwork', 'right_on_cue']);
  // T-key time and PvP damage are recorded per match, not per ship.
  const NO_SHIP_SPLIT = new Set(['tkey', 'pvp_dpm']);
  // Career boards that can score a single pair. The share-only ones can name a pair but not score it: the
  // switch boards only keep each match's most-switched pair (or most-used round trip).
  const PAIR_EXACT = new Set(['even_share', 'jitter', 'dot_share', 'seam_share', 'margin', 'drops_per_k']);
  const PAIR_SHARE_ONLY = new Set(['sw_rate', 'sw_1tick']);

  function msTxt(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms % 100 ? 2 : 1)} s`;
  }

  // "An MFF Mine", "A MITS Mine": a leading acronym of three letters or fewer is read letter by letter.
  function article(name) {
    const lead = name.split(' ')[0];
    const spelled = lead.length <= 3 && /^[A-Z]{2,}$/.test(lead);
    return (spelled ? /^[AEFHILMNORSX]/ : /^[AEIOU]/i).test(name) ? 'An' : 'A';
  }

  // "A Seeker or a Solar Flare": a drop the recording can't tell apart names both items.
  function withArticle(name) {
    return name.split(' or ').map((n, i) => `${i ? article(n).toLowerCase() : article(n)} ${n}`).join(' or ');
  }

  function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  }

  // "18 MFF Mines, 9 Prox Mines, 1 MITS Mine or Solar Flare", most first.
  function dropItemsText(agg) {
    return [...agg.ditems].sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .map(([i, c]) => (c === 1 ? `1 ${D.dropItems[i]}` : `${c.toLocaleString()} ${D.dropItems[i].split(' or ').map((n) => `${n}s`).join(' or ')}`))
      .join(', ');
  }

  function volleyTxt(x) {
    return x.volleys === 1 ? `one ${x.B} volley` : `up to ${x.volleys} volleys`;
  }

  function reloadClassGame(id, tail) {
    return (x) => {
      if (x.cls !== id) {
        return `${x.A} reloads in ${msTxt(x.R)}${x.on}, so ${x.A} + ${x.B} ranks on ${LEADER_TITLES[x.cls].title}, not here.`;
      }
      return `${x.A} (${msTxt(x.R)}) with the ${x.B} between shots${x.on}: ${msTxt(x.win)} of ${x.B}, ${volleyTxt(x)}, `
        + `then the ${x.A} within 50 ms of its reload.${tail ? tail(x) : ''}`;
    };
  }

  const GATE_LABELS = {
    swa: (v) => `${Math.round(v / 60)}+ firing minutes`,
    swn: (v) => `${v}+ switches`,
    rtn: (v) => `${v}+ round trips`,
    stt: (v) => `${v}+ tested streaks`,
    stk: (v) => `${v}+ streaks`,
    cyc: (v) => `${v}+ cycles`,
    cycm: (v) => `${v}+ cycles carrying a mine`,
    sb: (v) => `${v}+ switch-backs`,
    vol: (v) => `${v}+ firing ticks`,
    sf: (v) => `${v}+ shots fired`,
    tkn: (v) => `${v}+ matches with T-key data`,
    n: (v) => `${v}+ matches`,
    mins: (v) => `${v}+ minutes in a ship`,
  };

  // Smallest per-match sample before a single match gets a value on a chart.
  const MATCH_GATE = {
    sw_rate: 20, sw_1tick: 5, sw_median: 5, even_share: 2, period: 1, jitter: 1, clock_share: 20,
    dot_share: 10, seam_share: 10, perfect_share: 10, margin: 10, drops_per_k: 50, multi_share: 30,
    pvp_hit: 50, accuracy: 50, tkey: 1, pvp_kd: 1, dpm: 2, pvp_dpm: 2,
  };

  const WHY_LABELS = {
    utility: 'Utility, no reload timing',
    dispenser: 'Dispenser, fires no rounds',
    charge: 'Charge gun: the gap depends on hold time',
    'tag-salvo': 'Tag, then salvo',
    'lock-on': 'Lock-on: lock time dominates',
    'no-delay': 'No shot delay',
    unknown: 'Not in the ODF database',
    secondary: 'Spawned by other ordnance',
  };

  const FACTIONS = { i: 'ISDF', f: 'Scion', e: 'Hadean' };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const DEFAULTS = {
    tab: 'career', metric: 'sw_rate', x: 'match', smooth: '5', ship: '', pair: '', from: '', to: '',
    split: '', win: 'all', per: 'often', rw: 'class:right_on_cue', rsort: 'name', sort: 'all:desc', focus: '',
    drill: '', career: '',
  };
  const state = Object.assign({ players: [] }, DEFAULTS);
  let D = null;
  const dirty = { career: true, history: true, compare: true, reload: true, rhythm: true, players: true, moments: true };
  const TAB_ALIASES = { leaders: 'moments', highlights: 'moments' };
  const PER_MODES = ['often', 'best', 'all'];
  const tabCharts = { history: [], compare: [], rhythm: [] };
  let titlesCache = null;
  let drill = null;
  let careerList = null;
  const laneCache = new Map();

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  function histMedian(h) {
    let tot = 0;
    for (const c of h) tot += c;
    if (!tot) return null;
    let acc = 0;
    for (let i = 0; i < h.length; i++) {
      acc += h[i];
      if (acc * 2 >= tot) return i;
    }
    return h.length - 1;
  }

  function wilsonLower(k, n) {
    if (!n) return 0;
    const z = 1.96;
    const p = k / n;
    const d = 1 + z * z / n;
    const c = p + z * z / (2 * n);
    const r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return (c - r) / d;
  }

  function erf(x) {
    const s = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
      * Math.exp(-a * a);
    return s * y;
  }

  function rankSumP(a, b) {
    const n1 = a.length;
    const n2 = b.length;
    if (n1 < 3 || n2 < 3) return null;
    const all = a.map((v) => [v, 0]).concat(b.map((v) => [v, 1])).sort((x, y) => x[0] - y[0]);
    const N = all.length;
    let r1 = 0;
    let tie = 0;
    for (let i = 0; i < N;) {
      let j = i;
      while (j + 1 < N && all[j + 1][0] === all[i][0]) j++;
      const rank = (i + j + 2) / 2;
      const t = j - i + 1;
      tie += t * t * t - t;
      for (let k = i; k <= j; k++) if (all[k][1] === 0) r1 += rank;
      i = j + 1;
    }
    const u = r1 - n1 * (n1 + 1) / 2;
    const mu = n1 * n2 / 2;
    const sigma = Math.sqrt(n1 * n2 / 12 * ((N + 1) - tie / (N * (N - 1))));
    if (!sigma) return 1;
    const z = (Math.abs(u - mu) - 0.5) / sigma;
    return Math.max(0, Math.min(1, 2 * (1 - 0.5 * (1 + erf(Math.max(0, z) / Math.SQRT2)))));
  }

  function dateStr(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function isoDay(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function pct(v, digits) {
    return v == null ? '—' : `${(v * 100).toFixed(digits == null ? 1 : digits)}%`;
  }

  function fmtValue(id, v) {
    if (v == null || Number.isNaN(v)) return '—';
    switch ((METRIC_COPY[id] || {}).fmt) {
      case 'pct': return pct(v);
      case 'ms': return `${Math.round(v)} ms`;
      case 'jit': return v >= D.constants.jitter_over ? '>40 ms' : `${v.toFixed(1)} ms`;
      case 'num0': return Math.round(v).toLocaleString();
      case 'num2': return v.toFixed(2);
      default: return v.toFixed(1);
    }
  }

  function fmtDelta(id, diff) {
    if (diff == null || Number.isNaN(diff)) return '';
    const sign = diff >= 0 ? '+' : '−';
    if ((METRIC_COPY[id] || {}).fmt === 'pct') return `${sign}${Math.abs(diff * 100).toFixed(1)} pts`;
    return `${sign}${fmtValue(id, Math.abs(diff))}`;
  }

  function changeOf(id, before, after) {
    if (before == null || after == null) return null;
    if (id === 'jitter' && Math.max(before, after) >= D.constants.jitter_over) return null;
    return after - before;
  }

  function deltaHtml(id, diff) {
    if (diff == null) return '';
    const txt = fmtDelta(id, diff);
    if (!/[1-9]/.test(txt)) return '<span class="pa-muted">±0</span>';
    return `<span class="${diff >= 0 ? 'pa-up' : 'pa-down'}">${diff >= 0 ? '▲' : '▼'} ${esc(txt)}</span>`;
  }

  function fmtP(p) {
    if (p == null) return 'not tested';
    if (p <= 0.0011) return '≤ 0.001';
    return p < 0.01 ? p.toFixed(4) : p.toFixed(3);
  }

  function clockStr(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function clockFine(sec) {
    const cs = Math.max(0, Math.round(sec * 100));
    const m = Math.floor(cs / 6000);
    return `${m}:${((cs - m * 6000) / 100).toFixed(2).padStart(5, '0')}`;
  }

  // primary, info, warning, success, accent, danger: primary and accent sit
  // close together in several themes, so they are kept apart.
  const SLOT_ORDER = [0, 2, 3, 4, 1, 5];

  // Slots past the theme palette get golden-angle hues, as hex because
  // withAlpha() in js/charts.js only tints hex colours.
  function playerColor(slot) {
    if (slot >= SLOT_ORDER.length) return hslHex(((slot - SLOT_ORDER.length) * 137.508 + 20) % 360, 0.62, 0.6);
    if (typeof getPlayerColor !== 'function') return cssVar('--kb-primary', '#6366f1');
    return getPlayerColor(SLOT_ORDER[slot]);
  }

  function hslHex(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function alpha(color, a) {
    return typeof withAlpha === 'function' ? withAlpha(color, a) : color;
  }

  function hashUnit(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  // ---------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------

  function table(t) {
    const cols = t.cols;
    return t.rows.map((r) => {
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
      return o;
    });
  }

  function key(m, p) {
    return m * 1024 + p;
  }

  function pushMap(map, k, v) {
    const arr = map.get(k);
    if (arr) arr.push(v); else map.set(k, [v]);
  }

  function decode(ix) {
    const players = table(ix.players).map((p, i) => Object.assign(p, { i }));
    const matches = table(ix.matches).map((m, i) => Object.assign(m, { i, ts: Date.parse(`${m.date}:00Z`) }));
    const weapons = table(ix.weapons).map((w, i) => Object.assign(w, { i }));
    const ships = table(ix.ships).map((s, i) => Object.assign(s, { i }));
    // In a slot-credited recording a commander's raw shots include his AI units' fire. The
    // pipeline repairs his hit counts, not the shot stream the timing figures are read from.
    const credited = new Set(table(ix.rows).filter((r) => r.cmd && matches[r.m].slot).map((r) => key(r.m, r.p)));
    const keep = (r) => !credited.has(key(r.m, r.p));
    const untimed = (r) => Object.assign(r, { noTiming: !keep(r) });
    const rows = table(ix.rows).map(untimed);
    const shipRows = table(ix.ship_rows).map(untimed);
    const streaks = table(ix.streaks).filter(keep).map((s, i) => Object.assign(s, { i }));
    const reload = table(ix.reload).filter(keep);
    const reference = table(ix.reference);
    const weaponRows = table(ix.weapon_rows || { cols: [], rows: [] });
    const ordnance = table(ix.ordnance || { cols: [], rows: [] });

    reload.forEach((r) => {
      r.Rms = r.R * 1000 / matches[r.m].hz;
      r.hist = r.h ? r.h.split(';').map((x) => x.split(',').map(Number)) : [];
      r.items = r.ditem ? r.ditem.split(',').map((x) => x.split(':').map(Number)) : [];
    });

    const d = {
      players, matches, weapons, ships, rows, shipRows, streaks, reload, reference, weaponRows, ordnance,
      dropItems: ix.drop_items || [],
      metrics: {}, metricOrder: [], constants: ix.constants, events: ix.events || [],
      recorderTs: Date.parse(`${ix.recorder_change}T00:00:00Z`),
      dataThroughTs: Date.parse(`${ix.data_through}T00:00:00Z`),
      dataThrough: ix.data_through,
      rowByKey: new Map(), shipRowsByKey: new Map(), streaksByKey: new Map(), reloadByKey: new Map(),
      weaponRowsByKey: new Map(), rowsByPlayer: players.map(() => []),
      weaponByStem: new Map(weapons.map((w) => [w.stem, w.i])),
      shipByStem: new Map(ships.map((s) => [s.stem, s.i])),
      playerByToken: new Map(),
    };
    ix.metrics.forEach((m) => { d.metrics[m.id] = m; d.metricOrder.push(m.id); });
    const groupRank = Object.keys(GROUP_LABELS);
    d.metricOrder = d.metricOrder.map((id, i) => [id, i])
      .sort((x, y) => groupRank.indexOf(d.metrics[x[0]].group) - groupRank.indexOf(d.metrics[y[0]].group) || x[1] - y[1])
      .map((x) => x[0]);
    rows.forEach((r) => { d.rowByKey.set(key(r.m, r.p), r); d.rowsByPlayer[r.p].push(r); });
    d.rowsByPlayer.forEach((list) => list.sort((a, b) => a.m - b.m));
    shipRows.forEach((r) => pushMap(d.shipRowsByKey, key(r.m, r.p), r));
    streaks.forEach((s) => pushMap(d.streaksByKey, key(s.m, s.p), s));
    reload.forEach((r) => pushMap(d.reloadByKey, key(r.m, r.p), r));
    weaponRows.forEach((r) => pushMap(d.weaponRowsByKey, key(r.m, r.p), r));
    players.forEach((p) => {
      d.playerByToken.set(p.id, p.i);
      if (p.slug) d.playerByToken.set(p.slug, p.i);
    });
    d.refByKey = new Map();
    reference.forEach((r) => {
      const k = `${r.s}|${r.w}`;
      const prev = d.refByKey.get(k);
      if (!prev || (prev.R_ms == null && r.R_ms != null)) d.refByKey.set(k, r);
    });
    // Switch-backs per (slow weapon, partner), and per ship within each pair.
    d.pairUse = new Map();
    reload.forEach((r) => {
      if (r.q < 0) return;
      const k = `${r.a}|${r.q}`;
      let u = d.pairUse.get(k);
      if (!u) { u = { a: r.a, q: r.q, sb: 0, ships: new Map() }; d.pairUse.set(k, u); }
      u.sb += r.sb;
      u.ships.set(r.s, (u.ships.get(r.s) || 0) + r.sb);
    });
    return d;
  }

  function topKey(map) {
    let best = null;
    map.forEach((v, k) => { if (best == null || v > map.get(best)) best = k; });
    return best;
  }

  function weaponName(wi) {
    const w = D.weapons[wi];
    if (!w) return '?';
    if (w.stem.startsWith('ord:')) return w.name;
    return w.assault ? `${w.name} (assault)` : w.name;
  }

  function shipName(si) {
    const s = D.ships[si];
    if (!s) return '?';
    const fac = FACTIONS[s.stem[0]];
    return fac ? `${s.name} (${fac})` : s.name;
  }

  function shipPhrase(si) {
    const s = D.ships[si];
    const fac = FACTIONS[s.stem[0]];
    return fac ? `${fac} ${s.name}` : s.name;
  }

  // Effective reload of a weapon on a ship (the Weapon reference figure), else
  // its shotDelay rounded up to whole 20 Hz ticks.
  function reloadMs(s, w) {
    const ref = s != null ? D.refByKey.get(`${s}|${w}`) : null;
    if (ref && ref.R_ms != null) return ref.R_ms;
    const sd = D.weapons[w] && D.weapons[w].shot_delay;
    return sd ? Math.ceil(sd * 20 - 1e-9) * 50 : null;
  }

  function reloadClassOf(ms) {
    return Object.keys(RELOAD_CLASSES).find((id) => ms >= RELOAD_CLASSES[id].lo && ms <= RELOAD_CLASSES[id].hi) || null;
  }

  // The picked ship and pair when no recorded switch-back has that ship on that pair.
  function pairShipGap() {
    if (!state.pair || !state.ship) return null;
    const ship = D.shipByStem.get(state.ship);
    const [sa, sq] = state.pair.split('~');
    const a = D.weaponByStem.get(sa);
    const q = D.weaponByStem.get(sq);
    if (ship == null || a == null || q == null) return null;
    const u = D.pairUse.get(`${a}|${q}`);
    if (u && u.ships.has(ship)) return null;
    return { ship, a, q, pair: `${weaponName(a)} + ${weaponName(q)}` };
  }

  function gapText(gap) {
    return `The ${shipPhrase(gap.ship)} never used ${gap.pair} in these recordings.`;
  }

  // What each board's sample is made of; every other pair board counts switch-backs.
  const EXAMPLE_UNIT = {
    fast_hands: 'streak', metronome: 'streak', swiss_watch: 'streak', even_share: 'streak', jitter: 'streak',
    quick_draw: 'trip', sw_1tick: 'trip', button_masher: 'switch', sw_rate: 'switch', drops_per_k: 'drop',
  };
  const commonCache = new Map();

  // A board's most common case over every recording: the pair holding the most of the board's own sample
  // (streaks, round trips, switches, switch-backs or mid-cycle drops), on the ship it was used on most.
  function commonCase(id) {
    if (commonCache.has(id)) return commonCache.get(id);
    const unit = EXAMPLE_UNIT[id] || 'sb';
    const cls = RELOAD_CLASSES[id] ? id : null;
    const n = new Map();
    const add = (a, q, s, c) => {
      if (!(c > 0)) return;
      const k = `${a}|${q}|${s}`;
      n.set(k, (n.get(k) || 0) + c);
    };
    if (unit === 'streak') {
      D.streaks.forEach((x) => add(x.a, x.q, x.s, 1));
    } else if (unit === 'sb' || unit === 'drop') {
      D.reload.forEach((r) => {
        if (r.q < 0 || (cls && reloadClassOf(reloadMs(r.s, r.a)) !== cls)) return;
        add(r.a, r.q, r.s, unit === 'drop' ? r.din : r.sb);
      });
    } else {
      // A row keeps its match's top pair in stem order and without a ship: the pair's switch-backs
      // say which weapon is the slow one and where it was flown.
      const pairs = new Map();
      D.rows.forEach((r) => {
        if (r.noTiming) return;
        const [x, y, c] = rowPair(id, r);
        if (x == null || !(c > 0)) return;
        pairs.set(`${x}|${y}`, (pairs.get(`${x}|${y}`) || 0) + c);
      });
      pairs.forEach((c, k) => {
        const [x, y] = k.split('|');
        const u1 = D.pairUse.get(`${x}|${y}`);
        const u2 = D.pairUse.get(`${y}|${x}`);
        const u = u1 && u2 ? (u2.sb > u1.sb ? u2 : u1) : (u1 || u2);
        if (u) add(u.a, u.q, topKey(u.ships), c);
      });
    }
    const top = topKey(n);
    const out = top == null ? null : (([a, q, s]) => ({ a, q, s }))(top.split('|').map(Number));
    commonCache.set(id, out);
    return out;
  }

  // The pair a board's "In game" example is written for: the picked pair on the
  // picked ship (else the pair's most-used ship), the picked ship's most-used
  // pair, or with nothing picked the board's most common case. A picked ship is
  // never swapped for another one. A reload-class board limits a ship's pick to
  // slow weapons of that class.
  function exampleCtx(id) {
    const cls = RELOAD_CLASSES[id] ? id : null;
    let a;
    let q;
    let s = null;
    let lead = '';
    let common = false;
    const shipSel = state.ship ? D.shipByStem.get(state.ship) : null;
    const gap = pairShipGap();
    if (state.pair && !gap) {
      const [sa, sq] = state.pair.split('~');
      a = D.weaponByStem.get(sa);
      q = D.weaponByStem.get(sq);
      if (a == null || q == null) return null;
      const u = D.pairUse.get(`${a}|${q}`);
      if (shipSel != null) s = shipSel;
      else if (u) s = topKey(u.ships);
    } else if (shipSel != null) {
      let best = null;
      D.pairUse.forEach((u) => {
        const v = u.ships.get(shipSel);
        if (!v) return;
        if (cls && reloadClassOf(reloadMs(shipSel, u.a)) !== cls) return;
        if (!best || v > best.v) best = { u, v };
      });
      if (!best) {
        if (gap) return { none: gapText(gap) };
        return { none: cls ? `The ${shipPhrase(shipSel)} has no alternated slow weapon that `
          + `${RELOAD_CLASSES[cls].label.toLowerCase()}.` : `The ${shipPhrase(shipSel)} has no alternated weapon pair in these recordings.` };
      }
      ({ a, q } = best.u);
      s = shipSel;
      const most = `${weaponName(a)} + ${weaponName(q)}`;
      lead = gap ? `The ${shipPhrase(s)} never used ${gap.pair}. Most used on it: ${most}. `
        : `Most used on the ${shipPhrase(s)}${cls ? ' at this reload' : ''}: ${most}. `;
    } else {
      const c = commonCase(id);
      if (!c) return null;
      ({ a, q, s } = c);
      common = true;
      lead = `Most common${cls ? ' at this reload' : ''}: ${weaponName(a)} + ${weaponName(q)} on the ${shipPhrase(s)}. `;
    }
    const R = reloadMs(s, a);
    const P = reloadMs(s, q);
    if (!R || !P) return null;
    const win = Math.max(0, R - 2 * BIN_MS);
    const on = s != null && !lead ? ` on the ${shipPhrase(s)}` : '';
    return {
      A: weaponName(a), B: weaponName(q), R, P, Rt: Math.round(R / BIN_MS), win,
      volleys: Math.floor(win / P) + 1, swMax: Math.round(120000 / R), tick: pct(BIN_MS / R, 0),
      cls: reloadClassOf(R), lead, on, onLead: on ? `On the ${shipPhrase(s)}, ` : '',
      drop: id === 'drops_per_k' ? commonDrop(a, q, s) : null, common,
    };
  }

  // The item dropped mid-cycle most often on this pair and ship, else the ship's stock item.
  function commonDrop(a, q, s) {
    const n = new Map();
    for (const r of D.reload) {
      if (r.a !== a || r.q !== q || (s != null && r.s !== s)) continue;
      for (const [i, c] of r.items) n.set(i, (n.get(i) || 0) + c);
    }
    const top = topKey(n);
    if (top != null) return D.dropItems[top];
    return s != null ? D.ships[s].drop || null : null;
  }

  function gameText(id) {
    const t = LEADER_TITLES[id];
    if (!t.pairGame) return { text: t.game || '' };
    const gap = pairShipGap();
    if (gap && PAIR_FILTERED.has(id)) return { text: gapText(gap) };
    const x = exampleCtx(id);
    if (!x) return { text: t.game || '' };
    if (x.none) return { text: x.none };
    return { text: x.lead + t.pairGame(x), blind: PAIR_BLIND.has(id) && !x.common };
  }

  function playerName(pi) {
    return (D.players[pi] || {}).name || '?';
  }

  function playerToken(pi) {
    return D.players[pi].slug || D.players[pi].id;
  }

  function allPlayers() {
    return D.players.map((p) => p.i);
  }

  function isAll(list) {
    return list.length === D.players.length;
  }

  function allSelected() {
    return isAll(state.players);
  }

  function crowded() {
    return state.players.length > CROWD;
  }

  // Boards and tables mark selected names only when the selection singles players out.
  function highlightSet() {
    return allSelected() ? new Set() : new Set(state.players);
  }

  function focusPlayer() {
    const p = state.focus ? D.playerByToken.get(state.focus) : null;
    return p != null && state.players.includes(p) ? p : null;
  }

  function leadPlayer() {
    const f = focusPlayer();
    return f != null ? f : (state.players.length ? state.players[0] : null);
  }

  function matchLinks(m, p) {
    const id = D.matches[m].id;
    const name = encodeURIComponent(playerName(p));
    return {
      dash: `../matches/?match=${encodeURIComponent(id)}&filter=player&players=${name}&tab=combat`,
      raw: rawHref(m, p),
    };
  }

  // The raw browser filters on the Steam64 in the recording, which differs
  // from the page's id for rerouted and aliased players (`rid`).
  function rawHref(m, p, ticks) {
    const row = D.rowByKey.get(key(m, p));
    const q = new URLSearchParams({
      match: D.matches[m].id, types: 'bulletInit', player: (row && row.rid) || D.players[p].id,
    });
    if (ticks) q.set('tick', `${Math.max(0, Math.round(ticks[0]))}-${Math.round(ticks[1])}`);
    return `../raw/?${q.toString()}`;
  }

  function streakTicks(s) {
    const hz = D.matches[s.m].hz;
    return [s.t0 - hz, s.t0 + decodeGaps(s.g).reduce((a, b) => a + b, 0) + hz];
  }

  // ---------------------------------------------------------------------
  // URL state
  // ---------------------------------------------------------------------

  function readUrl() {
    const q = new URLSearchParams(location.search);
    Object.keys(DEFAULTS).forEach((k) => {
      if (q.has(k)) state[k] = q.get(k);
    });
    if (q.has('players') && q.get('players') !== 'all') {
      state.players = q.get('players').split(',').map((t) => D.playerByToken.get(t.trim()))
        .filter((i) => i != null).filter((v, i, a) => a.indexOf(v) === i);
    } else {
      state.players = allPlayers();
    }
    const f = focusPlayer();
    state.focus = f != null ? playerToken(f) : '';
    if (!METRIC_COPY[state.metric]) state.metric = DEFAULTS.metric;
    if (!PER_MODES.includes(state.per)) state.per = DEFAULTS.per;
    if (!RELOAD_SORTS.includes(state.rsort)) state.rsort = DEFAULTS.rsort;
    state.tab = TAB_ALIASES[state.tab] || state.tab;
    if (!dirty[state.tab]) state.tab = DEFAULTS.tab;
    if (state.ship && !D.shipByStem.has(state.ship)) state.ship = '';
    if (state.pair) {
      const stems = state.pair.split('~');
      if (stems.length !== 2 || !stems.every((st) => D.weaponByStem.has(st))) state.pair = '';
    }
  }

  function writeUrl() {
    const q = new URLSearchParams();
    if (state.tab !== DEFAULTS.tab) q.set('tab', state.tab);
    if (!allSelected()) q.set('players', state.players.map(playerToken).join(','));
    Object.keys(DEFAULTS).forEach((k) => {
      if (k !== 'tab' && state[k] !== DEFAULTS[k] && state[k] !== '') q.set(k, state[k]);
    });
    const qs = q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7E/g, '~');
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ---------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------

  function filterCtx(opts) {
    const o = opts || {};
    const fromTs = state.from ? Date.parse(`${state.from}T00:00:00Z`) : null;
    const toTs = state.to ? Date.parse(`${state.to}T00:00:00Z`) + DAY : null;
    let winTs = null;
    if (o.useWin && state.win !== 'all') winTs = D.dataThroughTs + DAY - Number(state.win) * DAY;
    let pair = null;
    if (state.pair) {
      const [a, q] = state.pair.split('~');
      pair = [D.weaponByStem.get(a), D.weaponByStem.get(q)];
      if (pair[0] == null) pair = null;
    }
    return {
      fromTs, toTs, winTs, pair,
      ship: state.ship ? D.shipByStem.get(state.ship) : -1,
      lo: o.lo != null ? o.lo : null,
      hi: o.hi != null ? o.hi : null,
      reloadSel: o.reloadSel || null,
      allEras: !!o.allEras,
      splitTs: o.splitTs != null ? o.splitTs : null,
      side: o.side || null,
    };
  }

  function matchOk(ctx, m) {
    const ts = D.matches[m].ts;
    if (ctx.fromTs != null && ts < ctx.fromTs) return false;
    if (ctx.toTs != null && ts >= ctx.toTs) return false;
    if (ctx.winTs != null && ts < ctx.winTs) return false;
    if (ctx.splitTs != null) {
      if (ctx.side === 'before' && ts >= ctx.splitTs) return false;
      if (ctx.side === 'after' && ts < ctx.splitTs) return false;
    }
    return true;
  }

  function streakOk(ctx, s) {
    if (ctx.ship >= 0 && s.s !== ctx.ship) return false;
    if (ctx.pair && (s.a !== ctx.pair[0] || s.q !== ctx.pair[1])) return false;
    return true;
  }

  function reloadOk(ctx, r) {
    if (ctx.ship >= 0 && r.s !== ctx.ship) return false;
    if (ctx.pair) {
      if (r.a !== ctx.pair[0]) return false;
      if (r.q >= 0 && r.q !== ctx.pair[1]) return false;
    }
    if (ctx.lo != null && r.Rms < ctx.lo) return false;
    if (ctx.hi != null && r.Rms > ctx.hi) return false;
    if (ctx.reloadSel != null && r.a !== ctx.reloadSel) return false;
    return true;
  }

  function reloadSelection() {
    const rw = state.rw || DEFAULTS.rw;
    if (rw === 'all') return {};
    if (rw.startsWith('class:')) {
      const c = RELOAD_CLASSES[rw.slice(6)];
      return c ? { lo: c.lo, hi: c.hi } : {};
    }
    const wi = D.weaponByStem.get(rw);
    return wi != null ? { reloadSel: wi } : {};
  }

  // ---------------------------------------------------------------------
  // Aggregation (sums of pre-computed per-match numbers)
  // ---------------------------------------------------------------------

  function newAgg() {
    return {
      n: 0, swn: 0, swa: 0, rtn: 0, rt1: 0, rtmeds: [], vol: 0, mt: 0, din: 0, cycm: 0, ditems: new Map(),
      sf: 0, sh: 0, ph: 0, sfPost: 0, shPost: 0, k: 0, d: 0, pk: 0, pd: 0, dmg: 0, pdmg: 0, mins: 0,
      tks: [], perShip: false, stk: 0, stt: 0, even: 0, periods: [], jits: [], ck: 0,
      cyc: 0, sb: 0, dot: 0, seam: 0, perf: 0, starv: 0, mhist: new Array(21).fill(0), held: 0, held0: 0,
    };
  }

  function addMatch(agg, ctx, m, p) {
    const k = key(m, p);
    const row = D.rowByKey.get(k);
    if (!row) return;
    let src = row;
    if (ctx.ship >= 0) {
      src = (D.shipRowsByKey.get(k) || []).find((r) => r.s === ctx.ship);
      agg.perShip = true;
      if (!src) return;
    }
    agg.n += 1;
    if (!src.noTiming) {
      agg.swn += src.swn; agg.swa += src.swa; agg.rtn += src.rtn; agg.rt1 += src.rt1;
      if (src.rtmed != null && src.rtn > 0) agg.rtmeds.push(src.rtmed);
      agg.vol += src.vol; agg.mt += src.mt;
    }
    agg.sf += src.sf; agg.sh += src.sh; agg.ph += src.ph;
    // The slot-credited recordings predate the change but already recorded every hit.
    if (D.matches[m].ts >= D.recorderTs || D.matches[m].slot) { agg.sfPost += src.sf; agg.shPost += src.sh; }
    agg.k += src.k; agg.d += src.d; agg.pk += src.pk; agg.pd += src.pd; agg.dmg += src.dmg; agg.mins += src.mins;
    if (ctx.ship < 0) agg.pdmg += row.pdmg;
    if (ctx.ship < 0 && row.tk != null) agg.tks.push(row.tk);
    for (const s of D.streaksByKey.get(k) || []) {
      if (!streakOk(ctx, s)) continue;
      agg.stk += 1;
      agg.periods.push(s.per);
      agg.jits.push(s.jit);
      if (s.pv != null) {
        agg.stt += 1;
        if (s.pv < D.constants.even_p) agg.even += 1;
      }
      if (s.ck >= D.constants.clock_min_cycles) agg.ck += s.ck;
    }
    for (const r of D.reloadByKey.get(k) || []) {
      if (!reloadOk(ctx, r)) continue;
      if (r.q < 0) {
        agg.held += r.held; agg.held0 += r.held0;
        continue;
      }
      agg.sb += r.sb; agg.dot += r.dot; agg.seam += r.seam; agg.perf += r.perf; agg.cyc += r.cyc;
      agg.starv += r.starv; agg.din += r.din;
      if (r.mine) agg.cycm += r.cyc;
      for (const [i, c] of r.items) agg.ditems.set(i, (agg.ditems.get(i) || 0) + c);
      for (const [mb, , c] of r.hist) agg.mhist[Math.min(mb, 20)] += c;
    }
  }

  function aggPlayer(p, ctx, rowsList) {
    const agg = newAgg();
    for (const r of rowsList || D.rowsByPlayer[p]) {
      if (matchOk(ctx, r.m)) addMatch(agg, ctx, r.m, p);
    }
    return agg;
  }

  function metricOf(id, agg, ctx) {
    let v = null;
    let g = 0;
    switch (id) {
      case 'sw_rate': v = agg.swa > 0 ? agg.swn / (agg.swa / 60) : null; g = agg.swa; break;
      case 'sw_1tick': v = agg.rtn ? agg.rt1 / agg.rtn : null; g = agg.rtn; break;
      case 'sw_median': v = median(agg.rtmeds); g = agg.rtn; break;
      case 'even_share': v = agg.stt ? agg.even / agg.stt : null; g = agg.stt; break;
      case 'period': v = median(agg.periods); g = agg.stk; break;
      case 'jitter': v = median(agg.jits); g = agg.stk; break;
      case 'clock_share': v = agg.cyc ? Math.min(1, agg.ck / agg.cyc) : null; g = agg.cyc; break;
      case 'dot_share': v = agg.sb ? agg.dot / agg.sb : null; g = agg.sb; break;
      case 'seam_share': v = agg.sb ? agg.seam / agg.sb : null; g = agg.sb; break;
      case 'perfect_share': v = agg.sb ? agg.perf / agg.sb : null; g = agg.sb; break;
      case 'margin': {
        const b = histMedian(agg.mhist);
        v = b == null ? null : b * BIN_MS;
        g = agg.sb;
        break;
      }
      case 'drops_per_k': v = agg.cycm ? agg.din * 1000 / agg.cycm : null; g = agg.cycm; break;
      case 'multi_share': v = agg.vol ? agg.mt / agg.vol : null; g = agg.vol; break;
      case 'pvp_hit': v = agg.sf ? agg.ph / agg.sf : null; g = agg.sf; break;
      case 'accuracy':
        if (ctx && ctx.allEras) { v = agg.sf ? agg.sh / agg.sf : null; g = agg.sf; } else {
          v = agg.sfPost ? agg.shPost / agg.sfPost : null; g = agg.sfPost;
        }
        break;
      case 'tkey': v = agg.perShip ? null : median(agg.tks); g = agg.tks.length; break;
      case 'pvp_kd': v = agg.n ? agg.pk / Math.max(1, agg.pd) : null; g = agg.n; break;
      case 'dpm': v = agg.mins ? agg.dmg / agg.mins : null; g = agg.mins; break;
      case 'pvp_dpm': v = agg.perShip || !agg.mins ? null : agg.pdmg / agg.mins; g = agg.mins; break;
      default: break;
    }
    const gate = (D.metrics[id] || {}).gate || ['n', 0];
    return { v, g, ok: v != null && g >= gate[1] };
  }

  function careerValue(id, p, ctx) {
    return metricOf(id, aggPlayer(p, ctx), ctx);
  }

  function matchSeries(id, p, ctx) {
    const out = [];
    for (const r of D.rowsByPlayer[p]) {
      if (!matchOk(ctx, r.m)) continue;
      const agg = newAgg();
      addMatch(agg, ctx, r.m, p);
      if (!agg.n) continue;
      const res = metricOf(id, agg, ctx);
      if (res.v == null || res.g < MATCH_GATE[id]) continue;
      out.push({ m: r.m, ts: D.matches[r.m].ts, y: res.v });
    }
    return out;
  }

  function rolling(values, w) {
    if (!w) return values.slice();
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= w) sum -= values[i - w];
      out.push(sum / Math.min(i + 1, w));
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Leaders
  // ---------------------------------------------------------------------

  function recordBoard(id, ctx) {
    const recs = [];
    if (id === 'fast_hands' || id === 'metronome' || id === 'swiss_watch') {
      for (const s of D.streaks) {
        if (!matchOk(ctx, s.m) || !streakOk(ctx, s)) continue;
        if (id === 'metronome' && s.ck < D.constants.clock_min_cycles) continue;
        if (id === 'swiss_watch' && s.pv == null) continue;
        const pair = `${weaponName(s.a)} + ${weaponName(s.q)}`;
        const base = { m: s.m, p: s.p, t0: s.t0, ship: s.s, pair, streak: s };
        if (id === 'fast_hands') {
          recs.push(Object.assign(base, {
            sort: [s.per, -s.n, s.m], value: `${s.per.toFixed(1)} ms`, detail: `${s.n} cycles per streak`,
          }));
        } else if (id === 'metronome') {
          recs.push(Object.assign(base, {
            sort: [-s.ck, s.sp, s.m], value: `${s.ck} cycles`,
            detail: `${s.per.toFixed(1)} ms · streak of ${s.n}`,
            extra: gapPreview(s.g),
          }));
        } else {
          recs.push(Object.assign(base, {
            sort: [s.pv, -s.n, s.m], value: `p ${fmtP(s.pv)}`,
            detail: `${fmtValue('jitter', s.jit)} wobble · ${s.n} cycles`,
          }));
        }
      }
    } else if (id === 'quick_draw' || id === 'button_masher') {
      for (const r of D.rows) {
        if (!matchOk(ctx, r.m)) continue;
        let src = r;
        if (ctx.ship >= 0) src = (D.shipRowsByKey.get(key(r.m, r.p)) || []).find((x) => x.s === ctx.ship);
        if (!src || src.noTiming) continue;
        if (id === 'quick_draw') {
          if (src.rtn < QUICK_DRAW_TRIPS || src.rtmed == null) continue;
          recs.push({
            m: r.m, p: r.p, ship: ctx.ship >= 0 ? ctx.ship : null,
            pair: r.ra != null ? `${weaponName(r.ra)} + ${weaponName(r.rb)}` : '',
            sort: [Math.max(src.rtmed, BIN_MS), -src.rt1 / src.rtn, r.m], value: `${Math.round(src.rtmed)} ms`,
            detail: `${pct(src.rt1 / src.rtn, 0)} one-tick returns · ${src.rtn} round trips`,
          });
        } else {
          if (src.swa < 120) continue;
          const rate = src.swn / (src.swa / 60);
          recs.push({
            m: r.m, p: r.p, ship: ctx.ship >= 0 ? ctx.ship : null,
            pair: r.pa != null ? `${weaponName(r.pa)} + ${weaponName(r.pb)}` : '',
            sort: [-rate, r.m], value: `${rate.toFixed(1)}/min`,
            detail: `${src.swn} switches · ${(src.swa / 60).toFixed(1)} firing min`,
          });
        }
      }
    } else if (RELOAD_CLASSES[id]) {
      const cls = RELOAD_CLASSES[id];
      const units = new Map();
      for (const r of D.reload) {
        if (r.q < 0 || r.Rms < cls.lo || r.Rms > cls.hi) continue;
        if (!matchOk(ctx, r.m) || !reloadOk(ctx, r)) continue;
        const k = key(r.m, r.p);
        let u = units.get(k);
        if (!u) {
          u = { m: r.m, p: r.p, sb: 0, perf: 0, hist: new Array(21).fill(0), pairs: new Map() };
          units.set(k, u);
        }
        u.sb += r.sb;
        u.perf += r.perf;
        for (const [mb, , c] of r.hist) u.hist[Math.min(mb, 20)] += c;
        const pk = `${r.s}|${r.a}|${r.q}`;
        u.pairs.set(pk, (u.pairs.get(pk) || 0) + r.sb);
      }
      for (const u of units.values()) {
        if (u.sb < RELOAD_MIN_SB) continue;
        const top = [...u.pairs.entries()].sort((a, b) => b[1] - a[1])[0][0].split('|').map(Number);
        const lb = wilsonLower(u.perf, u.sb);
        const mm = histMedian(u.hist);
        recs.push({
          m: u.m, p: u.p, ship: top[0], pair: `${weaponName(top[1])} + ${weaponName(top[2])}`,
          sort: [-lb, -u.sb, u.m], value: pct(u.perf / u.sb, 0),
          detail: `+${mm == null ? '—' : mm * BIN_MS} ms after ready · ${u.sb} switch-backs`,
        });
      }
    }
    recs.sort(cmpSort);
    return recs;
  }

  function cmpSort(a, b) {
    for (let i = 0; i < a.sort.length; i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
    return 0;
  }

  // Most often: each player's moments at or past the board's top-10% mark (ties
  // included), so a deep record beats one lucky night.
  function momentsBoard(id, ctx) {
    const recs = recordBoard(id, ctx);
    if (state.per === 'all' || !recs.length) return { rows: recs, total: recs.length };
    const best = new Map();
    recs.forEach((r) => { if (!best.has(r.p)) best.set(r.p, r); });
    if (state.per === 'best') return { rows: [...best.values()], total: recs.length };
    const bar = recs[Math.max(0, Math.ceil(recs.length * MOMENT_TOP) - 1)];
    const k = new Map();
    const n = new Map();
    recs.forEach((r) => {
      n.set(r.p, (n.get(r.p) || 0) + 1);
      if (r.sort[0] <= bar.sort[0]) k.set(r.p, (k.get(r.p) || 0) + 1);
    });
    const rows = [...k.keys()].map((p) => Object.assign({}, best.get(p), { k: k.get(p), n: n.get(p) }))
      .sort((a, b) => b.k - a.k || cmpSort(a, b));
    return { rows, total: recs.length, bar };
  }

  function momentUnit(id) {
    return STREAK_BOARDS.has(id) ? 'streaks' : 'matches';
  }

  function barText(id, bar) {
    if (RELOAD_CLASSES[id]) return `a lower bound of ${pct(-bar.sort[0], 0)}`;
    return bar.value;
  }

  function careerBoard(id, aggs, ctx) {
    const meta = D.metrics[id];
    const out = [];
    aggs.forEach((agg, p) => {
      const r = metricOf(id, agg, ctx);
      if (!r.ok) return;
      out.push({ p, v: r.v, g: r.g, n: agg.n, agg });
    });
    const dir = meta.dir || 1;
    out.sort((a, b) => (dir > 0 ? b.v - a.v : a.v - b.v) || b.g - a.g || a.p - b.p);
    return out;
  }

  // Matches where the player alone did better than the board's typical player.
  function beatTypical(id, p, ctx, typical) {
    if (typical == null) return null;
    const series = matchSeries(id, p, ctx);
    if (!series.length) return null;
    const dir = D.metrics[id].dir || 1;
    const k = series.filter((x) => (dir > 0 ? x.y > typical : x.y < typical)).length;
    return { k, n: series.length };
  }

  // The per-match gate as words (empty when every match counts). `swa` is in
  // seconds, below the career gate's minutes.
  function matchGateText(id) {
    const g = MATCH_GATE[id] || 1;
    const kind = D.metrics[id].gate[0];
    if (kind === 'n' || kind === 'tkn') return '';
    if (g === 1 && (kind === 'stk' || kind === 'stt')) return kind === 'stk' ? 'a streak' : 'a tested streak';
    return kind === 'swa' ? `${g}+ firing seconds` : GATE_LABELS[kind](g);
  }

  function beatScope(id, n) {
    const word = `match${n === 1 ? '' : 'es'}`;
    if (D.metrics[id].gate[0] === 'tkn') return `${word} with T-key data`;
    const gate = matchGateText(id);
    return `${word}${gate ? ` with ${gate} on their own` : ''}`;
  }

  function typicalGap(id, v, typical) {
    const diff = changeOf(id, typical, v);
    if (diff == null) return '';
    const txt = fmtDelta(id, diff);
    return /[1-9]/.test(txt) ? txt : '';
  }

  function sampleText(id, row) {
    const gate = D.metrics[id].gate[0];
    const g = row.g;
    const n = `${row.n} match${row.n === 1 ? '' : 'es'}`;
    switch (gate) {
      case 'swa': return `${n} · ${(g / 60).toFixed(0)} firing min`;
      case 'swn': return `${n} · ${g.toLocaleString()} switches`;
      case 'rtn': return `${n} · ${g.toLocaleString()} round trips`;
      case 'stt': return `${g.toLocaleString()} tested streaks`;
      case 'stk': return `${g.toLocaleString()} streaks`;
      case 'cyc': return `${g.toLocaleString()} cycles`;
      case 'cycm': return `${row.agg ? `${plural(row.agg.din, 'drop')} in ` : ''}${g.toLocaleString()} cycles carrying a mine`;
      case 'sb': return `${g.toLocaleString()} switch-backs`;
      case 'sf': return `${g.toLocaleString()} shots`;
      case 'mins': return `${n} · ${Math.round(g).toLocaleString()} min`;
      default: return n;
    }
  }

  function leaderAggs(ctx) {
    return D.players.map((p) => aggPlayer(p.i, ctx));
  }

  function computeTitles() {
    const ctx = filterCtx({ useWin: true });
    const sig = JSON.stringify([state.win, state.from, state.to, state.ship, state.pair, state.per]);
    if (titlesCache && titlesCache.sig === sig) return titlesCache.map;
    const map = new Map();
    const give = (p, id) => pushMap(map, p, id);
    RECORD_BOARDS.forEach((id) => {
      const b = momentsBoard(id, ctx).rows;
      if (b.length) give(b[0].p, id);
    });
    const aggs = leaderAggs(ctx);
    CAREER_BOARDS.forEach((id) => {
      const b = careerBoard(id, aggs, ctx);
      if (b.length) give(b[0].p, id);
    });
    titlesCache = { sig, map };
    return map;
  }

  function titleChips(p) {
    const ids = computeTitles().get(p) || [];
    if (!ids.length) return '<span class="pa-muted">—</span>';
    return ids.map((id) => {
      const t = LEADER_TITLES[id];
      return `<span class="pa-title-chip" data-board="${id}" title="Holds ${esc(t.title)}">`
        + `<i class="bi ${t.icon}"></i>${esc(t.title)}</span>`;
    }).join('');
  }

  function gapPreview(g) {
    const gaps = decodeGaps(g);
    return gaps.slice(0, 18).join(' ') + (gaps.length > 18 ? ' …' : '');
  }

  function decodeGaps(g) {
    if (!g) return [];
    if (g[0] === ',') return g.slice(1).split(',').map(Number);
    return [...g].map((c) => parseInt(c, 36));
  }

  function boardCard(id, rowsHtml, foot) {
    const t = LEADER_TITLES[id];
    const sub = t.sub || METRIC_COPY[id].explain;
    const g = gameText(id);
    const blind = g.blind ? '<small class="pa-board-blind" title="The weapon-pair filter does not apply to this board: '
      + 'it counts every weapon. The example only uses the pair.">Ranks every weapon</small>' : '';
    return `<div class="card pa-board" id="pa-board-${id}">
      <div class="card-header"><i class="bi ${t.icon} pa-board-icon"></i>
        <h3 class="pa-board-title">${esc(t.title)}<button type="button" class="pa-board-info"
          data-bs-title="${esc(sub)}" aria-label="How ${esc(t.title)} is ranked">`
          + `<i class="bi bi-info-circle"></i></button></h3>
        <p class="pa-board-game">${g.text ? `<span>In game</span>${esc(g.text)}${blind}` : ''}</p>
      </div>
      <div class="pa-board-rows">${rowsHtml}</div>
      <div class="pa-board-foot">${esc(foot || '')}</div>
    </div>`;
  }

  function emptyBoard(id, fallback) {
    const gap = PAIR_FILTERED.has(id) ? pairShipGap() : null;
    const text = gap ? `Nothing to rank: the ${shipPhrase(gap.ship)} never used this pair.` : fallback;
    return `<div class="pa-board-empty">${esc(text)}</div>`;
  }

  function rankCell(i) {
    return i === 0 ? '<i class="bi bi-trophy-fill" title="Holds the title"></i>' : String(i + 1);
  }

  function renderMoments() {
    const ctx = filterCtx({ useWin: true });
    const sel = highlightSet();
    const often = state.per === 'often';
    const recHtml = RECORD_BOARDS.map((id) => {
      const mb = momentsBoard(id, ctx);
      const board = mb.rows.slice(0, 5);
      const unit = momentUnit(id);
      const rows = board.length ? board.map((r, i) => {
        const m = D.matches[r.m];
        const links = matchLinks(r.m, r.p);
        const raw = r.streak ? rawHref(r.m, r.p, streakTicks(r.streak)) : links.raw;
        const rawTitle = r.streak ? 'This streak\'s shots in the raw event browser' : 'This player\'s shots in the match, in the raw event browser';
        const shipTxt = r.ship != null && r.ship >= 0 ? ` · ${shipName(r.ship)}` : '';
        const hzTxt = m.hz !== 20 ? ` · ${m.hz} Hz` : '';
        const meta = `${often ? 'Best: ' : ''}${dateStr(m.ts)}${hzTxt}${shipTxt}${r.pair ? ` · ${r.pair}` : ''}`;
        const value = often ? `${r.k.toLocaleString()} of ${r.n.toLocaleString()}` : r.value;
        const detail = often ? `${unit} in the top 10% · best ${r.value}` : r.detail;
        const extra = often ? '' : r.extra;
        const cls = ['pa-board-row', i === 0 ? 'pa-board-row--crown' : '', sel.has(r.p) ? 'pa-board-row--selected' : '']
          .filter(Boolean).join(' ');
        return `<div class="${cls}" role="button" tabindex="0" data-drill-m="${r.m}" data-drill-p="${r.p}"`
          + `${r.t0 != null ? ` data-drill-t0="${r.t0}"` : ''}>
          <div class="pa-rank">${rankCell(i)}</div>
          <div class="min-w-0"><div class="pa-board-name">${esc(playerName(r.p))}</div>
            <div class="pa-board-meta" title="${esc(meta)}">${esc(meta)}
              <span class="pa-row-links"><a href="${links.dash}" target="_blank" rel="noopener" title="Open the match" data-stop>`
          + `<i class="bi bi-box-arrow-up-right"></i></a><a href="${raw}" target="_blank" rel="noopener" title="${rawTitle}" data-stop>`
          + `<i class="bi bi-diagram-2"></i></a></span></div>
            ${extra ? `<div class="pa-board-meta vt-mono">${esc(extra)}</div>` : ''}</div>
          <div class="pa-board-value">${esc(value)}<small>${esc(detail)}</small></div>
        </div>`;
      }).join('') : emptyBoard(id, 'No records in this window.');
      const foot = [];
      if (RELOAD_CLASSES[id]) foot.push(`${RELOAD_CLASSES[id].label}. Ranked by the lower 95% bound, ${RELOAD_MIN_SB}+ switch-backs in the match.`);
      if (often && mb.bar) foot.push(`Top 10%: ${barText(id, mb.bar)} or better, of ${mb.total.toLocaleString()} ${unit}.`);
      return boardCard(id, rows, foot.join(' '));
    }).join('');
    setBoards('pa-leaders-records', recHtml);
  }

  // A tooltip left open on a replaced card would stay on screen.
  function setBoards(id, html) {
    const el = document.getElementById(id);
    el.querySelectorAll('.pa-board-info').forEach((n) => bootstrap.Tooltip.getInstance(n)?.dispose());
    el.innerHTML = html;
  }

  function renderCareer() {
    const ctx = filterCtx({ useWin: true });
    const sel = highlightSet();
    const aggs = leaderAggs(ctx);
    const shipAggs = new Map();
    const shipAggsOf = (p) => {
      if (ctx.ship >= 0) return null;
      if (!shipAggs.has(p)) shipAggs.set(p, playerShipAggs(p, ctx));
      return shipAggs.get(p);
    };
    const carHtml = CAREER_BOARDS.map((id) => {
      const full = careerBoard(id, aggs, ctx);
      const board = full.slice(0, 5);
      const gate = D.metrics[id].gate;
      const typical = median(full.map((r) => r.v));
      const beatTip = `Counts the player's ${beatScope(id, 2)}.`;
      const rows = board.length ? board.map((r, i) => {
        const cls = ['pa-board-row', i === 0 ? 'pa-board-row--crown' : '', sel.has(r.p) ? 'pa-board-row--selected' : '']
          .filter(Boolean).join(' ');
        const beat = beatTypical(id, r.p, ctx, typical);
        const meta = `${sampleText(id, r)}${beat ? ` · beat typical in ${beat.k} of ${beat.n} match${beat.n === 1 ? '' : 'es'}` : ''}`;
        const gap = typicalGap(id, r.v, typical);
        return `<div class="${cls}" role="button" tabindex="0" data-career="${id}" data-career-p="${r.p}">
          <div class="pa-rank">${rankCell(i)}</div>
          <div class="min-w-0"><div class="pa-board-name">${esc(playerName(r.p))}</div>
            <div class="pa-board-meta"${beat ? ` title="${esc(beatTip)}"` : ''}>${esc(meta)}</div>
            ${mixLineHtml(id, r.p, ctx, shipAggsOf(r.p), r.agg)}</div>
          <div class="pa-board-value">${esc(fmtValue(id, r.v))}${gap ? `<small>${esc(gap)} vs typical</small>` : ''}</div>
        </div>`;
      }).join('') : emptyBoard(id, 'Nobody meets the sample size in this window.');
      let foot = typical != null ? `Typical player: ${fmtValue(id, typical)} (median of ${full.length} ranked). ` : '';
      foot += `Needs ${GATE_LABELS[gate[0]](gate[1])} in the range.`;
      if (id === 'tkey' && ctx.ship >= 0) foot += ' T-key time is not split by ship.';
      if (id === 'pvp_dpm' && ctx.ship >= 0) foot += ' PvP damage is not split by ship.';
      return boardCard(id, rows, foot);
    }).join('');
    setBoards('pa-leaders-career', carHtml);
  }

  function howToHtml() {
    return `<dl>
      <dt>Career or Moments</dt>
      <dd>Career boards pool every match in the date range and count a player only past a minimum sample, so they
        reward doing it every game. Each one shows the typical player (the median of everyone ranked), how far each
        leader sits from it, and in how many of their matches they beat it. Moments rank single matches and streaks:
        Most often counts each player's moments in the board's top 10% under the current filters, and Best moment ranks
        each player's single best, so one great night can top it.</dd>
      <dt>The line under each leader</dt>
      <dd>Which ship and weapon pair their figure came from. <em>Mostly</em> means at least half of it;
        <em>most often</em> means the biggest share, but under half. Click the leader for the exact shares and how they
        rank on each ship and pair.</dd>
      <dt>In game examples</dt>
      <dd>Each board's example uses VSR weapons. Pick a weapon pair, or a ship (its most-used pair), and the examples
        switch to it, with each weapon's reload on that ship from its ODF. Boards tagged <em>Ranks every weapon</em> are
        not filtered by the pair; their example only illustrates it.</dd>
      <dt>Switching</dt>
      <dd>A switch is a change of weapon group while firing, such as Blast to Chain Gun. The recording has no switch
        event, so every switch is read from the shots. The Juggler and Button Masher count every switch.
        FastHands.exe, Quick Draw and the median return delay time round trips instead: out to a slower weapon and
        back. Scrolling out while holding fire costs nothing, so only the way back is timed, from the moment the first
        weapon could fire again (right after the slower shot, or when its own reload ended). The recording ticks 20
        times a second, so 50 ms is the fastest return it can see.</dd>
      <dt>Switch-backs and reload timing</dt>
      <dd>Alternating a slow weapon with a fast one means returning to the slow weapon each time it reloads; each return
        is a switch-back. Its <em>margin</em> is how long after the slow weapon was ready the shot came. Its
        <em>lost fire</em> is how long the fast weapon sat idle. Every reload comes from the weapon's ODF, so a Blast is
        judged against its 2 s reload and a Dragon Blast against 0.3 s. Holding the trigger refires on the dot by itself,
        so held fire is counted separately. On the Reload timing panels the bottom-left corner is best (on the dot and
        seamless) and the top-right is worst (late, with fire lost).</dd>
      <dt>Even beats</dt>
      <dd>A streak is 10 or more alternation cycles in a row. Its beat counts as even when it is steadier than 99% of
        shuffles of its own gaps. A streak with a gap shorter than the reload is not tested: the engine lets a shot come
        one tick early only after a late one, so those gaps are not interchangeable.</dd>
      <dt>Beat wobble</dt>
      <dd>How far, typically, each slow-weapon shot in a streak lands from a perfectly steady beat. It is the random
        timing noise a perfect clock would need to look as uneven as the streak. Lower is steadier; above 40 ms is shown
        as ">40 ms".</dd>
      <dt>Accuracy before 18 Oct 2026</dt>
      <dd>Until then the recorder counted only hits on players, so overall accuracy from earlier matches reads low. Eagle
        Eye uses later matches only, and the History chart shades the earlier period. PvP hit share is unaffected.</dd>
      <dt>Three of the first recordings</dt>
      <dd>Three matches from 16 April 2026 credit each team slot's AI units (Scavengers, Turrets, buildings) to that
        slot's player, as shooter and as target. The stats pipeline gives those shots and hits back to the AI, so their
        combat figures count. Their commanders' timing is left out, since their recorded shots still include the
        Turrets' fire.</dd>
      <dt>Coverage</dt>
      <dd>Every player with a recorded match. Most matches record 20 ticks a second; some early ones
        ran at 30 or 60, and every time is converted per match.</dd>
    </dl>`;
  }

  // ---------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------

  const markerPlugin = {
    id: 'paMarkers',
    beforeDatasetsDraw(chart, _args, opts) {
      const { ctx, chartArea, scales } = chart;
      const x = scales.x;
      if (!x || !chartArea || !opts) return;
      ctx.save();
      (opts.regions || []).forEach((r) => {
        const x0 = Math.max(chartArea.left, x.getPixelForValue(r.from != null ? r.from : x.min));
        const x1 = Math.min(chartArea.right, x.getPixelForValue(r.to != null ? r.to : x.max));
        if (x1 > x0) {
          ctx.fillStyle = r.color;
          ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
          if (r.label) {
            ctx.fillStyle = opts.labelColor;
            ctx.font = '10px Geist, sans-serif';
            ctx.fillText(r.label, x0 + 4, chartArea.bottom - 6);
          }
        }
      });
      ctx.restore();
    },
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !opts) return;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.font = '10px Geist, sans-serif';
      (opts.lines || []).forEach((l) => {
        const px = scales.x.getPixelForValue(l.x);
        if (px < chartArea.left || px > chartArea.right) return;
        ctx.strokeStyle = l.color;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        if (l.label) {
          ctx.fillStyle = l.color;
          ctx.fillText(l.label, Math.min(px + 4, chartArea.right - ctx.measureText(l.label).width - 2), chartArea.top + 11);
        }
      });
      (opts.hlines || []).forEach((l) => {
        const py = scales.y.getPixelForValue(l.y);
        if (py < chartArea.top || py > chartArea.bottom) return;
        ctx.strokeStyle = l.color;
        ctx.beginPath();
        ctx.moveTo(chartArea.left, py);
        ctx.lineTo(chartArea.right, py);
        ctx.stroke();
        if (l.label) {
          ctx.fillStyle = l.color;
          ctx.fillText(l.label, chartArea.right - ctx.measureText(l.label).width - 4, py - 4);
        }
      });
      ctx.restore();
    },
  };

  function themeColors() {
    if (typeof getThemeColors === 'function') return getThemeColors();
    return {
      primary: cssVar('--kb-primary', '#6366f1'), text: cssVar('--kb-text-primary', '#e5e5e5'),
      textMuted: cssVar('--kb-text-muted', '#999'), border: cssVar('--kb-border-subtle', '#333'),
      warning: cssVar('--kb-warning', '#f59e0b'), danger: cssVar('--kb-danger', '#ef4444'),
      info: cssVar('--kb-info', '#22d3ee'), success: cssVar('--kb-success', '#22c55e'),
      accent: cssVar('--kb-accent', '#8b5cf6'), card: cssVar('--kb-bg-card', '#111'),
    };
  }

  function prepCharts() {
    if (typeof applyThemeDefaults === 'function') applyThemeDefaults();
  }

  function destroyTab(tab) {
    (tabCharts[tab] || []).forEach((c) => c.destroy());
    tabCharts[tab] = [];
  }

  function tooltipCfg(extra) {
    const base = typeof glassTooltipConfig !== 'undefined' ? Object.assign({}, glassTooltipConfig) : {};
    return Object.assign(base, extra || {});
  }

  // One legend entry per player; clicking it toggles every dataset of that player.
  function legendCfg(tc) {
    return {
      labels: { color: tc.text, filter: (it, data) => !!data.datasets[it.datasetIndex].vtLegend },
      onClick: (_e, item, legend) => {
        const ch = legend.chart;
        const ds = ch.data.datasets[item.datasetIndex];
        const show = !ch.isDatasetVisible(item.datasetIndex);
        ch.data.datasets.forEach((d, i) => {
          if (d === ds || (ds.vtPlayer != null && d.vtPlayer === ds.vtPlayer)) ch.setDatasetVisibility(i, show);
        });
        ch.update();
      },
    };
  }

  // A player's legend entry focuses that player instead of hiding it. The
  // re-render destroys this chart, so it waits until Chart.js has finished
  // handling the click.
  function focusLegendCfg(cfg) {
    const hide = cfg.onClick;
    if (crowded()) {
      Object.assign(cfg.labels, { boxWidth: Math.min(cfg.labels.boxWidth || 40, 12), padding: 6, font: { size: 11 } });
    }
    cfg.onClick = (e, item, legend) => {
      const ds = legend.chart.data.datasets[item.datasetIndex];
      if (ds.vtPlayer == null) { hide(e, item, legend); return; }
      setTimeout(() => toggleFocus(ds.vtPlayer), 0);
    };
    return cfg;
  }

  function tallerInCrowd(canvas) {
    canvas.parentElement.classList.toggle('pa-chart-lg', !crowded());
    canvas.parentElement.classList.toggle('pa-chart-xl', crowded());
  }

  function focusChipHtml() {
    const focus = focusPlayer();
    if (focus == null) {
      return state.players.length > 1 ? '<span class="small text-muted">Click a name in the legend to focus it.</span>' : '';
    }
    const name = esc(playerName(focus));
    return `<span class="pa-player-chip"><span class="pa-swatch" style="background:${playerColor(state.players.indexOf(focus))}"></span>Focused: ${name}
      <button type="button" data-unfocus aria-label="Stop focusing ${name}"><i class="bi bi-x-lg"></i></button></span>`;
  }

  // Bubble datasets are drawn faint; the legend keys use `vtKey` so they stay
  // readable against the card.
  function dotLegendCfg(tc) {
    const cfg = legendCfg(tc);
    cfg.labels = Object.assign(cfg.labels, {
      usePointStyle: true, pointStyle: 'circle', boxWidth: 9, boxHeight: 9,
      generateLabels: (chart) => Chart.defaults.plugins.legend.labels.generateLabels(chart).map((it) => {
        const key = chart.data.datasets[it.datasetIndex].vtKey;
        if (key) Object.assign(it, { fillStyle: key.fill, strokeStyle: key.stroke, lineWidth: 1.5 });
        return it;
      }),
    });
    return cfg;
  }

  function dateTicks(min, max) {
    return (val) => {
      const d = new Date(val);
      if (Number.isNaN(d.getTime())) return '';
      const opts = (max - min) > 120 * DAY ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' };
      return d.toLocaleDateString(undefined, opts);
    };
  }

  function eventLines(tc, xMode, firstSeries, metricId) {
    const lines = [];
    const mapX = (ts) => {
      if (xMode === 'date') return ts;
      if (!firstSeries || !firstSeries.length) return null;
      const idx = firstSeries.findIndex((pt) => pt.ts >= ts);
      return idx < 0 ? null : idx + 0.5;
    };
    D.events.forEach((e) => {
      if (e.kind === 'recorder' && metricId !== 'accuracy') return;
      const x = mapX(Date.parse(`${e.date}T00:00:00Z`));
      if (x != null) lines.push({ x, color: tc.textMuted, label: e.kind === 'recorder' ? 'Recorder counts every hit' : e.kind });
    });
    if (state.split) {
      const x = mapX(Date.parse(`${state.split}T00:00:00Z`));
      if (x != null) lines.push({ x, color: tc.warning, label: `Split ${state.split}` });
    }
    return lines;
  }

  function yScaleFor(id, tc) {
    const fmt = (METRIC_COPY[id] || {}).fmt;
    const s = { grid: { color: alpha(tc.border, 0.6) }, ticks: { color: tc.textMuted } };
    if (fmt === 'pct') {
      s.ticks.callback = (v) => `${Math.round(v * 100)}%`;
      s.suggestedMin = 0;
    } else if (fmt === 'ms' || fmt === 'jit') {
      s.ticks.callback = (v) => `${v} ms`;
    }
    return s;
  }

  function emptyHtml(what) {
    return `<div class="pa-empty"><i class="bi bi-people pa-empty-icon"></i>
      <div><div class="fw-semibold">No players picked</div>
        <div class="small text-muted">${esc(what)} Pick players in the filter bar, or select everyone.</div></div>
      <div class="d-flex flex-wrap gap-2 ms-sm-auto">
        <button type="button" class="btn btn-sm btn-outline-secondary" data-select-all>
          <i class="bi bi-people-fill me-1"></i>Select all</button>
        <button type="button" class="btn btn-sm btn-outline-secondary" data-pick-players>
          <i class="bi bi-person-plus me-1"></i>Pick players</button>
      </div></div>`;
  }

  // ---------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------

  function renderHistory() {
    destroyTab('history');
    prepCharts();
    const tc = themeColors();
    const id = state.metric;
    const ctx = filterCtx({ allEras: true });
    const copy = METRIC_COPY[id];
    document.getElementById('pa-history-title').textContent = copy.label;
    document.getElementById('pa-history-explain').textContent = copy.explain
      + (id === 'accuracy' ? ' Shaded: before 18 Oct 2026, when only hits on players were counted.' : '')
      + ' Each point is one match; click it for the timing detail.';
    const w = Number(state.smooth) || 0;
    const none = !state.players.length;
    document.getElementById('pa-history-note').textContent = none ? ''
      : (w ? `Line: rolling mean of ${w} matches` : 'Line: every match');
    document.getElementById('pa-history-empty').innerHTML = none
      ? emptyHtml('History charts one line per player.') : '';
    document.getElementById('pa-history-chart').classList.toggle('d-none', none);
    document.getElementById('pa-multiples-card').classList.toggle('d-none', none);
    document.getElementById('pa-history-focus').innerHTML = none ? '' : focusChipHtml();
    if (none) return;
    const canvas = document.getElementById('pa-history-canvas');
    tallerInCrowd(canvas);
    const byDate = state.x === 'date';
    const series = state.players.map((p) => matchSeries(id, p, ctx));
    const leadSeries = series[Math.max(0, state.players.indexOf(leadPlayer()))] || [];
    const focus = focusPlayer();
    const crowd = crowded();
    const datasets = [];
    let xmin = Infinity;
    let xmax = -Infinity;
    state.players.forEach((p, slot) => {
      const col = playerColor(slot);
      const pts = series[slot];
      const xs = pts.map((pt, i) => (byDate ? pt.ts : i + 1));
      xs.forEach((x) => { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); });
      const smooth = rolling(pts.map((pt) => pt.y), w);
      const isFocus = p === focus;
      const dimmed = focus != null && !isFocus;
      const faint = dimmed || (crowd && !isFocus);
      let ptAlpha = w ? 0.35 : 0.85;
      if (dimmed) ptAlpha = 0.12;
      else if (faint) ptAlpha = w ? 0.2 : 0.45;
      datasets.push({
        type: 'scatter', label: playerName(p), data: pts.map((pt, i) => ({ x: xs[i], y: pt.y, m: pt.m, p })),
        backgroundColor: alpha(col, ptAlpha), borderColor: alpha(col, ptAlpha),
        pointRadius: faint ? 1.8 : (w ? 2.5 : 3), pointHoverRadius: 6, pointHitRadius: 6,
        showLine: !w && !faint, borderWidth: 1,
        order: isFocus ? 1 : 3, vtPlayer: p, vtLegend: !w,
      });
      if (w) {
        let lineCol = col;
        if (dimmed) lineCol = alpha(col, 0.25);
        else if (faint) lineCol = alpha(col, 0.75);
        datasets.push({
          type: 'line', label: playerName(p), data: pts.map((pt, i) => ({ x: xs[i], y: smooth[i], m: pt.m, p })),
          borderColor: lineCol, backgroundColor: lineCol, borderWidth: isFocus ? 3.5 : (faint ? 1.2 : 2.5),
          pointRadius: 0, pointHitRadius: 0, cubicInterpolationMode: 'monotone', order: isFocus ? 0 : 2,
          vtSmooth: true, vtPlayer: p, vtLegend: true,
        });
      }
    });
    if (!Number.isFinite(xmin)) { xmin = byDate ? D.dataThroughTs - 90 * DAY : 0; xmax = byDate ? D.dataThroughTs : 1; }
    const regions = [];
    if (id === 'accuracy') {
      let to = D.recorderTs;
      if (!byDate) {
        const idx = leadSeries.findIndex((pt) => pt.ts >= D.recorderTs);
        to = idx < 0 ? null : idx + 0.5;
      }
      if (to != null) regions.push({ to, color: alpha(tc.warning, 0.08), label: 'Players-only hits' });
    }
    const chart = new Chart(canvas, {
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: focusLegendCfg(legendCfg(tc)),
          // The rolling lines have no hit radius, so only the tooltip looks for the nearest point; a click
          // still needs a direct hit on a match.
          tooltip: tooltipCfg({
            mode: 'nearest',
            intersect: false,
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const r = items[0].raw;
                const m = D.matches[r.m];
                return `${dateStr(m.ts)} · ${m.map}`;
              },
              label: (item) => `${playerName(item.raw.p)}: ${fmtValue(id, item.raw.y)}${item.dataset.vtSmooth ? ' (rolling)' : ''}`,
            },
          }),
          zoom: {
            pan: { enabled: true, mode: 'x' },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
            limits: { x: { min: 'original', max: 'original' } },
          },
          paMarkers: {
            lines: eventLines(tc, state.x, leadSeries, id), regions, labelColor: tc.textMuted,
          },
        },
        scales: {
          x: byDate ? {
            type: 'linear', min: xmin - DAY, max: xmax + DAY,
            ticks: { color: tc.textMuted, maxTicksLimit: 8, callback: dateTicks(xmin, xmax) },
            grid: { color: alpha(tc.border, 0.4) },
          } : {
            type: 'linear', min: 0.5, max: xmax + 0.5,
            ticks: { color: tc.textMuted, precision: 0, callback: (v) => (Number.isInteger(v) ? `#${v}` : '') },
            title: { display: true, text: "Player's match number", color: tc.textMuted },
            grid: { color: alpha(tc.border, 0.4) },
          },
          y: yScaleFor(id, tc),
        },
        onClick: (_evt, items) => {
          if (!items.length) return;
          const raw = chart.data.datasets[items[0].datasetIndex].data[items[0].index];
          if (raw) openDrill(raw.m, raw.p);
        },
      },
      plugins: [markerPlugin],
    });
    tabCharts.history.push(chart);
    renderMultiples(tc);
  }

  function renderMultiples(tc) {
    const host = document.getElementById('pa-multiples');
    const focus = focusPlayer();
    let lead = focus;
    if (lead == null && !crowded()) lead = state.players[0];
    document.getElementById('pa-multiples-title').textContent = lead != null
      ? `Every metric for ${playerName(lead)}` + (state.players.length > 1 ? ', others faint' : '')
      : `Every metric, ${state.players.length} players (focus one in the legend above)`;
    const ctx = filterCtx({ allEras: true });
    const ids = D.metricOrder;
    host.innerHTML = ids.map((id) => `<div class="col-md-6 col-xl-4">
        <div class="pa-density-panel" role="button" tabindex="0" data-pick-metric="${id}">
          <div class="small fw-semibold mb-1" title="${esc(METRIC_COPY[id].explain)}">${esc(METRIC_COPY[id].label)}</div>
          <div class="pa-chart pa-chart-sm"><canvas id="pa-mini-${id}"></canvas></div>
        </div></div>`).join('');
    const byDate = state.x === 'date';
    const w = Number(state.smooth) || 5;
    ids.forEach((id) => {
      const datasets = [];
      state.players.forEach((p, slot) => {
        const pts = matchSeries(id, p, ctx);
        const col = playerColor(slot);
        const sm = rolling(pts.map((pt) => pt.y), w);
        const lead0 = p === lead;
        let lineCol = alpha(col, 0.35);
        if (lead0) lineCol = col;
        else if (lead == null) lineCol = alpha(col, 0.55);
        datasets.push({
          type: 'line', data: pts.map((pt, i) => ({ x: byDate ? pt.ts : i + 1, y: sm[i], m: pt.m, p })),
          borderColor: lineCol, backgroundColor: lineCol, borderWidth: lead0 ? 2 : 1.1, pointRadius: 0,
          cubicInterpolationMode: 'monotone', order: lead0 ? 0 : 1, vtSmooth: true,
        });
        if (lead0) {
          datasets.push({
            type: 'scatter', data: pts.map((pt, i) => ({ x: byDate ? pt.ts : i + 1, y: pt.y, m: pt.m, p })),
            backgroundColor: alpha(col, 0.3), pointRadius: 1.5, order: 2,
          });
        }
      });
      const chart = new Chart(document.getElementById(`pa-mini-${id}`), {
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
          plugins: {
            legend: { display: false },
            tooltip: tooltipCfg({
              mode: 'nearest',
              intersect: false,
              callbacks: {
                title: (items) => {
                  if (!items.length) return '';
                  const m = D.matches[items[0].raw.m];
                  return `${dateStr(m.ts)} · ${m.map}`;
                },
                label: (item) => `${playerName(item.raw.p)}: ${fmtValue(id, item.raw.y)}${item.dataset.vtSmooth ? ' (rolling)' : ''}`,
              },
            }),
            paMarkers: { lines: eventLines(tc, state.x, lead != null ? matchSeries(id, lead, ctx) : null, id), labelColor: tc.textMuted },
          },
          scales: {
            x: { type: 'linear', display: false },
            y: Object.assign(yScaleFor(id, tc), { ticks: Object.assign(yScaleFor(id, tc).ticks, { maxTicksLimit: 4, font: { size: 9 } }) }),
          },
        },
        plugins: [markerPlugin],
      });
      tabCharts.history.push(chart);
    });
  }

  // ---------------------------------------------------------------------
  // Compare
  // ---------------------------------------------------------------------

  function renderCompare() {
    destroyTab('compare');
    prepCharts();
    const tc = themeColors();
    const host = document.getElementById('pa-compare-grid');
    document.getElementById('pa-strip-card').classList.toggle('d-none', !state.players.length);
    if (!state.players.length) {
      host.innerHTML = emptyHtml('Compare lines players up side by side, metric by metric.');
      return;
    }
    const ctx = filterCtx();
    const splitTs = state.split ? Date.parse(`${state.split}T00:00:00Z`) : null;
    const ctxB = splitTs != null ? filterCtx({ splitTs, side: 'before' }) : null;
    const ctxA = splitTs != null ? filterCtx({ splitTs, side: 'after' }) : null;
    const aggs = state.players.map((p) => aggPlayer(p, ctx));
    const aggsB = ctxB ? state.players.map((p) => aggPlayer(p, ctxB)) : null;
    const aggsA = ctxA ? state.players.map((p) => aggPlayer(p, ctxA)) : null;
    let html = '<table class="table table-sm pa-table pa-compare-table align-middle"><thead><tr><th>Metric</th>';
    state.players.forEach((p, slot) => {
      html += `<th class="pa-num"><span class="pa-legend-dot" style="background:${playerColor(slot)}"></span>${esc(playerName(p))}</th>`;
    });
    html += '</tr></thead><tbody>';
    html += '<tr><td class="pa-muted">Matches</td>';
    state.players.forEach((_p, i) => {
      html += `<td class="pa-num">${aggs[i].n}${aggsB ? `<small class="d-block pa-muted">${aggsB[i].n} before · ${aggsA[i].n} after</small>` : ''}</td>`;
    });
    html += '</tr>';
    let group = null;
    D.metricOrder.forEach((id) => {
      const meta = D.metrics[id];
      if (meta.group !== group) {
        group = meta.group;
        html += `<tr><th colspan="${state.players.length + 1}" class="pt-3 small text-uppercase pa-muted"><span class="pa-sticky-label">${esc(GROUP_LABELS[group] || group)}</span></th></tr>`;
      }
      html += `<tr><td title="${esc(METRIC_COPY[id].explain)}">${esc(METRIC_COPY[id].label)}</td>`;
      state.players.forEach((p, i) => {
        const r = metricOf(id, aggs[i], ctx);
        let cell = `<span class="${r.ok ? '' : 'pa-muted'}" title="${r.ok ? '' : 'Below the sample size for leader boards'}">${esc(fmtValue(id, r.v))}</span>`;
        if (aggsB) {
          const b = metricOf(id, aggsB[i], ctxB);
          const a = metricOf(id, aggsA[i], ctxA);
          const sb = matchSeries(id, p, ctxB).map((x) => x.y);
          const sa = matchSeries(id, p, ctxA).map((x) => x.y);
          const pv = rankSumP(sb, sa);
          const delta = deltaHtml(id, changeOf(id, b.v, a.v));
          cell = `<div class="pa-split-cell">${esc(fmtValue(id, b.v))} → ${esc(fmtValue(id, a.v))}`
            + `<small>${delta}${pv != null ? ` · p ${pv < 0.001 ? '< 0.001' : pv.toFixed(3)}` : ''}</small></div>`;
        }
        html += `<td class="pa-num">${cell}</td>`;
      });
      html += '</tr>';
    });
    html += `<tr><td class="pa-muted">Titles (${esc(winLabel())})</td>`;
    state.players.forEach((p) => { html += `<td class="pa-titles-cell text-end">${titleChips(p)}</td>`; });
    html += '</tr></tbody></table>';
    host.innerHTML = html;
    renderStrip(tc, ctx, splitTs);
  }

  function winLabel() {
    return state.win === 'all' ? 'all time' : `last ${state.win} days`;
  }

  function renderStrip(tc, ctx, splitTs) {
    const id = state.metric;
    document.getElementById('pa-strip-title').textContent = `${METRIC_COPY[id].label}, one dot per match`;
    const datasets = [];
    state.players.forEach((p, slot) => {
      const col = playerColor(slot);
      const pts = matchSeries(id, p, ctx);
      const data = pts.map((pt) => ({ x: slot + (hashUnit(pt.m * 31 + slot) - 0.5) * 0.6, y: pt.y, m: pt.m, p }));
      const before = splitTs != null ? data.filter((d, i) => pts[i].ts < splitTs) : [];
      const after = splitTs != null ? data.filter((d, i) => pts[i].ts >= splitTs) : data;
      const medB = median(before.map((d) => d.y));
      const medA = median(after.map((d) => d.y));
      const afterSide = splitTs != null ? 'after' : '';
      if (before.length) {
        datasets.push({
          type: 'scatter', label: `${playerName(p)} before`, data: before, backgroundColor: alpha(col, 0.25), pointRadius: 3,
          vtMed: medB, vtSide: 'before',
        });
      }
      datasets.push({
        type: 'scatter', label: splitTs != null ? `${playerName(p)} after` : playerName(p), data: after,
        backgroundColor: alpha(col, 0.75), pointRadius: 3, vtMed: medA, vtSide: afterSide,
      });
      const bars = splitTs != null ? [[medB, alpha(col, 0.5), 'before'], [medA, col, 'after']] : [[medA, col, '']];
      bars.forEach(([mv, c, side]) => {
        if (mv == null) return;
        datasets.push({
          type: 'line', label: 'median', data: [{ x: slot - 0.38, y: mv, p }, { x: slot + 0.38, y: mv, p }],
          borderColor: c, backgroundColor: c, borderWidth: 3, pointRadius: 0, vtMedian: true, vtSide: side,
        });
      });
    });
    const canvas = document.getElementById('pa-strip-canvas');
    canvas.parentElement.classList.toggle('pa-chart-md', !crowded());
    canvas.parentElement.classList.toggle('pa-chart-lg', crowded());
    const chart = new Chart(canvas, {
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        plugins: {
          legend: { display: false },
          tooltip: tooltipCfg({
            mode: 'nearest',
            intersect: false,
            callbacks: {
              title: (items) => (items.length && items[0].raw.m != null ? `${dateStr(D.matches[items[0].raw.m].ts)} · ${D.matches[items[0].raw.m].map}` : ''),
              label: (item) => {
                const ds = item.dataset;
                const side = ds.vtSide ? ` ${ds.vtSide}` : '';
                if (ds.vtMedian) return `${playerName(item.raw.p)} median${side}: ${fmtValue(id, item.raw.y)}`;
                const med = ds.vtMed != null ? ` · median${side} ${fmtValue(id, ds.vtMed)}` : '';
                return `${playerName(item.raw.p)}: ${fmtValue(id, item.raw.y)}${med}`;
              },
            },
          }),
        },
        scales: {
          x: {
            type: 'linear', min: -0.6, max: state.players.length - 0.4,
            ticks: {
              stepSize: 1, autoSkip: false, includeBounds: false, maxRotation: 70, color: tc.text,
              callback: (v) => (Number.isInteger(v) && state.players[v] != null ? playerName(state.players[v]) : ''),
            },
            grid: { display: false },
          },
          y: yScaleFor(id, tc),
        },
        onClick: (_e, items) => {
          const it = items.find((x) => !chart.data.datasets[x.datasetIndex].vtMedian);
          if (!it) return;
          const raw = chart.data.datasets[it.datasetIndex].data[it.index];
          if (raw && raw.m != null) openDrill(raw.m, raw.p);
        },
      },
    });
    tabCharts.compare.push(chart);
  }

  function suggestSplit() {
    const note = document.getElementById('pa-suggest-note');
    const p = leadPlayer();
    if (p == null) { note.textContent = 'Pick a player first.'; return; }
    const id = state.metric;
    const pts = matchSeries(id, p, filterCtx());
    const MIN = 8;
    if (pts.length < MIN * 2) { note.textContent = `Not enough matches with ${METRIC_COPY[id].label.toLowerCase()} for ${playerName(p)}.`; return; }
    const ys = pts.map((x) => x.y);
    const n = ys.length;
    const pre = [0];
    ys.forEach((y) => pre.push(pre[pre.length - 1] + y));
    let best = null;
    for (let k = MIN; k <= n - MIN; k++) {
      const m1 = pre[k] / k;
      const m2 = (pre[n] - pre[k]) / (n - k);
      const score = (k * (n - k) / n) * (m1 - m2) * (m1 - m2);
      if (!best || score > best.score) best = { k, score, m1, m2 };
    }
    state.split = isoDay(pts[best.k].ts);
    document.getElementById('pa-split').value = state.split;
    note.textContent = `Biggest change for ${playerName(p)} on ${METRIC_COPY[id].label.toLowerCase()}: `
      + `${fmtValue(id, best.m1)} before ${dateStr(pts[best.k].ts)}, ${fmtValue(id, best.m2)} from then on.`;
    filtersChanged();
  }

  // ---------------------------------------------------------------------
  // Reload timing
  // ---------------------------------------------------------------------

  function fillReloadSelect() {
    const sel = document.getElementById('pa-reload-weapon');
    const sums = new Map();
    D.reload.forEach((r) => {
      if (r.q < 0) return;
      const s = sums.get(r.a) || { sb: 0, R: [] };
      s.sb += r.sb;
      s.R.push(r.Rms);
      sums.set(r.a, s);
    });
    const anchors = [...sums.entries()].filter(([, s]) => s.sb >= 50)
      .map(([wi, s]) => ({ wi, sb: s.sb, Rms: median(s.R) }))
      .sort((a, b) => b.Rms - a.Rms || a.wi - b.wi);
    let html = '<option value="all">Every slow weapon</option>';
    Object.entries(RELOAD_CLASSES).forEach(([cid, c]) => {
      html += `<option value="class:${cid}">${esc(LEADER_TITLES[cid].title)}: ${esc(c.label.toLowerCase())}</option>`;
    });
    html += '<optgroup label="One weapon">';
    anchors.forEach((a) => {
      html += `<option value="${esc(D.weapons[a.wi].stem)}">${esc(weaponName(a.wi))} · ${(a.Rms / 1000).toFixed(2)} s</option>`;
    });
    html += '</optgroup>';
    sel.innerHTML = html;
    sel.value = state.rw;
    if (sel.value !== state.rw) { state.rw = DEFAULTS.rw; sel.value = state.rw; }
  }

  function quadrants(hist2d) {
    let tot = 0;
    const q = { dotSeam: 0, dotLost: 0, lateSeam: 0, lateLost: 0 };
    hist2d.forEach((row, mb) => row.forEach((c, db) => {
      tot += c;
      const dot = mb <= D.constants.dot_bins;
      const seam = db <= D.constants.seam_bins;
      if (dot && seam) q.dotSeam += c; else if (dot) q.dotLost += c; else if (seam) q.lateSeam += c; else q.lateLost += c;
    }));
    return { tot, q };
  }

  function byPlayerName(a, b) {
    return playerName(a).toLowerCase().localeCompare(playerName(b).toLowerCase());
  }

  // Best and Worst order by the bottom-left share, the table's Both column. Players the table leaves out
  // (under RELOAD_MIN_SB) follow in name order, and panels with nothing to draw come last.
  function orderPanels(panels) {
    const byName = (a, b) => byPlayerName(a.p, b.p);
    if (state.rsort !== 'best' && state.rsort !== 'worst') return panels.sort(byName);
    const sgn = state.rsort === 'worst' ? 1 : -1;
    return panels.sort((a, b) => {
      if (a.pop && b.pop) return sgn * (a.pop.perf - b.pop.perf) || b.sb - a.sb || byName(a, b);
      if (a.pop || b.pop) return a.pop ? -1 : 1;
      if (!a.tot !== !b.tot) return a.tot ? -1 : 1;
      return byName(a, b);
    });
  }

  function renderReload() {
    const tc = themeColors();
    const sel = reloadSelection();
    const ctx = filterCtx(sel);
    const host = document.getElementById('pa-density');
    const cap = D.constants.margin_cap;
    const dcap = D.constants.dead_cap;
    const pop = reloadPopulation(ctx);
    const popBy = new Map(pop.map((r) => [r.p, r]));
    document.getElementById('pa-reload-note').textContent = state.pair ? 'The weapon-pair filter applies.' : '';
    if (!state.players.length) {
      host.innerHTML = `<div class="col-12">${emptyHtml('Each player gets a map of their switch-backs on this weapon.')}</div>`;
    } else {
      const panels = state.players.map((p, slot) => {
        const grid = Array.from({ length: cap + 1 }, () => new Array(dcap + 1).fill(0));
        let held = 0;
        let held0 = 0;
        let sb = 0;
        for (const row of D.rowsByPlayer[p]) {
          if (!matchOk(ctx, row.m)) continue;
          for (const r of D.reloadByKey.get(key(row.m, p)) || []) {
            if (!reloadOk(ctx, r)) continue;
            if (r.q < 0) { held += r.held; held0 += r.held0; continue; }
            sb += r.sb;
            for (const [mb, db, c] of r.hist) grid[Math.min(mb, cap)][Math.min(db, dcap)] += c;
          }
        }
        const { tot, q } = quadrants(grid);
        const own = popBy.get(p) || null;
        const rank = own ? 1 + pop.filter((r) => r.perf > own.perf).length : null;
        return { p, slot, grid, held, held0, sb, tot, q, pop: own, rank };
      });
      orderPanels(panels);
      const cols = crowded() ? 'col-sm-6 col-lg-4 col-xxl-3' : 'col-md-6 col-xl-4';
      host.innerHTML = panels.map((x) => {
        let rank = '';
        if (x.pop) {
          rank = `<span class="pa-density-rank" title="Rank on the bottom-left share among everyone in the table below">#${x.rank} of ${pop.length}</span>`;
        } else if (x.tot) {
          rank = `<span class="pa-density-rank" title="Fewer than ${RELOAD_MIN_SB} switch-backs on this selection">Not ranked</span>`;
        }
        return `<div class="${cols}">
          <div class="pa-density-panel">
            <div class="pa-density-name"><span class="pa-legend-dot" style="background:${playerColor(x.slot)}"></span>${esc(playerName(x.p))}${rank}</div>
            <canvas class="pa-density-canvas" id="pa-density-${x.slot}"></canvas>
            <div class="pa-density-stats" id="pa-density-stats-${x.slot}"></div>
          </div></div>`;
      }).join('');
      panels.forEach((x) => {
        const canvas = document.getElementById(`pa-density-${x.slot}`);
        drawDensity(canvas, x.grid, tc, playerColor(x.slot));
        canvasTip(canvas, (cx, cy) => densityHit(canvas, x.grid, x.tot, cx, cy));
        const mhist = x.grid.map((r) => r.reduce((a, b) => a + b, 0));
        const mm = histMedian(mhist);
        const { held, held0 } = x;
        document.getElementById(`pa-density-stats-${x.slot}`).textContent = x.tot
          ? `${x.sb.toLocaleString()} switch-backs · median margin ${mm * BIN_MS} ms · held cycles ${held.toLocaleString()}`
            + (held ? ` (${pct(held0 / held, 0)} on the dot)` : '')
          : (held ? `No partnered switch-backs · held cycles ${held.toLocaleString()} (${pct(held0 / held, 0)} on the dot)` : 'No switch-backs on this selection.');
        if (!x.tot) return;
        drawQuadrantLabels(canvas, x.q, x.tot, tc);
      });
    }
    renderPopulation(pop);
    renderReference();
  }

  function canvasSize(canvas, h) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const hh = h || canvas.clientHeight || Math.round(w / 1.6);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c, w, h: hh };
  }

  // One floating tip for the hand-drawn canvases; Chart.js charts use their own.
  let canvasTipEl = null;
  let canvasTipOwner = null;

  function hideCanvasTip() {
    if (canvasTipEl) canvasTipEl.classList.remove('is-shown');
    canvasTipOwner = null;
  }

  function showCanvasTip(canvas, hit, cx, cy) {
    if (!canvasTipEl) {
      canvasTipEl = document.createElement('div');
      canvasTipEl.className = 'pa-canvas-tip';
      canvasTipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(canvasTipEl);
      window.addEventListener('scroll', hideCanvasTip, true);
      // A re-render can remove the canvas under the cursor without a pointerleave.
      document.addEventListener('pointermove', (e) => {
        if (canvasTipOwner && e.target !== canvasTipOwner) hideCanvasTip();
      }, { passive: true });
    }
    canvasTipOwner = canvas;
    const t = canvasTipEl;
    t.replaceChildren();
    const title = document.createElement('div');
    title.className = 'pa-canvas-tip-title';
    title.textContent = hit.title;
    t.appendChild(title);
    (hit.lines || []).forEach((line) => {
      const el = document.createElement('div');
      el.textContent = line;
      t.appendChild(el);
    });
    t.classList.add('is-shown');
    const gap = 14;
    const box = t.getBoundingClientRect();
    let x = cx + gap;
    let y = cy + gap;
    if (x + box.width > window.innerWidth - 8) x = cx - gap - box.width;
    if (y + box.height > window.innerHeight - 8) y = cy - gap - box.height;
    t.style.left = `${Math.max(8, x)}px`;
    t.style.top = `${Math.max(8, y)}px`;
  }

  // hitTest(x, y) takes CSS pixels inside the canvas and returns { title, lines } or null. A redraw replaces
  // it; the listeners are bound once per canvas.
  function canvasTip(canvas, hitTest) {
    canvas.paHitTest = hitTest;
    if (canvas.paTipBound) return;
    canvas.paTipBound = true;
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      const hit = canvas.paHitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit) showCanvasTip(canvas, hit, e.clientX, e.clientY);
      else hideCanvasTip();
    });
    canvas.addEventListener('pointerleave', hideCanvasTip);
  }

  // Bins count ticks, so at 30 or 60 Hz a bin holds a range: 0 is none, b is up to b × 50 ms, the last holds
  // everything beyond.
  function binLabel(b, last) {
    if (b === 0) return '0 ms';
    if (b >= last) return `over ${(last - 1) * BIN_MS} ms`;
    return `${(b - 1) * BIN_MS}–${b * BIN_MS} ms`;
  }

  const DENSITY_PAD = { l: 34, r: 6, t: 6, b: 26 };

  function densityHit(canvas, grid, tot, x, y) {
    if (!tot) return null;
    const P = DENSITY_PAD;
    const cols = grid.length;
    const rows = grid[0].length;
    const mb = Math.floor((x - P.l) / ((canvas.clientWidth - P.l - P.r) / cols));
    const db = rows - 1 - Math.floor((y - P.t) / ((canvas.clientHeight - P.t - P.b) / rows));
    if (mb < 0 || mb >= cols || db < 0 || db >= rows) return null;
    const n = grid[mb][db];
    return {
      title: `${binLabel(mb, cols - 1)} after ready, ${binLabel(db, rows - 1)} of fire lost`,
      lines: [`${n.toLocaleString()} switch-back${n === 1 ? '' : 's'} (${pct(n / tot)})`],
    };
  }

  function drawDensity(canvas, grid, tc, color) {
    const { c, w, h } = canvasSize(canvas);
    const P = DENSITY_PAD;
    const cols = grid.length;
    const rows = grid[0].length;
    const cw = (w - P.l - P.r) / cols;
    const ch = (h - P.t - P.b) / rows;
    let max = 0;
    grid.forEach((r) => r.forEach((v) => { max = Math.max(max, v); }));
    c.clearRect(0, 0, w, h);
    c.fillStyle = alpha(tc.border, 0.35);
    c.fillRect(P.l, P.t, w - P.l - P.r, h - P.t - P.b);
    grid.forEach((r, mb) => r.forEach((v, db) => {
      if (!v) return;
      const t = Math.log1p(v) / Math.log1p(max);
      c.fillStyle = alpha(color, 0.15 + 0.85 * t);
      c.fillRect(P.l + mb * cw + 0.5, P.t + (rows - 1 - db) * ch + 0.5, cw - 1, ch - 1);
    }));
    c.strokeStyle = alpha(tc.textMuted, 0.6);
    c.setLineDash([3, 3]);
    const dx = P.l + (D.constants.dot_bins + 1) * cw;
    const dy = P.t + (rows - 1 - D.constants.seam_bins) * ch;
    c.beginPath();
    c.moveTo(dx, P.t); c.lineTo(dx, h - P.b);
    c.moveTo(P.l, dy); c.lineTo(w - P.r, dy);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = tc.textMuted;
    c.font = '9px Geist, sans-serif';
    c.textAlign = 'center';
    [0, 5, 10, 15, 20].forEach((b) => {
      const label = b === cols - 1 ? `${b * BIN_MS}+` : `${b * BIN_MS}`;
      c.fillText(label, P.l + (b + 0.5) * cw, h - P.b + 11);
    });
    c.fillText('margin after ready (ms)', P.l + (w - P.l - P.r) / 2, h - 3);
    c.textAlign = 'right';
    [0, 5, 10].forEach((b) => {
      const label = b === rows - 1 ? `${b * BIN_MS}+` : `${b * BIN_MS}`;
      c.fillText(label, P.l - 4, P.t + (rows - 1 - b + 0.5) * ch + 3);
    });
    c.save();
    c.translate(9, P.t + (h - P.t - P.b) / 2);
    c.rotate(-Math.PI / 2);
    c.textAlign = 'center';
    c.fillText('fire lost (ms)', 0, 0);
    c.restore();
  }

  function drawQuadrantLabels(canvas, q, tot, tc) {
    const c = canvas.getContext('2d');
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const P = DENSITY_PAD;
    // The labels sit on the brightest cells, so each gets a card-colored outline.
    const label = (txt, x, y) => { c.strokeText(txt, x, y); c.fillText(txt, x, y); };
    c.lineJoin = 'round';
    c.lineWidth = 3;
    c.strokeStyle = tc.card;
    c.font = '10px Geist, sans-serif';
    c.fillStyle = tc.text;
    c.textAlign = 'right';
    label(`late, lost ${pct(q.lateLost / tot, 0)}`, w - P.r - 4, P.t + 12);
    label(`late, seamless ${pct(q.lateSeam / tot, 0)}`, w - P.r - 4, h - P.b - 6);
    c.textAlign = 'left';
    label(`early, waited ${pct(q.dotLost / tot, 0)}`, P.l + 4, P.t + 12);
    label(`on the dot, seamless ${pct(q.dotSeam / tot, 0)}`, P.l + 4, h - P.b - 6);
    // The tags sit one line inward so a narrow panel's bottom labels keep their room.
    c.font = '600 9px Geist, sans-serif';
    c.fillStyle = tc.danger;
    c.textAlign = 'right';
    label('WORST', w - P.r - 4, P.t + 24);
    c.fillStyle = tc.success;
    c.textAlign = 'left';
    label('BEST', P.l + 4, h - P.b - 18);
  }

  // Everyone with enough switch-backs on the selection: the table under the panels, and the panels' ranks.
  function reloadPopulation(ctx) {
    const rows = [];
    D.players.forEach((pl) => {
      const agg = aggPlayer(pl.i, ctx);
      if (agg.sb < RELOAD_MIN_SB) return;
      const mm = histMedian(agg.mhist);
      rows.push({ p: pl.i, sb: agg.sb, dot: agg.dot / agg.sb, seam: agg.seam / agg.sb, perf: agg.perf / agg.sb, mm: mm == null ? null : mm * BIN_MS });
    });
    return rows;
  }

  function renderPopulation(pop) {
    const host = document.getElementById('pa-population');
    const rows = pop.slice();
    const N = rows.length;
    if (!N) {
      host.innerHTML = '<p class="text-muted small p-3 mb-0">Nobody has 30 switch-backs on this selection.</p>';
      return;
    }
    const rankOf = (field, v) => 1 + rows.filter((r) => r[field] > v).length;
    const topTxt = (field, v) => {
      const rk = rankOf(field, v);
      const top = Math.max(1, Math.ceil(rk / N * 100));
      return `#${rk} of ${N}${top <= 50 ? ` · top ${top}%` : ''}`;
    };
    rows.sort((a, b) => b.perf - a.perf || b.sb - a.sb);
    const sel = highlightSet();
    let html = `<table class="table table-sm pa-table align-middle"><thead><tr><th>Player</th><th class="pa-num">Switch-backs</th>
      <th class="pa-num">On the dot</th><th class="pa-num">Seamless</th><th class="pa-num">Both</th><th class="pa-num">Median margin</th></tr></thead><tbody>`;
    rows.forEach((r) => {
      html += `<tr class="${sel.has(r.p) ? 'pa-row-selected' : ''}"><td>${esc(playerName(r.p))}</td>
        <td class="pa-num">${r.sb.toLocaleString()}</td>
        <td class="pa-num">${pct(r.dot)}<small class="d-block pa-muted">${topTxt('dot', r.dot)}</small></td>
        <td class="pa-num">${pct(r.seam)}<small class="d-block pa-muted">${topTxt('seam', r.seam)}</small></td>
        <td class="pa-num">${pct(r.perf)}<small class="d-block pa-muted">${topTxt('perf', r.perf)}</small></td>
        <td class="pa-num">${r.mm == null ? '—' : `${r.mm} ms`}</td></tr>`;
    });
    html += '</tbody></table>';
    host.innerHTML = html;
  }

  function renderReference() {
    const host = document.getElementById('pa-reference');
    const term = (document.getElementById('pa-ref-search').value || '').trim().toLowerCase();
    const ship = state.ship ? D.shipByStem.get(state.ship) : -1;
    let shortTot = 0;
    let volTot = 0;
    D.reference.forEach((r) => { shortTot += r.below; volTot += r.vols; });
    const flagged = D.reference.filter((r) => r.flag).length;
    document.getElementById('pa-ref-explain').textContent = 'Effective reload is the ODF shotDelay at 20 ticks a second, '
      + 'split across barrels that alternate. The engine carries leftover reload into the next shot, so a gap one tick '
      + `shorter is still legal. Shorter gaps (${shortTot.toLocaleString()} of ${volTot.toLocaleString()} volleys) are left out of the timing counts. `
      + `A weapon is flagged, highlighted and dropped from the switch-back counts only when they are systematic: ${flagged ? `${flagged} flagged` : 'none are'}.`;
    const rows = D.reference.filter((r) => {
      if (ship >= 0 && r.s !== ship) return false;
      if (!term) return true;
      const w = D.weapons[r.w];
      return `${shipName(r.s)} ${D.ships[r.s].stem} ${weaponName(r.w)} ${w.stem}`.toLowerCase().includes(term);
    }).sort((a, b) => b.shots - a.shots);
    let html = `<table class="table table-sm pa-table align-middle"><thead><tr>
      <th>Ship</th><th>Weapon</th><th class="pa-num">shotDelay</th><th class="pa-num">Barrels</th><th>Alternate</th>
      <th class="pa-num">Salvo</th><th class="pa-num">Initial delay</th><th class="pa-num">Effective reload</th>
      <th class="pa-num">Shortest legal gap</th><th class="pa-num">Observed floor</th><th class="pa-num">Shorter gaps</th>
      <th class="pa-num">Shots</th><th class="pa-num">Players</th></tr></thead><tbody>`;
    rows.forEach((r) => {
      const w = D.weapons[r.w];
      const mismatch = !!r.flag;
      const isolated = !r.flag && r.floor_ms != null && r.Rmin_ms != null && r.floor_ms < r.Rmin_ms;
      const why = w.why ? WHY_LABELS[w.why] || w.why : '';
      const odfLink = w.stem.startsWith('ord:') ? esc(weaponName(r.w))
        : `<a href="../odf/index.html?odf=${encodeURIComponent(w.stem)}" target="_blank" rel="noopener">${esc(weaponName(r.w))}</a>`;
      html += `<tr class="${mismatch ? 'pa-ref-flag' : ''}">
        <td>${esc(shipName(r.s))}<small class="d-block pa-muted">${esc(D.ships[r.s].stem)}</small></td>
        <td>${odfLink}<small class="d-block pa-muted">${esc(w.stem)}${why ? ` · ${esc(why)}` : ''}</small></td>
        <td class="pa-num">${w.shot_delay != null ? `${w.shot_delay} s` : '—'}</td>
        <td class="pa-num">${r.hp != null ? r.hp : '—'}</td>
        <td>${w.alt ? 'yes' : 'no'}</td>
        <td class="pa-num">${w.salvo > 1 ? `${w.salvo} × ${w.salvo_delay} s` : '1'}</td>
        <td class="pa-num">${w.isd ? `${w.isd} s` : '—'}</td>
        <td class="pa-num">${r.R_ms != null ? `${r.R_ms} ms` : '<span class="pa-muted">excluded</span>'}</td>
        <td class="pa-num">${r.Rmin_ms != null ? `${r.Rmin_ms} ms` : '—'}</td>
        <td class="pa-num">${r.floor_ms != null ? `${Math.round(r.floor_ms)} ms` : '—'}${isolated ? '<small class="d-block pa-muted">isolated</small>' : ''}</td>
        <td class="pa-num">${r.below ? r.below.toLocaleString() : '0'}${r.desync ? `<small class="d-block pa-muted">${r.desync} drifted</small>` : ''}</td>
        <td class="pa-num">${r.shots.toLocaleString()}</td>
        <td class="pa-num">${r.players}</td></tr>`;
    });
    html += '</tbody></table>';
    host.innerHTML = rows.length ? html : '<p class="text-muted small p-3 mb-0">No weapons match.</p>';
  }

  // ---------------------------------------------------------------------
  // Rhythm map
  // ---------------------------------------------------------------------

  function renderRhythm() {
    destroyTab('rhythm');
    prepCharts();
    const tc = themeColors();
    const ctx = filterCtx();
    const sel = new Map(state.players.map((p, slot) => [p, slot]));
    const groups = new Map();
    const anchors = new Map();
    let count = 0;
    let minPeriod = Infinity;
    D.streaks.forEach((s) => {
      if (!matchOk(ctx, s.m) || !streakOk(ctx, s)) return;
      count += 1;
      minPeriod = Math.min(minPeriod, s.per);
      anchors.set(s.a, (anchors.get(s.a) || 0) + 1);
      const g = sel.has(s.p) ? `p${s.p}` : (s.pv == null ? 'untested' : 'others');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({
        x: s.per, y: s.pv == null ? 0 : -Math.log10(s.pv), r: Math.min(14, 2 + Math.sqrt(s.n) * 0.9),
        m: s.m, p: s.p, t0: s.t0, s,
      });
    });
    const datasets = [];
    if (groups.has('untested')) {
      datasets.push({
        label: 'Not tested (hollow)', data: groups.get('untested'), backgroundColor: 'transparent',
        borderColor: alpha(tc.textMuted, 0.35), borderWidth: 1, vtKey: { fill: 'transparent', stroke: tc.textMuted },
      });
    }
    if (groups.has('others')) {
      datasets.push({
        label: 'Everyone else', data: groups.get('others'), backgroundColor: alpha(tc.textMuted, 0.25),
        borderColor: alpha(tc.textMuted, 0.4), borderWidth: 1, vtKey: { fill: alpha(tc.textMuted, 0.6), stroke: tc.textMuted },
      });
    }
    const focus = focusPlayer();
    state.players.forEach((p, slot) => {
      const g = groups.get(`p${p}`);
      if (!g) return;
      const col = playerColor(slot);
      const dimmed = focus != null && p !== focus;
      const edge = dimmed ? alpha(col, 0.3) : col;
      let order = 0;
      if (dimmed) order = 1;
      else if (p === focus) order = -1;
      const tested = g.filter((d) => d.s.pv != null);
      const untested = g.filter((d) => d.s.pv == null);
      datasets.push({
        label: playerName(p), data: tested, backgroundColor: alpha(col, dimmed ? 0.12 : 0.6), borderColor: edge,
        borderWidth: 1.2, order, vtPlayer: p, vtLegend: true,
      });
      if (untested.length) {
        datasets.push({
          label: `${playerName(p)} (not tested)`, data: untested, backgroundColor: 'transparent', borderColor: edge,
          borderWidth: 1.2, order, vtPlayer: p, vtLegend: false,
        });
      }
    });
    datasets.forEach((d) => { if (d.vtLegend === undefined) d.vtLegend = true; });
    const hlines = [{ y: 2, color: tc.warning, label: 'p = 0.01' }];
    const lines = [];
    let anchor = null;
    if (ctx.pair) anchor = ctx.pair[0];
    else if (anchors.size) anchor = [...anchors.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (anchor != null) {
      const refs = D.reference.filter((r) => r.w === anchor && r.R_ms != null);
      const Rms = median(refs.map((r) => r.R_ms));
      if (Rms != null) lines.push({ x: Rms, color: tc.info, label: `${weaponName(anchor)} reload ${Rms} ms` });
    }
    if (!Number.isFinite(minPeriod)) minPeriod = 100;
    document.getElementById('pa-rhythm-note').textContent = `${count.toLocaleString()} streaks`;
    document.getElementById('pa-rhythm-explain').textContent = 'Each dot is one streak of 10+ alternation cycles. '
      + 'Right is a slower cycle; higher is a more even beat than shuffles of its own gaps would give. Hollow dots were '
      + 'not tested (too little variation, or a gap shorter than the reload). Size is the streak length. Click a dot for its gaps.';
    const canvas = document.getElementById('pa-rhythm-canvas');
    tallerInCrowd(canvas);
    const chart = new Chart(canvas, {
      type: 'bubble',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        plugins: {
          legend: focusLegendCfg(dotLegendCfg(tc)),
          tooltip: tooltipCfg({
            mode: 'nearest',
            intersect: false,
            callbacks: {
              title: (items) => (items.length ? `${playerName(items[0].raw.p)} · ${dateStr(D.matches[items[0].raw.m].ts)}` : ''),
              label: (item) => {
                const s = item.raw.s;
                return `${weaponName(s.a)} + ${weaponName(s.q)}: ${s.per.toFixed(1)} ms, ${s.n} cycles, p ${fmtP(s.pv)}, wobble ${fmtValue('jitter', s.jit)}`;
              },
            },
          }),
          zoom: {
            pan: { enabled: true, mode: 'xy' },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'xy' },
          },
          paMarkers: { lines, hlines, labelColor: tc.textMuted },
        },
        scales: {
          x: {
            type: 'logarithmic', min: Math.max(50, Math.floor(minPeriod * 0.85)),
            title: { display: true, text: 'Cycle period (ms, log scale)', color: tc.textMuted },
            ticks: {
              color: tc.textMuted, autoSkip: false,
              callback: (v) => ([100, 200, 300, 500, 1000, 2000, 3000, 5000].includes(Math.round(v)) ? Math.round(v) : ''),
            },
            grid: { color: alpha(tc.border, 0.4) },
          },
          y: {
            type: 'linear', min: -0.15, suggestedMax: 3.2,
            title: { display: true, text: 'Evenness (−log10 p)', color: tc.textMuted },
            ticks: { color: tc.textMuted, stepSize: 0.5, callback: (v) => (v < 0 ? '' : v) },
            grid: { color: alpha(tc.border, 0.4) },
          },
        },
        onClick: (_e, items) => {
          if (!items.length) return;
          const raw = chart.data.datasets[items[0].datasetIndex].data[items[0].index];
          if (raw) openDrill(raw.m, raw.p, { t0: raw.t0 });
        },
      },
      plugins: [markerPlugin],
    });
    tabCharts.rhythm.push(chart);
  }

  // ---------------------------------------------------------------------
  // All players
  // ---------------------------------------------------------------------

  function renderPlayers() {
    const id = state.metric;
    const ctx = filterCtx();
    const splitTs = state.split ? Date.parse(`${state.split}T00:00:00Z`) : null;
    const ctxB = splitTs != null ? filterCtx({ splitTs, side: 'before' }) : null;
    const ctxA = splitTs != null ? filterCtx({ splitTs, side: 'after' }) : null;
    document.getElementById('pa-players-note').textContent = `${METRIC_COPY[id].explain}`
      + (splitTs != null ? '' : ' Set a split date to see the change.');
    const rows = D.players.map((pl) => {
      const p = pl.i;
      const all = metricOf(id, aggPlayer(p, ctx), ctx);
      const inRange = D.rowsByPlayer[p].filter((r) => matchOk(ctx, r.m));
      const last10 = metricOf(id, aggPlayer(p, ctx, inRange.slice(-10)), ctx);
      const b = ctxB ? metricOf(id, aggPlayer(p, ctxB), ctxB) : null;
      const a = ctxA ? metricOf(id, aggPlayer(p, ctxA), ctxA) : null;
      const change = b && a ? changeOf(id, b.v, a.v) : null;
      return { p, n: inRange.length, all, last10, b, a, change };
    });
    const [col, dirS] = (state.sort || DEFAULTS.sort).split(':');
    const sgn = dirS === 'asc' ? 1 : -1;
    const val = (r) => {
      switch (col) {
        case 'name': return { v: playerName(r.p).toLowerCase(), ok: true };
        case 'n': return { v: r.n, ok: true };
        case 'last10': return r.last10;
        case 'before': return r.b || { v: null };
        case 'after': return r.a || { v: null };
        case 'change': return { v: r.change, ok: !!(r.b && r.a && r.b.ok && r.a.ok) };
        default: return r.all;
      }
    };
    rows.sort((x, y) => {
      const a = val(x);
      const b = val(y);
      if (a.v == null && b.v == null) return x.p - y.p;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (typeof a.v === 'string') return sgn * a.v.localeCompare(b.v);
      return sgn * (a.v - b.v) || x.p - y.p;
    });
    const th = (k, label, num) => `<th class="pa-sortable${num ? ' pa-num' : ''}${col === k ? ' pa-sorted' : ''}" data-sort="${k}">${label}${col === k ? (sgn > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const cell = (r) => (r ? `<span class="${r.ok ? '' : 'pa-muted'}">${esc(fmtValue(id, r.v))}</span>` : '<span class="pa-muted">—</span>');
    const sel = highlightSet();
    let html = `<table class="table table-sm table-hover pa-table align-middle"><thead><tr>
      ${th('name', 'Player')}${th('n', 'Matches', true)}${th('all', 'In range', true)}${th('last10', 'Last 10', true)}
      ${th('before', 'Before split', true)}${th('after', 'After split', true)}${th('change', 'Change', true)}<th>Titles (${esc(winLabel())})</th>
      </tr></thead><tbody>`;
    rows.forEach((r) => {
      let ch = r.change != null ? deltaHtml(id, r.change) : '<span class="pa-muted">—</span>';
      if (r.change != null && !(r.b.ok && r.a.ok)) {
        const txt = fmtDelta(id, r.change);
        ch = `<span class="pa-muted" title="Below the sample size on one side">${/[1-9]/.test(txt) ? esc(txt) : '±0'}</span>`;
      }
      html += `<tr class="${sel.has(r.p) ? 'pa-row-selected' : ''}" role="button" data-toggle-player="${r.p}" title="Click to add or remove from the selection">
        <td>${esc(playerName(r.p))}</td><td class="pa-num">${r.n}</td><td class="pa-num">${cell(r.all)}</td>
        <td class="pa-num">${cell(r.last10)}</td><td class="pa-num">${cell(r.b)}</td><td class="pa-num">${cell(r.a)}</td>
        <td class="pa-num">${ch}</td><td class="pa-titles-cell">${titleChips(r.p)}</td></tr>`;
    });
    html += '</tbody></table>';
    document.getElementById('pa-players-table').innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Drill-down
  // ---------------------------------------------------------------------

  function anchorTicks(m, p, s, a) {
    const r = (D.reloadByKey.get(key(m, p)) || []).find((x) => x.s === s && x.a === a);
    if (r) return r.R;
    const ref = D.reference.find((x) => x.s === s && x.w === a);
    return ref && ref.R_ms ? Math.round(ref.R_ms * D.matches[m].hz / 1000) : null;
  }

  // `drill=<match id>~<player>[~<streak start tick>]`
  function drillKey() {
    return [D.matches[drill.m].id, playerToken(drill.p)].concat(drill.t0 != null ? [drill.t0] : []).join('~');
  }

  function openDrillFromUrl(back) {
    const [id, token, t0] = state.drill.split('~');
    const m = D.matches.findIndex((x) => x.id === id);
    const p = D.playerByToken.get(token);
    if (m >= 0 && p != null) {
      openDrill(m, p, { t0: t0 ? Number(t0) : null, back: !!back });
    } else {
      state.drill = '';
      writeUrl();
    }
  }

  // `back` keeps the career list this match was opened from.
  function openDrill(m, p, opts) {
    const o = opts || {};
    const back = !!(o.back && careerList);
    if (!back) {
      careerList = null;
      state.career = '';
    }
    drill = { m, p, t0: o.t0 != null ? Number(o.t0) : null };
    state.drill = drillKey();
    writeUrl();
    const match = D.matches[m];
    const row = D.rowByKey.get(key(m, p));
    document.getElementById('pa-drill-title').textContent = `${playerName(p)} · ${dateStr(match.ts)} · ${match.map}`;
    const links = matchLinks(m, p);
    const one = newAgg();
    const ctx = filterCtx();
    ctx.ship = -1;
    ctx.pair = null;
    addMatch(one, ctx, m, p);
    const stat = (label, value) => `<div class="pa-drill-stat"><div class="stat-label">${esc(label)}</div><div class="pa-drill-value">${esc(value)}</div></div>`;
    const ships = (D.shipRowsByKey.get(key(m, p)) || []).slice().sort((a, b) => b.mins - a.mins);
    let html = back ? `<button type="button" class="btn btn-link btn-sm p-0 mb-3 pa-cl-back" data-career-back>
        <i class="bi bi-arrow-left me-1"></i>Back to ${esc(LEADER_TITLES[careerList.id].title)} · ${esc(playerName(careerList.p))}</button>` : '';
    html += `<div class="d-flex flex-wrap gap-2 mb-3">
        <a class="btn btn-sm btn-outline-secondary" href="${links.dash}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right me-1"></i>Match dashboard</a>
        <a class="btn btn-sm btn-outline-secondary" href="${links.raw}" target="_blank" rel="noopener"
           title="Every shot this player fired in the match, in the raw event browser"><i class="bi bi-diagram-2 me-1"></i>Raw shots</a>
      </div>
      <p class="small text-muted mb-2">${esc(match.fmt || '')} · ${clockStr(match.dur || 0)} · ${match.hz} ticks a second${row && row.cmd ? ' · commander' : ''}${row && row.camp ? ' · campod' : ''}${row && row.low ? ' · partial' : ''}</p>
      <div class="pa-drill-stats mb-3">`;
    ['sw_rate', 'sw_1tick', 'sw_median', 'period', 'jitter', 'dot_share', 'seam_share', 'margin', 'pvp_hit', 'accuracy', 'tkey', 'pvp_kd']
      .forEach((id) => {
        const r = metricOf(id, one, id === 'accuracy' ? { allEras: true } : ctx);
        html += stat(METRIC_COPY[id].label, fmtValue(id, r.v));
      });
    html += stat('Streaks', `${one.stk} (${one.even} even)`);
    html += stat('Held cycles', one.held ? `${one.held} (${pct(one.held0 / one.held, 0)} on the dot)` : '0');
    html += '</div>';
    if (match.slot) {
      html += '<p class="small text-muted mb-3">This recording credits each team slot\'s AI units (Scavengers, Turrets, '
        + 'buildings) to that slot\'s player, as shooter and as target. The stats pipeline gives those shots and hits back '
        + 'to the AI, so the hit figures here are repaired.'
        + (row && row.noTiming ? ' A commander\'s recorded shots still include his Turrets\' fire, so his timing is left out.' : '')
        + '</p>';
    }
    if (ships.length) {
      html += `<p class="small mb-3"><span class="text-muted">Ships:</span> ${ships.filter((s) => s.mins > 0).slice(0, 6)
        .map((s) => `${esc(shipName(s.s))} ${s.mins.toFixed(1)} min`).join(' · ')}</p>`;
    }
    const streaks = (D.streaksByKey.get(key(m, p)) || []).slice().sort((a, b) => a.t0 - b.t0);
    html += '<h6 class="mt-3">Alternation streaks</h6>';
    if (row && row.noTiming) {
      html += '<p class="small text-muted">Left out for this match.</p>';
    } else if (!streaks.length) {
      html += '<p class="small text-muted">No streaks of 10+ cycles in this match.</p>';
    } else {
      html += '<p class="small text-muted mb-2">Each chip is one cycle, in ticks. Green is the reload exactly, blue one tick over, amber a tick under (the engine\'s carry).</p>';
      streaks.forEach((s) => {
        const R = anchorTicks(m, p, s.s, s.a);
        const gaps = decodeGaps(s.g);
        const chips = gaps.map((g) => {
          let cls = 'pa-gap';
          if (R != null) {
            if (g === R) cls += ' pa-gap-0';
            else if (g === R + 1) cls += ' pa-gap-1';
            else if (g < R) cls += ' pa-gap-short';
          }
          return `<span class="${cls}" title="${Math.round(g * 1000 / match.hz)} ms">${g}</span>`;
        }).join('');
        const active = drill.t0 != null && s.t0 === drill.t0;
        html += `<div class="pa-streak${active ? ' pa-streak--active' : ''}" data-streak-t0="${s.t0}">
          <div class="small d-flex gap-2"><span><strong>${esc(weaponName(s.a))} + ${esc(weaponName(s.q))}</strong> on ${esc(shipName(s.s))}
            · at ${clockStr((s.t0 - match.tick0) / match.hz)}</span>
            <a class="ms-auto text-nowrap" href="${rawHref(m, p, streakTicks(s))}" target="_blank" rel="noopener"
               title="This streak's shots in the raw event browser"><i class="bi bi-diagram-2 me-1"></i>Raw</a></div>
          <div class="small text-muted">${s.n} cycles · ${s.per.toFixed(1)} ms per cycle · p ${fmtP(s.pv)} · wobble ${fmtValue('jitter', s.jit)} · steady run ${s.ck}${R != null ? ` · reload ${R} ticks` : ''}</div>
          <div class="pa-gaps">${chips}</div></div>`;
      });
    }
    const blocks = (D.reloadByKey.get(key(m, p)) || []).filter((r) => r.q >= 0 && r.sb > 0).sort((a, b) => b.sb - a.sb);
    if (blocks.length) {
      html += `<h6 class="mt-3">Switch-backs</h6><div class="table-responsive"><table class="table table-sm pa-table"><thead><tr>
        <th>Slow weapon</th><th>Partner</th><th class="pa-num">Reload</th><th class="pa-num">Switch-backs</th>
        <th class="pa-num">On the dot</th><th class="pa-num">Seamless</th><th class="pa-num">Median margin</th></tr></thead><tbody>`;
      blocks.forEach((r) => {
        const mm = histMedian(r.hist.reduce((h, [mb, , c]) => { h[Math.min(mb, 20)] += c; return h; }, new Array(21).fill(0)));
        html += `<tr><td>${esc(weaponName(r.a))}</td><td>${esc(weaponName(r.q))}</td><td class="pa-num">${Math.round(r.Rms)} ms</td>
          <td class="pa-num">${r.sb}</td><td class="pa-num">${pct(r.dot / r.sb, 0)}</td><td class="pa-num">${pct(r.seam / r.sb, 0)}</td>
          <td class="pa-num">${mm == null ? '—' : `${mm * BIN_MS} ms`}</td></tr>`;
      });
      html += '</tbody></table></div>';
    }
    const wrows = (D.weaponRowsByKey.get(key(m, p)) || []).slice().sort((a, b) => b.sf - a.sf);
    if (wrows.length) {
      html += `<h6 class="mt-3">Weapons fired</h6><div class="table-responsive"><table class="table table-sm pa-table"><thead><tr>
        <th>Ordnance</th><th class="pa-num">Shots</th><th class="pa-num">Hits</th><th class="pa-num">PvP hits</th><th class="pa-num">Damage</th></tr></thead><tbody>`;
      wrows.forEach((r) => {
        const o = D.ordnance[r.o] || {};
        const wi = o.weapon ? D.weaponByStem.get(o.weapon) : null;
        const label = wi != null ? weaponName(wi) : o.stem;
        const sub = o.stem && o.stem !== label ? `<small class="d-block pa-muted">${esc(o.stem)}</small>` : '';
        html += `<tr><td>${esc(label)}${sub}</td><td class="pa-num">${r.sf.toLocaleString()}</td>
          <td class="pa-num">${r.sh.toLocaleString()}</td><td class="pa-num">${r.ph.toLocaleString()}</td><td class="pa-num">${Math.round(r.dmg).toLocaleString()}</td></tr>`;
      });
      html += '</tbody></table></div>';
      if (match.ts < D.recorderTs && !match.slot) html += '<p class="small text-muted">Before 18 Oct 2026 hits count players only.</p>';
    }
    html += `<h6 class="mt-3">Tick lane</h6>
      <div class="small text-muted mb-2"><span class="pa-legend-dot pa-legend-dot--anchor"></span>slow weapon
        <span class="pa-legend-dot pa-legend-dot--partner ms-2"></span>other weapons
        <span class="pa-legend-dot pa-legend-dot--ready ms-2"></span>slow weapon ready
        <span class="pa-legend-dot pa-legend-dot--drop ms-2"></span>silent ammo drop.
        Numbers over a switch-back: margin after ready / fire lost, in ms.</div>
      <div id="pa-lane-host"><p class="small text-muted">Loading&hellip;</p></div>`;
    const body = document.getElementById('pa-drill-body');
    body.innerHTML = html;
    body.scrollTop = 0;
    const panel = document.getElementById('pa-drill');
    const focusStreak = () => {
      const active = body.querySelector('.pa-streak--active');
      if (active) active.scrollIntoView({ block: 'center' });
    };
    if (panel.classList.contains('show')) focusStreak();
    else panel.addEventListener('shown.bs.offcanvas', focusStreak, { once: true });
    bootstrap.Offcanvas.getOrCreateInstance(panel).show();
    loadLanes(m, p);
  }

  // ---------------------------------------------------------------------
  // Career drill: the matches or streaks behind a career figure
  // ---------------------------------------------------------------------

  const CAREER_PAGE = 20;
  const CAREER_STREAK_UNITS = new Set(['even_share', 'jitter']);

  function careerUnitWord(id, n) {
    if (CAREER_STREAK_UNITS.has(id)) return n === 1 ? 'streak' : 'streaks';
    return n === 1 ? 'match' : 'matches';
  }

  // The same pieces the career figure pools: one entry per streak on the two
  // streak boards, else one per match.
  function careerUnits(id, p, ctx) {
    const units = [];
    const gate = MATCH_GATE[id] || 1;
    for (const r of D.rowsByPlayer[p]) {
      if (!matchOk(ctx, r.m)) continue;
      const k = key(r.m, p);
      const shipRows = D.shipRowsByKey.get(k) || [];
      if (CAREER_STREAK_UNITS.has(id)) {
        if (ctx.ship >= 0 && !shipRows.some((x) => x.s === ctx.ship)) continue;
        for (const s of D.streaksByKey.get(k) || []) {
          if (!streakOk(ctx, s)) continue;
          if (id === 'even_share' && s.pv == null) continue;
          const v = id === 'even_share' ? Number(s.pv < D.constants.even_p) : s.jit;
          units.push({ m: r.m, t0: s.t0, streak: s, ship: s.s, a: s.a, q: s.q, v, g: 1, ok: true });
        }
        continue;
      }
      const agg = newAgg();
      addMatch(agg, ctx, r.m, p);
      if (!agg.n) continue;
      const res = metricOf(id, agg, ctx);
      if (res.v == null || !(res.g > 0)) continue;
      let ship = ctx.ship >= 0 ? ctx.ship : null;
      if (ship == null && shipRows.length) ship = shipRows.reduce((b, x) => (x.mins > b.mins ? x : b)).s;
      const top = rowPair(id, r);
      const pair = ctx.pair || (top[0] != null ? top : [null, null]);
      units.push({ m: r.m, t0: null, agg, ship, a: pair[0], q: pair[1], v: res.v, g: res.g, ok: res.g >= gate });
    }
    return units;
  }

  // Lift: how far one unit moved the pooled figure from the typical player, so
  // the lifts sum to the gap. "+" always means it helped. A median has none.
  function addLifts(id, units, typical) {
    const meta = D.metrics[id];
    if (meta.agg !== 'pool' || typical == null || !units.length) return false;
    const dir = meta.dir || 1;
    if (id === 'pvp_kd') {
      const pd = units.reduce((s, u) => s + u.agg.pd, 0);
      units.forEach((u) => { u.lift = dir * (u.agg.pk - typical * u.agg.pd) / Math.max(1, pd); });
    } else {
      const total = units.reduce((s, u) => s + u.g, 0);
      units.forEach((u) => { u.lift = dir * u.g * (u.v - typical) / total; });
    }
    return true;
  }

  const LIFT_WEIGHT = {
    swa: 'firing time', swn: 'switches', rtn: 'round trips', sb: 'switch-backs', cyc: 'cycles',
    cycm: 'cycles carrying a mine', sf: 'shots', mins: 'time in a ship',
  };

  function liftNote(id) {
    if (CAREER_STREAK_UNITS.has(id)) {
      return 'Lift is how far each streak moved the career figure from the typical player. Every tested streak counts '
        + 'the same: an even one lifts it, an uneven one pulls it down.';
    }
    if (id === 'pvp_kd') {
      return 'Lift is how far each match moved the career K/D from the typical player: its kills, minus the kills the '
        + 'typical K/D would get from its deaths.';
    }
    return 'Lift is how far each match moved the career figure from the typical player. A match with more '
      + `${LIFT_WEIGHT[D.metrics[id].gate[0]] || 'data'} counts for more, and so does one further past the typical player.`;
  }

  // ---------------------------------------------------------------------
  // Ranked on: the ships and weapon pairs behind a career figure
  // ---------------------------------------------------------------------

  const MIX_ROWS = 5;
  const MIX_WEIGHT = Object.assign({}, LIFT_WEIGHT, { stk: 'streaks', stt: 'tested streaks', n: 'time in a ship' });

  function mixWord(id, list) {
    if (id === 'sw_rate') return 'switches';
    if (list && list.byDrops) return 'drops';
    return MIX_WEIGHT[D.metrics[id].gate[0]] || 'data';
  }

  // The share a ship gets. K/D's gate counts matches, which a match with two ships would count twice, so
  // it splits by time. Switch rate splits by switches: by firing time an Empty Scout with no switches at all
  // could lead a player who switches only on the Xares. Butterfingers splits by drops, so the line names
  // where they dropped, not where they flew; a player with no drops splits by cycles carrying a mine.
  function mixWeight(id, agg, res, byDrops) {
    if (id === 'pvp_kd') return agg.mins;
    if (id === 'sw_rate') return agg.swn;
    if (byDrops) return agg.din;
    return res.g;
  }

  function shareTxt(x) {
    if (x > 0 && x < 0.005) return '<1%';
    return pct(x, 0);
  }

  function pairName(a, q) {
    return `${weaponName(a)} + ${weaponName(q)}`;
  }

  // A match row's top pair and its count: the most-used round trip on the boards that time them, else the
  // most-switched pair.
  const TRIP_BOARDS = new Set(['sw_1tick', 'sw_median', 'quick_draw']);

  function rowPair(id, r) {
    return TRIP_BOARDS.has(id) ? [r.ra, r.rb, r.rc] : [r.pa, r.pb, r.pc];
  }

  // One agg per ship the player flew in the range, each the same pool the Ship filter would rank.
  function playerShipAggs(p, ctx) {
    const aggs = new Map();
    const ctxs = new Map();
    for (const r of D.rowsByPlayer[p]) {
      if (!matchOk(ctx, r.m)) continue;
      const seen = new Set();
      for (const sr of D.shipRowsByKey.get(key(r.m, p)) || []) {
        if (seen.has(sr.s)) continue;
        seen.add(sr.s);
        if (!ctxs.has(sr.s)) {
          ctxs.set(sr.s, Object.assign({}, ctx, { ship: sr.s }));
          aggs.set(sr.s, newAgg());
        }
        addMatch(aggs.get(sr.s), ctxs.get(sr.s), r.m, p);
      }
    }
    return aggs;
  }

  function shipMix(id, p, ctx, shipAggs) {
    if (ctx.ship >= 0 || NO_SHIP_SPLIT.has(id)) return null;
    const aggs = shipAggs || playerShipAggs(p, ctx);
    const byDrops = id === 'drops_per_k' && [...aggs.values()].some((agg) => agg.din > 0);
    const out = [];
    aggs.forEach((agg, s) => {
      const res = metricOf(id, agg, ctx);
      const w = mixWeight(id, agg, res, byDrops);
      if (w > 0) out.push({ s, v: res.v, g: res.g, w });
    });
    const total = out.reduce((t, x) => t + x.w, 0);
    out.forEach((x) => { x.share = x.w / total; });
    out.byDrops = byDrops;
    return out.sort((a, b) => b.w - a.w || a.s - b.s);
  }

  // The pairs behind the figure, weighted by the board's own sample. On the switch boards the share is
  // each match's most-switched pair over all switches (FastHands.exe: most-used round trip over all round
  // trips), so the rest is "other". `values` adds each pair's own figure on a PAIR_EXACT board.
  function pairMix(id, p, ctx, values) {
    if (ctx.pair || !(PAIR_EXACT.has(id) || PAIR_SHARE_ONLY.has(id))) return null;
    const pairs = new Map();
    const at = (a, q) => {
      const k = `${a}|${q}`;
      if (!pairs.has(k)) pairs.set(k, { a, q, w: 0, wd: 0, ms: new Set() });
      return pairs.get(k);
    };
    let total = 0;
    let totalDrops = 0;
    const switchBoard = id === 'sw_rate' || id === 'sw_1tick';
    for (const r of D.rowsByPlayer[p]) {
      if (!matchOk(ctx, r.m)) continue;
      const k = key(r.m, p);
      if (switchBoard) {
        const n = id === 'sw_1tick' ? r.rtn : r.swn;
        if (r.noTiming || !n) continue;
        if (ctx.ship >= 0 && !(D.shipRowsByKey.get(k) || []).some((x) => x.s === ctx.ship)) continue;
        total += n;
        const [a, q, c] = rowPair(id, r);
        if (a != null && c > 0) at(a, q).w += c;
      } else if (CAREER_STREAK_UNITS.has(id)) {
        for (const s of D.streaksByKey.get(k) || []) {
          if (!streakOk(ctx, s) || (id === 'even_share' && s.pv == null)) continue;
          const x = at(s.a, s.q);
          x.w += 1;
          x.ms.add(r.m);
          total += 1;
        }
      } else {
        for (const rr of D.reloadByKey.get(k) || []) {
          if (rr.q < 0 || !reloadOk(ctx, rr)) continue;
          const w = id === 'drops_per_k' ? (rr.mine ? rr.cyc : 0) : rr.sb;
          if (!(w > 0)) continue;
          const x = at(rr.a, rr.q);
          x.w += w;
          x.ms.add(r.m);
          total += w;
          if (id === 'drops_per_k') { x.wd += rr.din; totalDrops += rr.din; }
        }
      }
    }
    if (!(total > 0)) return null;
    const byDrops = totalDrops > 0;
    if (byDrops) {
      pairs.forEach((x) => { x.w = x.wd; });
      total = totalDrops;
    }
    const out = [...pairs.values()].filter((x) => x.w > 0);
    out.byDrops = byDrops;
    out.forEach((x) => {
      x.share = Math.min(1, x.w / total);
      if (values && PAIR_EXACT.has(id)) {
        const pctx = Object.assign({}, ctx, { pair: [x.a, x.q] });
        const agg = newAgg();
        x.ms.forEach((m) => addMatch(agg, pctx, m, p));
        const res = metricOf(id, agg, pctx);
        x.v = res.v;
        x.g = res.g;
      }
    });
    return out.sort((a, b) => b.w - a.w || a.a - b.a || a.q - b.q);
  }

  // Two ODF variants can share a display name; the stem tells them apart.
  function sharesName(s, list) {
    const name = shipName(s);
    return list.some((x) => x.s !== s && shipName(x.s) === name);
  }

  function shipTip(s, list) {
    return sharesName(s, list) ? `${shipName(s)} ${D.ships[s].stem}` : shipName(s);
  }

  function mixPartHtml(text) {
    return `<span class="pa-mix-part">${esc(text)}</span>`;
  }

  function mostlyWord(share, first) {
    if (share >= 0.5) return first ? 'Mostly' : 'mostly';
    return first ? 'Most often' : 'most often';
  }

  // Butterfingers leads with what was dropped: "18 MFF Mines, 9 Prox Mines · most often on the Xares FS".
  function mixLineHtml(id, p, ctx, shipAggs, agg) {
    const ships = shipMix(id, p, ctx, shipAggs);
    const pairs = pairMix(id, p, ctx, false);
    const items = id === 'drops_per_k' && agg ? dropItemsText(agg) || 'No drops' : '';
    const parts = [];
    const tips = [];
    if (items && agg.din) {
      tips.push('Each drop is named by its ammo cost: 200 is a Prox Mine; 100 is the ship\'s own 100-ammo item, '
        + 'else what its faction sells at 100 (MFF Mine on Hadean, MITS Mine or Solar Flare on ISDF, Seeker or Solar Flare on Scion).');
    }
    if (ships && ships.length) {
      parts.push(`${mostlyWord(ships[0].share, !items)} on the ${shipName(ships[0].s)}`);
      tips.push(`${ships.slice(0, 3).map((x, i) => `${shareTxt(x.share)}${i ? '' : ` of their ${mixWord(id, ships)}`} on the `
        + `${shipTip(x.s, ships)}`).join(', ')}.`);
    }
    if (pairs && pairs.length) {
      parts.push(`${mostlyWord(pairs[0].share, !items && !parts.length)} ${pairName(pairs[0].a, pairs[0].q)}`);
      let lead = '';
      if (id === 'sw_rate') lead = 'Counting each match\'s most-switched pair: ';
      else if (id === 'sw_1tick') lead = 'Counting each match\'s most-used round trip: ';
      tips.push(`${lead}${pairs.slice(0, 3).map((x, i) => `${shareTxt(x.share)}${i ? '' : ` of their ${mixWord(id, pairs)}`} with `
        + `${pairName(x.a, x.q)}`).join(', ')}.`);
    }
    if (!parts.length && !items) return '';
    tips.push('Click for the full breakdown.');
    const where = parts.map(mixPartHtml).join(', ');
    return `<div class="pa-board-mix" title="${esc(tips.join(' '))}">`
      + `${items ? `${mixPartHtml(items)}${where ? ' · ' : ''}` : ''}${where}</div>`;
  }

  // The player's figure against everyone ranked under the same ship or pair.
  function mixStanding(id, p, c) {
    const full = careerBoard(id, leaderAggs(c), c);
    return { typical: median(full.map((r) => r.v)), rank: full.findIndex((r) => r.p === p), ranked: full.length };
  }

  function mixRowHtml(id, x, st, attr, labelHtml, tip) {
    const gate = D.metrics[id].gate;
    const ranked = st.rank >= 0;
    const mine = ranked ? esc(fmtValue(id, x.v))
      : `<span class="pa-muted" title="${esc(`Not ranked here: under ${GATE_LABELS[gate[0]](gate[1])}`)}">${esc(fmtValue(id, x.v))}</span>`;
    return `<tr role="button" tabindex="0" ${attr} title="${esc(tip)}">
      <td>${labelHtml}</td><td class="pa-num">${esc(shareTxt(x.share))}</td><td class="pa-num">${mine}</td>
      <td class="pa-num">${st.ranked ? esc(fmtValue(id, st.typical)) : '—'}</td>
      <td class="pa-num">${ranked ? `#${st.rank + 1} of ${st.ranked}` : '<span class="pa-muted">Not ranked</span>'}</td></tr>`;
  }

  function otherRowHtml(label, share, cols) {
    if (!(share >= 0.005)) return '';
    return `<tr class="pa-mix-other"><td>${esc(label)}</td><td class="pa-num">${esc(shareTxt(share))}</td>`
      + `${cols > 2 ? `<td colspan="${cols - 2}"></td>` : ''}</tr>`;
  }

  function mixTableHtml(title, note, head, body) {
    return `<h6 class="pa-mix-title">${esc(title)}</h6>
      <p class="small text-muted mb-1">${esc(note)}</p>
      <div class="table-responsive mb-3"><table class="table table-sm pa-table pa-mix-table">
        <thead><tr>${head.map((h, i) => `<th${i ? ' class="pa-num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody></table></div>`;
  }

  function mixTablesHtml(L) {
    const { id, p, ctx } = L;
    const head = ['', 'Share', 'Theirs', 'Typical', 'Rank'];
    let html = '';
    const ships = shipMix(id, p, ctx);
    if (ships && ships.length) {
      const shown = ships.slice(0, MIX_ROWS);
      const rows = shown.map((x) => {
        const label = `${esc(shipName(x.s))}${sharesName(x.s, ships) ? ` <small class="vt-mono pa-muted">${esc(D.ships[x.s].stem)}</small>` : ''}`;
        return mixRowHtml(id, x, mixStanding(id, p, Object.assign({}, ctx, { ship: x.s })),
          `data-mix-ship="${esc(D.ships[x.s].stem)}"`, label, `Rank every board on the ${shipTip(x.s, ships)}`);
      }).join('');
      const rest = ships.length - shown.length;
      const other = otherRowHtml(`Other ships (${rest})`, 1 - shown.reduce((t, x) => t + x.share, 0), head.length);
      html += mixTableHtml('On each ship', `Share of their ${mixWord(id, ships)}. Typical and Rank count everyone ranked on that `
        + 'ship. Click a ship to rank every board on it.', ['Ship'].concat(head.slice(1)), rows + (rest > 0 ? other : ''));
    }
    const pairs = pairMix(id, p, ctx, true);
    if (pairs && pairs.length) {
      const shown = pairs.slice(0, MIX_ROWS);
      const left = 1 - shown.reduce((t, x) => t + x.share, 0);
      const switchBoard = id === 'sw_rate' || id === 'sw_1tick';
      if (PAIR_EXACT.has(id)) {
        const rows = shown.map((x) => mixRowHtml(id, x, mixStanding(id, p, Object.assign({}, ctx, { pair: [x.a, x.q] })),
          `data-mix-pair="${esc(pairKey(x))}"`, esc(pairName(x.a, x.q)),
          `Rank the rhythm and reload boards on ${pairName(x.a, x.q)}`)).join('');
        html += mixTableHtml('On each weapon pair', `Share of their ${mixWord(id, pairs)}. Click a pair to rank the rhythm and `
          + 'reload boards on it.', ['Pair'].concat(head.slice(1)),
          rows + (pairs.length > shown.length ? otherRowHtml(`Other pairs (${pairs.length - shown.length})`, left, head.length) : ''));
      } else {
        const rows = shown.map((x) => `<tr><td>${esc(pairName(x.a, x.q))}</td><td class="pa-num">${esc(shareTxt(x.share))}</td></tr>`)
          .join('');
        const trips = id === 'sw_1tick';
        const note = `Share of their ${trips ? 'round trips, counting each match\'s most-used round trip' : 'switches, '
          + 'counting each match\'s most-switched pair'} only. The weapon-pair filter does not reach this board, so a pair `
          + 'has no figure of its own.';
        let otherLabel = `Other pairs (${pairs.length - shown.length})`;
        if (switchBoard) otherLabel = trips ? 'Other round trips' : 'Other switches';
        html += mixTableHtml('On each weapon pair', note, ['Pair', 'Share'],
          rows + (switchBoard || pairs.length > shown.length ? otherRowHtml(otherLabel, left, 2) : ''));
      }
    }
    return html;
  }

  // A ship or pair picked from the breakdown re-ranks every board on it.
  function applyMix(k, value) {
    const id = careerList.id;
    state[k] = value;
    careerList = null;
    state.career = '';
    state.drill = '';
    filtersChanged();
    const panel = document.getElementById('pa-drill');
    if (panel.classList.contains('show')) {
      panel.addEventListener('hidden.bs.offcanvas', () => flashBoard(id), { once: true });
      bootstrap.Offcanvas.getInstance(panel).hide();
    } else {
      flashBoard(id);
    }
  }

  function fmtLift(id, x) {
    const fmt = (METRIC_COPY[id] || {}).fmt;
    const a = Math.abs(fmt === 'pct' ? x * 100 : x);
    const digits = fmt === 'num2' ? 2 : (a >= 100 ? 0 : (a >= 1 ? 1 : 2));
    const num = a.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return `${x >= 0 ? '+' : '−'}${num}${fmt === 'pct' ? ' pts' : ''}`;
  }

  function liftHtml(id, x) {
    const fmt = (METRIC_COPY[id] || {}).fmt;
    if (Math.abs(fmt === 'pct' ? x * 100 : x) < 0.005) return '<span class="pa-muted">±0</span>';
    return `<span class="${x >= 0 ? 'pa-up' : 'pa-down'}">${esc(fmtLift(id, x))}</span>`;
  }

  function sortUnits(id, units, sort) {
    const dir = D.metrics[id].dir || 1;
    const ts = (u) => D.matches[u.m].ts;
    let cmp;
    if (sort === 'lift') cmp = (a, b) => b.lift - a.lift || b.g - a.g;
    else if (sort === 'recent') cmp = (a, b) => ts(b) - ts(a) || (b.t0 || 0) - (a.t0 || 0);
    else if (id === 'even_share') cmp = (a, b) => b.v - a.v || a.streak.pv - b.streak.pv;
    else cmp = (a, b) => Number(b.ok) - Number(a.ok) || dir * (b.v - a.v) || b.g - a.g;
    return units.slice().sort(cmp);
  }

  function unitDetail(id, u) {
    const s = u.streak;
    if (s) return id === 'even_share' ? `p ${fmtP(s.pv)} · ${s.n} cycles` : `${s.n} cycles · ${Math.round(s.per)} ms a cycle`;
    const a = u.agg;
    const of = (x, y, what) => `${x.toLocaleString()} of ${y.toLocaleString()} ${what}`;
    switch (id) {
      case 'sw_rate': return `${a.swn.toLocaleString()} switches · ${(a.swa / 60).toFixed(1)} firing min`;
      case 'sw_1tick': return of(a.rt1, a.rtn, 'round trips');
      case 'dot_share': return of(a.dot, a.sb, 'switch-backs');
      case 'seam_share': return of(a.seam, a.sb, 'switch-backs');
      case 'margin': return `${a.sb.toLocaleString()} switch-backs`;
      case 'drops_per_k': return `${a.din ? dropItemsText(a) : 'No drops'} · ${a.cycm.toLocaleString()} cycles carrying a mine`;
      case 'pvp_hit': return of(a.ph, a.sf, 'shots');
      case 'accuracy': return of(a.shPost, a.sfPost, 'shots');
      case 'pvp_kd': return `${a.pk} kill${a.pk === 1 ? '' : 's'} · ${a.pd} death${a.pd === 1 ? '' : 's'}`;
      case 'dpm': return `${Math.round(a.dmg).toLocaleString()} damage · ${a.mins.toFixed(1)} min`;
      case 'pvp_dpm': return `${Math.round(a.pdmg).toLocaleString()} damage · ${a.mins.toFixed(1)} min`;
      default: return '';
    }
  }

  function careerKey() {
    return `${careerList.id}~${playerToken(careerList.p)}`;
  }

  function openCareerFromUrl() {
    const [id, token] = state.career.split('~');
    const p = D.playerByToken.get(token);
    if (!CAREER_BOARDS.includes(id) || p == null) {
      state.career = '';
      writeUrl();
      return;
    }
    const pending = state.drill;
    openCareerList(id, p);
    if (pending) {
      state.drill = pending;
      openDrillFromUrl(true);
    }
  }

  function openCareerList(id, p) {
    const ctx = filterCtx({ useWin: true });
    const full = careerBoard(id, leaderAggs(ctx), ctx);
    const typical = median(full.map((r) => r.v));
    const units = careerUnits(id, p, ctx);
    const lifts = addLifts(id, units, typical);
    careerList = {
      id, p, ctx, typical, units, lifts,
      rank: full.findIndex((r) => r.p === p), ranked: full.length,
      own: careerValue(id, p, ctx),
      sort: lifts ? 'lift' : 'best', shown: CAREER_PAGE, scroll: 0,
    };
    drill = null;
    state.career = careerKey();
    state.drill = '';
    writeUrl();
    renderCareerList();
    bootstrap.Offcanvas.getOrCreateInstance(document.getElementById('pa-drill')).show();
  }

  function careerSummaryHtml(L) {
    const { id, p, typical, units } = L;
    const gate = D.metrics[id].gate;
    const word = careerUnitWord(id, 2);
    const lines = [];
    if (typical != null) {
      const gap = typicalGap(id, L.own.v, typical);
      lines.push(`Typical player: ${fmtValue(id, typical)}${gap ? ` · ${gap} vs typical` : ''}.`);
    }
    const beat = beatTypical(id, p, L.ctx, typical);
    if (beat) {
      lines.push(`Beat the typical player in ${beat.k} of ${beat.n} ${beatScope(id, beat.n)}.`);
    }
    if (L.lifts) {
      const total = units.reduce((s, u) => s + u.lift, 0);
      const top = sortUnits(id, units, 'lift').slice(0, 10);
      const topSum = top.reduce((s, u) => s + u.lift, 0);
      if (total > 0 && units.length > top.length) {
        lines.push(`The ${top.length} biggest lifts add ${fmtLift(id, topSum)} of the ${fmtLift(id, total)} lead over the typical player.`);
      } else if (total > 0) {
        lines.push(`These ${units.length} ${careerUnitWord(id, units.length)} add up to the ${fmtLift(id, total)} lead over the typical player.`);
      }
      lines.push(liftNote(id));
    } else {
      lines.push(`${METRIC_COPY[id].label} is a middle value, not a total, so no single ${careerUnitWord(id, 1)} has a lift.`);
    }
    const rank = L.rank >= 0 ? `#${L.rank + 1} of ${L.ranked} ranked` : `Not ranked: needs ${GATE_LABELS[gate[0]](gate[1])}`;
    return `<div class="pa-cl-head mb-3">
        <div class="d-flex flex-wrap align-items-baseline gap-2 mb-1">
          <span class="pa-cl-value">${esc(fmtValue(id, L.own.v))}</span>
          <span class="small text-muted">${esc(rank)} · ${units.length.toLocaleString()} ${esc(word)} in the range</span>
        </div>
        ${lines.map((t) => `<p class="small text-muted mb-1">${esc(t)}</p>`).join('')}
      </div>
      ${mixTablesHtml(L)}`;
  }

  function careerRowHtml(L, u) {
    const m = D.matches[u.m];
    const when = `${dateStr(m.ts)} · ${m.map}${m.hz !== 20 ? ` · ${m.hz} Hz` : ''}`;
    const where = [
      u.ship != null ? shipName(u.ship) : '',
      u.a != null ? `${weaponName(u.a)} + ${weaponName(u.q)}` : '',
      u.streak ? `at ${clockStr((u.t0 - m.tick0) / m.hz)}` : '',
    ].filter(Boolean).join(' · ');
    const value = L.id === 'even_share' ? (u.v ? 'Even' : 'Not even') : fmtValue(L.id, u.v);
    const gateTxt = matchGateText(L.id);
    const thin = u.ok || !gateTxt ? ''
      : ` title="${esc(`Small sample: under ${gateTxt} in this match. It still counts toward the career figure.`)}"`;
    return `<div class="pa-cl-row${u.ok ? '' : ' pa-cl-row--thin'}" role="button" tabindex="0" data-cl-m="${u.m}"`
      + `${u.t0 != null ? ` data-cl-t0="${u.t0}"` : ''}${thin}>
        <div class="min-w-0"><div class="pa-cl-when">${esc(when)}</div><div class="pa-board-meta">${esc(where)}</div></div>
        <div class="pa-board-value">${esc(value)}<small>${esc(unitDetail(L.id, u))}</small></div>
        ${L.lifts ? `<div class="pa-cl-lift">${liftHtml(L.id, u.lift)}</div>` : ''}
      </div>`;
  }

  function renderCareerRows() {
    const L = careerList;
    const host = document.getElementById('pa-cl-rows');
    if (!L || !host) return;
    const sorted = sortUnits(L.id, L.units, L.sort);
    const left = sorted.length - L.shown;
    host.classList.toggle('pa-cl-rows--lift', L.lifts);
    host.innerHTML = sorted.length
      ? sorted.slice(0, L.shown).map((u) => careerRowHtml(L, u)).join('')
        + (left > 0 ? `<button type="button" class="btn btn-sm btn-outline-secondary w-100 mt-2" data-career-more>
            Show ${Math.min(CAREER_PAGE, left)} more (${left.toLocaleString()} left)</button>` : '')
      : `<p class="small text-muted mb-0">No ${careerUnitWord(L.id, 2)} in the range.</p>`;
  }

  function renderCareerList() {
    const L = careerList;
    const t = LEADER_TITLES[L.id];
    document.getElementById('pa-drill-title').textContent = `${playerName(L.p)} · ${t.title}`;
    const sorts = (L.lifts ? [['lift', 'Lift']] : []).concat([['best', 'Best'], ['recent', 'Recent']]);
    const body = document.getElementById('pa-drill-body');
    body.innerHTML = `${careerSummaryHtml(L)}
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <div class="btn-group btn-group-sm" role="group" aria-label="Sort">${sorts.map(([k, label]) => `<button type="button"
          class="btn btn-outline-secondary${L.sort === k ? ' active' : ''}" data-career-sort="${k}">${label}</button>`).join('')}</div>
        <button type="button" class="btn btn-sm btn-outline-secondary ms-auto" data-career-history>
          <i class="bi bi-graph-up me-1"></i>Open on History</button>
      </div>
      <div id="pa-cl-rows"></div>`;
    renderCareerRows();
    body.scrollTop = 0;
  }

  function careerBack() {
    if (!careerList) return;
    drill = null;
    state.drill = '';
    writeUrl();
    renderCareerList();
    document.getElementById('pa-drill-body').scrollTop = careerList.scroll;
  }

  function careerToHistory() {
    const { id, p } = careerList;
    careerList = null;
    state.career = '';
    state.drill = '';
    state.metric = id;
    if (!state.players.includes(p)) state.players.push(p);
    state.focus = playerToken(p);
    bootstrap.Offcanvas.getInstance(document.getElementById('pa-drill'))?.hide();
    filtersChanged();
    showTab('history');
  }

  async function loadLanes(m, p) {
    const id = D.matches[m].id;
    const host = document.getElementById('pa-lane-host');
    let data = laneCache.get(id);
    if (data === undefined) {
      try {
        const res = await fetch(MATCH_URL(id));
        data = res.ok ? await res.json() : null;
      } catch (_e) {
        data = null;
      }
      laneCache.set(id, data);
    }
    if (!drill || drill.m !== m || drill.p !== p) return;
    const lanes = data && data.players ? data.players[String(p)] : null;
    if (!lanes || !lanes.length) {
      host.innerHTML = '<p class="small text-muted">No timing lanes were kept for this match (lanes cover streaks and slow-weapon switch-backs).</p>';
      return;
    }
    const match = D.matches[m];
    let pick = 0;
    if (drill.t0 != null) {
      const i = lanes.findIndex((ln) => drill.t0 >= ln.t0 && drill.t0 <= ln.t0 + ln.len);
      if (i >= 0) pick = i;
    }
    const opt = lanes.map((ln, i) => `<option value="${i}"${i === pick ? ' selected' : ''}>${esc(weaponName(ln.a))} on ${esc(shipName(ln.s))} · `
      + `${clockStr((ln.t0 - match.tick0) / match.hz)} (${Math.round(ln.len / match.hz)} s)</option>`).join('');
    host.innerHTML = `${lanes.length > 1 ? `<select class="form-select form-select-sm mb-2" id="pa-lane-select">${opt}</select>` : ''}
      <div class="pa-lane-wrap"><canvas class="pa-lane-canvas" id="pa-lane-canvas"></canvas></div>
      <a class="small" id="pa-lane-raw" target="_blank" rel="noopener"><i class="bi bi-diagram-2 me-1"></i>This window's shots in the raw event browser</a>`;
    const draw = (i) => {
      drawLane(document.getElementById('pa-lane-canvas'), lanes[i], match, drill.t0);
      document.getElementById('pa-lane-raw').href = rawHref(m, p, [lanes[i].t0, lanes[i].t0 + lanes[i].len]);
    };
    draw(pick);
    drill.lanes = lanes;
    drill.lane = pick;
    const selEl = document.getElementById('pa-lane-select');
    if (selEl) selEl.addEventListener('change', () => { drill.lane = Number(selEl.value); draw(drill.lane); });
  }

  function drawLane(canvas, lane, match, focusT0) {
    const tc = themeColors();
    const hz = match.hz;
    const ppt = Math.max(2, Math.min(160 / hz, 16000 / Math.max(1, lane.len)));
    const padL = 12;
    const W = Math.ceil(lane.len * ppt) + padL * 2;
    const H = 150;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const yA = 46;
    const yP = 86;
    const yD = 112;
    const yAxis = 132;
    const X = (dt) => padL + dt * ppt;
    const shots = lane.shots ? lane.shots.split(';').map((x) => x.split(',').map(Number)) : [];
    const partnerColors = [tc.info, tc.accent, tc.success, tc.danger];
    const partnerIdx = new Map();
    c.strokeStyle = alpha(tc.border, 0.8);
    c.lineWidth = 1;
    [yA, yP, yD].forEach((y) => { c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padL, y); c.stroke(); });
    c.fillStyle = tc.textMuted;
    c.font = '10px Geist, sans-serif';
    c.textAlign = 'center';
    const stepS = lane.len / hz > 60 ? 5 : 1;
    for (let t = Math.ceil(lane.t0 / (hz * stepS)) * hz * stepS; t <= lane.t0 + lane.len; t += hz * stepS) {
      const x = X(t - lane.t0);
      c.fillRect(x, yAxis - 4, 1, 4);
      c.fillText(clockStr((t - match.tick0) / hz), x, yAxis + 10);
    }
    shots.forEach(([dt, wi]) => {
      if (wi === lane.a) {
        c.strokeStyle = alpha(tc.textMuted, 0.9);
        const rx = X(dt + lane.R);
        c.beginPath(); c.moveTo(rx, yA - 10); c.lineTo(rx, yA + 10); c.stroke();
      }
    });
    shots.forEach(([dt, wi]) => {
      if (wi === lane.a) {
        c.fillStyle = tc.primary;
        c.beginPath(); c.arc(X(dt), yA, 4.5, 0, Math.PI * 2); c.fill();
      } else {
        if (!partnerIdx.has(wi)) partnerIdx.set(wi, partnerIdx.size);
        c.fillStyle = partnerColors[partnerIdx.get(wi) % partnerColors.length];
        c.beginPath(); c.arc(X(dt), yP, 3, 0, Math.PI * 2); c.fill();
      }
    });
    c.fillStyle = tc.warning;
    (lane.drops || []).forEach(([dt]) => {
      const x = X(dt);
      c.beginPath(); c.moveTo(x, yD - 5); c.lineTo(x + 5, yD + 4); c.lineTo(x - 5, yD + 4); c.closePath(); c.fill();
    });
    c.fillStyle = tc.text;
    c.font = '9px Geist Mono, monospace';
    const ms = (ticks) => Math.round(ticks * 1000 / hz);
    (lane.sb || []).forEach(([dt, mg, dd]) => {
      c.fillText(`${ms(mg)}/${ms(dd)}`, X(dt), yA - 14);
    });
    const at = (dt) => clockFine((lane.t0 + dt - match.tick0) / hz);
    const marks = [];
    shots.forEach(([dt, wi]) => {
      marks.push({ x: X(dt), y: wi === lane.a ? yA : yP, rx: 6, ry: 8, title: `${weaponName(wi)} · ${at(dt)}` });
    });
    (lane.drops || []).forEach(([dt, , , item]) => {
      marks.push({ x: X(dt), y: yD, rx: 7, ry: 8, title: `${item ? `${item} dropped` : 'Silent ammo drop'} · ${at(dt)}` });
    });
    (lane.sb || []).forEach(([dt, mg, dd]) => {
      marks.push({
        x: X(dt), y: yA - 18, rx: 14, ry: 6, title: `Switch-back · ${at(dt)}`,
        lines: [`${ms(mg)} ms after ready, ${ms(dd)} ms of fire lost`],
      });
    });
    canvasTip(canvas, (px, py) => {
      let best = null;
      marks.forEach((mk) => {
        const dx = Math.abs(px - mk.x);
        if (dx <= mk.rx && Math.abs(py - mk.y) <= mk.ry && (!best || dx < best.dx)) best = { dx, mk };
      });
      return best ? best.mk : null;
    });
    c.textAlign = 'left';
    c.fillStyle = tc.textMuted;
    c.font = '10px Geist, sans-serif';
    c.fillText(weaponName(lane.a), padL, yA - 26);
    const names = [...partnerIdx.keys()].map((wi) => weaponName(wi)).join(', ');
    c.fillText(names || 'other weapons', padL, yP - 9);
    const wrap = canvas.parentElement;
    if (wrap && focusT0 != null && focusT0 >= lane.t0 && focusT0 <= lane.t0 + lane.len) {
      wrap.scrollLeft = Math.max(0, X(focusT0 - lane.t0) - 40);
    }
  }

  // ---------------------------------------------------------------------
  // Shared controls
  // ---------------------------------------------------------------------

  function fillMetricSelects() {
    const groups = {};
    D.metricOrder.forEach((id) => {
      const g = D.metrics[id].group;
      (groups[g] = groups[g] || []).push(id);
    });
    let html = '';
    Object.keys(groups).forEach((g) => {
      html += `<optgroup label="${esc(GROUP_LABELS[g] || g)}">`;
      groups[g].forEach((id) => { html += `<option value="${id}">${esc(METRIC_COPY[id].label)}</option>`; });
      html += '</optgroup>';
    });
    document.querySelectorAll('.pa-metric-select').forEach((sel) => {
      sel.innerHTML = html;
      sel.value = state.metric;
    });
  }

  // ---------------------------------------------------------------------
  // Pickers
  // ---------------------------------------------------------------------

  // The players modal edits a copy, committed when it closes.
  let pickPlayers = null;
  const PICK_CHIPS_MAX = 15;
  const PAIR_MIN_SB = 50;
  const SHIP_MIN_MINUTES = 5;
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

  function searchTerm(id) {
    return (document.getElementById(id).value || '').trim().toLowerCase();
  }

  // Every word of the search has to appear, in any order.
  function matchesTerm(hay, term) {
    const h = hay.toLowerCase();
    return !term || term.split(/\s+/).every((w) => h.includes(w));
  }

  function playersLabel(list) {
    const n = list.length;
    if (!n) return 'Pick players';
    if (isAll(list)) return `All players (${n})`;
    if (n > 3) return `${n} players`;
    return list.map(playerName).join(', ');
  }

  function pairKey(u) {
    return `${D.weapons[u.a].stem}~${D.weapons[u.q].stem}`;
  }

  function pairLabel(pair) {
    const [a, q] = pair.split('~');
    return `${weaponName(D.weaponByStem.get(a))} + ${weaponName(D.weaponByStem.get(q))}`;
  }

  function renderPickerButtons() {
    document.getElementById('pa-players-value').textContent = playersLabel(state.players);
    document.getElementById('pa-ship-value').textContent = state.ship ? shipName(D.shipByStem.get(state.ship)) : 'All ships';
    document.getElementById('pa-pair-value').textContent = state.pair ? pairLabel(state.pair) : 'All weapon pairs';
    document.getElementById('pa-ship-clear').classList.toggle('d-none', !state.ship);
    document.getElementById('pa-pair-clear').classList.toggle('d-none', !state.pair);
    document.getElementById('pa-ship-modal-clear').disabled = !state.ship;
    document.getElementById('pa-pair-modal-clear').disabled = !state.pair;
  }

  function pickGroup(label) {
    return `<div class="pa-pick-group">${esc(label)}</div>`;
  }

  function pickSection(label) {
    return `<div class="pa-pick-section">${esc(label)}</div>`;
  }

  // `nameHtml` is already escaped.
  function pickItem(attr, value, nameHtml, meta, active) {
    return `<button type="button" class="pa-pick-item${active ? ' active' : ''}" role="option" aria-selected="${active}"`
      + ` ${attr}="${esc(value)}"><span class="pa-pick-name">${nameHtml}</span>`
      + `${meta ? `<span class="pa-pick-meta">${esc(meta)}</span>` : ''}</button>`;
  }

  function renderPickedSummary() {
    const list = pickPlayers || state.players;
    const total = D.players.length;
    document.getElementById('pa-player-limit').textContent = `${list.length} of ${total} picked`;
    document.getElementById('pa-player-all').disabled = isAll(list);
    document.getElementById('pa-player-clear').disabled = !list.length;
    let chips = '';
    if (list.length > PICK_CHIPS_MAX) {
      chips = `<span class="pa-player-chip"><i class="bi bi-people"></i>${esc(playersLabel(list))}</span>`;
    } else {
      chips = list.map((p, slot) => `<span class="pa-player-chip"><span class="pa-swatch" style="background:${playerColor(slot)}"></span>${esc(playerName(p))}
        <button type="button" data-unpick="${p}" aria-label="Remove ${esc(playerName(p))}"><i class="bi bi-x-lg"></i></button></span>`).join('');
    }
    document.getElementById('pa-player-picked').innerHTML = chips;
  }

  function renderPlayerGrid() {
    const list = pickPlayers || state.players;
    const term = searchTerm('pa-player-search');
    const sel = new Set(list);
    document.getElementById('pa-player-list').innerHTML = D.players.slice().sort((a, b) => byName(a.name, b.name))
      .filter((p) => matchesTerm(`${p.name} ${p.slug || ''}`, term))
      .map((p) => `<div class="form-check pa-player-opt">
          <input class="form-check-input" type="checkbox" id="pa-pl-${p.i}" data-player="${p.i}"${sel.has(p.i) ? ' checked' : ''}>
          <label class="form-check-label" for="pa-pl-${p.i}">${esc(p.name)} <span class="pa-muted">${p.n}</span></label>
        </div>`).join('') || '<p class="small text-muted mb-0">No players match.</p>';
  }

  function setPickPlayers(list) {
    pickPlayers = list;
    renderPickedSummary();
    renderPlayerGrid();
  }

  function togglePickPlayer(p) {
    const i = pickPlayers.indexOf(p);
    if (i >= 0) pickPlayers.splice(i, 1);
    else pickPlayers.push(p);
    renderPickedSummary();
  }

  function shipOptions() {
    const mins = new Map();
    D.shipRows.forEach((r) => mins.set(r.s, (mins.get(r.s) || 0) + r.mins));
    const cur = state.ship ? D.shipByStem.get(state.ship) : null;
    if (cur != null && !mins.has(cur)) mins.set(cur, 0);
    return [...mins.entries()].filter(([si, v]) => v > SHIP_MIN_MINUTES || si === cur).map(([si, v]) => ({ si, mins: v }));
  }

  function renderShipPicker() {
    const term = searchTerm('pa-ship-search');
    const cur = state.ship ? D.shipByStem.get(state.ship) : null;
    const item = (o) => {
      const s = D.ships[o.si];
      return pickItem('data-ship', s.stem, esc(s.name), `${s.stem} · ${Math.round(o.mins).toLocaleString()} min`, o.si === cur);
    };
    const opts = shipOptions();
    let html = '';
    if (!term) {
      const c = opts.find((o) => o.si === cur);
      if (c) html += pickGroup('Current') + pickItem('data-ship', D.ships[cur].stem, esc(shipName(cur)), '', true);
      html += pickItem('data-ship', '', 'All ships', '', cur == null);
    }
    const groups = new Map();
    opts.forEach((o) => {
      const s = D.ships[o.si];
      const fac = FACTIONS[s.stem[0]] || '';
      if (!matchesTerm(`${s.name} ${s.stem} ${fac}`, term)) return;
      pushMap(groups, fac, o);
    });
    ['ISDF', 'Hadean', 'Scion', ''].forEach((fac) => {
      const list = groups.get(fac);
      if (!list) return;
      list.sort((a, b) => byName(D.ships[a.si].name, D.ships[b.si].name) || byName(D.ships[a.si].stem, D.ships[b.si].stem));
      html += pickGroup(fac || 'Other') + list.map(item).join('');
    });
    document.getElementById('pa-ship-list').innerHTML = html || '<p class="small text-muted mb-0">No ships match.</p>';
  }

  function pairOptions() {
    const out = [];
    D.pairUse.forEach((u) => { if (u.sb >= PAIR_MIN_SB || pairKey(u) === state.pair) out.push(u); });
    if (state.pair && !out.some((u) => pairKey(u) === state.pair)) {
      const [a, q] = state.pair.split('~').map((st) => D.weaponByStem.get(st));
      out.push({ a, q, sb: 0, ships: new Map() });
    }
    return out;
  }

  function pairItem(u, opts) {
    const o = opts || {};
    const top = o.ship != null ? o.ship : topKey(u.ships);
    const others = u.ships.size - (top != null && u.ships.has(top) ? 1 : 0);
    const meta = `${top != null ? `${shipName(top)}${others ? ` +${others} more` : ''} · ` : ''}`
      + `${(o.ship != null ? u.ships.get(o.ship) || 0 : u.sb).toLocaleString()} switch-backs`;
    const name = o.full ? esc(`${weaponName(u.a)} + ${weaponName(u.q)}`)
      : `<span class="pa-muted">+</span> ${esc(weaponName(u.q))}`;
    return pickItem('data-pair', pairKey(u), name, meta, pairKey(u) === state.pair);
  }

  function renderPairPicker() {
    const term = searchTerm('pa-pair-search');
    const shipSel = state.ship ? D.shipByStem.get(state.ship) : null;
    const all = pairOptions();
    const hay = (u) => `${weaponName(u.a)} ${weaponName(u.q)} ${D.weapons[u.a].stem} ${D.weapons[u.q].stem} `
      + [...u.ships.keys()].map(shipName).join(' ');
    const opts = term ? all.filter((u) => matchesTerm(hay(u), term)) : all;
    let html = '';
    if (!term) {
      const cur = all.find((u) => pairKey(u) === state.pair);
      if (cur) html += pickGroup('Current') + pairItem(cur, { full: true });
      html += pickItem('data-pair', '', 'All weapon pairs', '', !state.pair);
    }
    const sections = shipSel != null
      ? [[`On the ${shipPhrase(shipSel)}`, opts.filter((u) => u.ships.has(shipSel)), shipSel],
        [`Never used on the ${shipPhrase(shipSel)}`, opts.filter((u) => !u.ships.has(shipSel)), null]]
      : [[null, opts, null]];
    sections.forEach(([title, list, ship]) => {
      if (!list.length) return;
      if (title) html += pickSection(title);
      const byAnchor = new Map();
      list.forEach((u) => pushMap(byAnchor, u.a, u));
      [...byAnchor.keys()].sort((x, y) => byName(weaponName(x), weaponName(y))).forEach((a) => {
        const us = byAnchor.get(a).sort((x, y) => byName(weaponName(x.q), weaponName(y.q)));
        let s = ship;
        if (s == null) {
          const use = new Map();
          us.forEach((u) => u.ships.forEach((v, si) => use.set(si, (use.get(si) || 0) + v)));
          s = topKey(use);
        }
        const R = reloadMs(s, a);
        html += pickGroup(`${weaponName(a)}${R ? ` · reloads ${msTxt(R)}` : ''}`)
          + us.map((u) => pairItem(u, { ship })).join('');
      });
    });
    document.getElementById('pa-pair-list').innerHTML = html || '<p class="small text-muted mb-0">No weapon pairs match.</p>';
  }

  function wirePickList(modalId, searchId, listId, render) {
    const modal = document.getElementById(modalId);
    const search = document.getElementById(searchId);
    const list = document.getElementById(listId);
    modal.addEventListener('show.bs.modal', () => { search.value = ''; render(); });
    modal.addEventListener('shown.bs.modal', () => search.focus());
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      const first = list.querySelector('.pa-pick-item');
      if (!first) return;
      if (e.key === 'Enter') { e.preventDefault(); first.click(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); first.focus(); }
    });
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...list.querySelectorAll('.pa-pick-item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) search.focus();
      else items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
  }

  function pickAndClose(modalId, key, value) {
    bootstrap.Modal.getOrCreateInstance(document.getElementById(modalId)).hide();
    if (state[key] === value) return;
    state[key] = value;
    filtersChanged();
  }

  function renderChips() {
    const n = state.players.length;
    const link = (attr, text) => `<button type="button" class="btn btn-link btn-sm p-0 align-baseline" ${attr}>${text}</button>`;
    let players;
    if (!n) {
      players = [`<span class="small text-muted">No players picked.</span>${link('data-select-all', 'Select all')}${link('data-pick-players', 'Pick players')}`];
    } else if (n > CROWD) {
      const label = allSelected() ? `All ${D.players.length} players` : `${n} players`;
      players = [`<span class="pa-player-chip"><i class="bi bi-people"></i>${esc(label)}
        <button type="button" data-clear-players aria-label="Clear the players"><i class="bi bi-x-lg"></i></button></span>`];
    } else {
      players = state.players.map((p, slot) => `<span class="pa-player-chip"><span class="pa-swatch" style="background:${playerColor(slot)}"></span>${esc(playerName(p))}
        <button type="button" data-remove-player="${p}" aria-label="Remove ${esc(playerName(p))}"><i class="bi bi-x-lg"></i></button></span>`);
      if (n >= 2) players.push(link('data-clear-players', 'Clear'));
    }
    const filters = [];
    const chip = (label, k) => `<span class="pa-player-chip">${esc(label)}<button type="button" data-clear="${k}" aria-label="Clear ${esc(label)}"><i class="bi bi-x-lg"></i></button></span>`;
    if (state.ship) filters.push(chip(`Ship: ${shipName(D.shipByStem.get(state.ship))}`, 'ship'));
    if (state.pair) {
      const [a, q] = state.pair.split('~');
      filters.push(chip(`Pair: ${weaponName(D.weaponByStem.get(a))} + ${weaponName(D.weaponByStem.get(q))} (rhythm and reload)`, 'pair'));
    }
    if (state.from) filters.push(chip(`From ${state.from}`, 'from'));
    if (state.to) filters.push(chip(`To ${state.to}`, 'to'));
    if (state.split) filters.push(chip(`Split ${state.split}`, 'split'));
    const gap = pairShipGap();
    const notice = gap ? [`<span class="pa-notice-chip"><i class="bi bi-exclamation-circle"></i>The ${esc(shipPhrase(gap.ship))} `
      + 'never used this pair, so the rhythm and reload boards are empty.</span>'] : [];
    document.getElementById('pa-chips').innerHTML = players.concat(filters, notice).join('');
    let who = 'No players';
    if (allSelected()) who = 'All players';
    else if (n) who = `${n} player${n > 1 ? 's' : ''}`;
    document.getElementById('pa-filter-summary').textContent = [
      who, filters.length ? `${filters.length} filter${filters.length > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
  }

  function syncControls() {
    renderPickerButtons();
    document.getElementById('pa-from').value = state.from;
    document.getElementById('pa-to').value = state.to;
    document.getElementById('pa-split').value = state.split;
    document.querySelectorAll('.pa-metric-select').forEach((s) => { s.value = state.metric; });
    const seg = (hostId, attr, val) => document.querySelectorAll(`#${hostId} [data-${attr}]`).forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === val);
    });
    seg('pa-per', 'per', state.per);
    seg('pa-win', 'win', state.win);
    seg('pa-win-career', 'win', state.win);
    seg('pa-x', 'x', state.x);
    seg('pa-smooth', 'smooth', state.smooth);
    seg('pa-rsort', 'rsort', state.rsort);
    const rw = document.getElementById('pa-reload-weapon');
    if (rw) rw.value = state.rw;
    renderChips();
  }

  function activeTab() {
    return state.tab;
  }

  function renderTab(tab) {
    if (!dirty[tab]) return;
    dirty[tab] = false;
    switch (tab) {
      case 'moments': renderMoments(); break;
      case 'career': renderCareer(); break;
      case 'history': renderHistory(); break;
      case 'compare': renderCompare(); break;
      case 'reload': renderReload(); break;
      case 'rhythm': renderRhythm(); break;
      case 'players': renderPlayers(); break;
      default: break;
    }
  }

  function markDirty(tabs) {
    (tabs || Object.keys(dirty)).forEach((t) => { dirty[t] = true; });
  }

  function filtersChanged(tabs) {
    titlesCache = null;
    writeUrl();
    syncControls();
    markDirty(tabs);
    renderTab(activeTab());
  }

  function togglePlayer(p) {
    const i = state.players.indexOf(p);
    if (i >= 0) state.players.splice(i, 1);
    else state.players.push(p);
    if (focusPlayer() == null) state.focus = '';
    filtersChanged();
  }

  function setPlayers(list) {
    state.players = list;
    if (focusPlayer() == null) state.focus = '';
    filtersChanged();
  }

  function selectAllPlayers() {
    setPlayers(allPlayers());
  }

  function clearPlayers() {
    setPlayers([]);
  }

  function toggleFocus(p) {
    state.focus = focusPlayer() === p ? '' : playerToken(p);
    filtersChanged(['history', 'rhythm']);
  }

  function showTab(tab) {
    bootstrap.Tab.getOrCreateInstance(document.querySelector(`#pa-tabs [data-tab="${tab}"]`)).show();
  }

  function openPlayerPicker() {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('pa-players-modal')).show();
  }

  function flashBoard(id) {
    showTab(RECORD_BOARDS.includes(id) ? 'moments' : 'career');
    setTimeout(() => {
      const card = document.getElementById(`pa-board-${id}`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('pa-board--flash');
      setTimeout(() => card.classList.remove('pa-board--flash'), 1600);
    }, 150);
  }

  function wire() {
    new bootstrap.Tooltip(document.getElementById('pa-body'), {
      selector: '.pa-board-info', customClass: 'pa-rule-tip', placement: 'bottom',
    });
    const playersModal = document.getElementById('pa-players-modal');
    const playerSearch = document.getElementById('pa-player-search');
    playersModal.addEventListener('show.bs.modal', () => {
      playerSearch.value = '';
      setPickPlayers(state.players.slice());
    });
    playersModal.addEventListener('shown.bs.modal', () => playerSearch.focus());
    playersModal.addEventListener('hidden.bs.modal', () => {
      const next = pickPlayers;
      pickPlayers = null;
      if (next && next.join(',') !== state.players.join(',')) setPlayers(next);
    });
    playerSearch.addEventListener('input', renderPlayerGrid);
    playerSearch.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = document.querySelector('#pa-player-list [data-player]');
      if (first) { first.checked = !first.checked; togglePickPlayer(Number(first.dataset.player)); }
    });
    document.getElementById('pa-player-all').addEventListener('click', () => setPickPlayers(allPlayers()));
    document.getElementById('pa-player-clear').addEventListener('click', () => setPickPlayers([]));
    document.getElementById('pa-player-list').addEventListener('change', (e) => {
      const p = e.target.dataset.player;
      if (p != null) togglePickPlayer(Number(p));
    });
    document.getElementById('pa-player-picked').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-unpick]');
      if (!rm) return;
      pickPlayers = pickPlayers.filter((p) => p !== Number(rm.dataset.unpick));
      renderPickedSummary();
      renderPlayerGrid();
    });
    wirePickList('pa-ship-modal', 'pa-ship-search', 'pa-ship-list', renderShipPicker);
    wirePickList('pa-pair-modal', 'pa-pair-search', 'pa-pair-list', renderPairPicker);
    document.getElementById('pa-ship-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ship]');
      if (b) pickAndClose('pa-ship-modal', 'ship', b.dataset.ship);
    });
    document.getElementById('pa-pair-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pair]');
      if (b) pickAndClose('pa-pair-modal', 'pair', b.dataset.pair);
    });
    document.getElementById('pa-ship-modal-clear').addEventListener('click', () => pickAndClose('pa-ship-modal', 'ship', ''));
    document.getElementById('pa-pair-modal-clear').addEventListener('click', () => pickAndClose('pa-pair-modal', 'pair', ''));
    [['pa-ship-clear', 'ship'], ['pa-pair-clear', 'pair']].forEach(([elId, k]) => {
      document.getElementById(elId).addEventListener('click', () => { state[k] = ''; filtersChanged(); });
    });
    document.getElementById('pa-chips').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-player]');
      if (rm) { togglePlayer(Number(rm.dataset.removePlayer)); return; }
      const cl = e.target.closest('[data-clear]');
      if (cl) { state[cl.dataset.clear] = ''; filtersChanged(); }
    });
    [['pa-from', 'from'], ['pa-to', 'to'], ['pa-split', 'split']].forEach(([elId, k]) => {
      document.getElementById(elId).addEventListener('change', (e) => { state[k] = e.target.value || ''; filtersChanged(); });
    });
    document.getElementById('pa-reset').addEventListener('click', () => {
      ['ship', 'pair', 'from', 'to', 'split'].forEach((k) => { state[k] = ''; });
      filtersChanged();
    });
    document.querySelectorAll('.pa-metric-select').forEach((sel) => sel.addEventListener('change', () => {
      state.metric = sel.value;
      filtersChanged(['history', 'compare', 'players']);
    }));
    const seg = (hostId, attr, tabs) => document.getElementById(hostId).addEventListener('click', (e) => {
      const b = e.target.closest(`[data-${attr}]`);
      if (!b) return;
      state[attr] = b.dataset[attr];
      if (attr === 'win' || attr === 'per') titlesCache = null;
      filtersChanged(tabs);
    });
    seg('pa-per', 'per', ['moments', 'compare', 'players']);
    seg('pa-win', 'win', ['moments', 'career', 'compare', 'players']);
    seg('pa-win-career', 'win', ['moments', 'career', 'compare', 'players']);
    seg('pa-x', 'x', ['history']);
    seg('pa-smooth', 'smooth', ['history']);
    seg('pa-rsort', 'rsort', ['reload']);
    document.getElementById('pa-history-reset-zoom').addEventListener('click', () => {
      (tabCharts.history[0] && tabCharts.history[0].resetZoom) && tabCharts.history[0].resetZoom();
    });
    document.getElementById('pa-suggest-split').addEventListener('click', suggestSplit);
    document.getElementById('pa-reload-weapon').addEventListener('change', (e) => {
      state.rw = e.target.value;
      filtersChanged(['reload']);
    });
    document.getElementById('pa-ref-search').addEventListener('input', renderReference);

    document.querySelectorAll('#pa-tabs [data-bs-toggle="pill"]').forEach((btn) => {
      btn.addEventListener('shown.bs.tab', () => {
        state.tab = btn.dataset.tab;
        writeUrl();
        renderTab(state.tab);
      });
    });

    document.getElementById('pa-body').addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return;
      const go = e.target.closest('[data-goto-tab]');
      if (go) { e.preventDefault(); showTab(go.dataset.gotoTab); return; }
      if (e.target.closest('[data-pick-players]')) { openPlayerPicker(); return; }
      if (e.target.closest('[data-select-all]')) { selectAllPlayers(); return; }
      if (e.target.closest('[data-clear-players]')) { clearPlayers(); return; }
      if (e.target.closest('[data-unfocus]')) { toggleFocus(focusPlayer()); return; }
      const chip = e.target.closest('[data-board]');
      if (chip) { flashBoard(chip.dataset.board); return; }
      const rec = e.target.closest('[data-drill-m]');
      if (rec) {
        openDrill(Number(rec.dataset.drillM), Number(rec.dataset.drillP),
          { t0: rec.dataset.drillT0 != null ? Number(rec.dataset.drillT0) : null });
        return;
      }
      const car = e.target.closest('[data-career]');
      if (car) {
        openCareerList(car.dataset.career, Number(car.dataset.careerP));
        return;
      }
      const pick = e.target.closest('[data-pick-metric]');
      if (pick) {
        state.metric = pick.dataset.pickMetric;
        filtersChanged(['history', 'compare', 'players']);
        document.getElementById('pa-history-canvas').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const srt = e.target.closest('[data-sort]');
      if (srt) {
        const [col, dir] = (state.sort || DEFAULTS.sort).split(':');
        state.sort = `${srt.dataset.sort}:${col === srt.dataset.sort && dir === 'desc' ? 'asc' : 'desc'}`;
        filtersChanged(['players']);
        return;
      }
      const tp = e.target.closest('[data-toggle-player]');
      if (tp) togglePlayer(Number(tp.dataset.togglePlayer));
    });
    document.getElementById('pa-body').addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
    document.getElementById('pa-drill').addEventListener('hidden.bs.offcanvas', () => {
      careerList = null;
      state.drill = '';
      state.career = '';
      writeUrl();
    });
    const drillBody = document.getElementById('pa-drill-body');
    drillBody.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
    drillBody.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      if (e.target.closest('[data-career-back]')) { careerBack(); return; }
      if (careerList) {
        const srt = e.target.closest('[data-career-sort]');
        if (srt) {
          careerList.sort = srt.dataset.careerSort;
          careerList.shown = CAREER_PAGE;
          renderCareerList();
          return;
        }
        if (e.target.closest('[data-career-more]')) {
          careerList.shown += CAREER_PAGE;
          renderCareerRows();
          return;
        }
        if (e.target.closest('[data-career-history]')) { careerToHistory(); return; }
        const mixShip = e.target.closest('[data-mix-ship]');
        if (mixShip) { applyMix('ship', mixShip.dataset.mixShip); return; }
        const mixPair = e.target.closest('[data-mix-pair]');
        if (mixPair) { applyMix('pair', mixPair.dataset.mixPair); return; }
        const row = e.target.closest('[data-cl-m]');
        if (row) {
          careerList.scroll = drillBody.scrollTop;
          openDrill(Number(row.dataset.clM), careerList.p,
            { t0: row.dataset.clT0 != null ? Number(row.dataset.clT0) : null, back: true });
          return;
        }
      }
      const st = e.target.closest('[data-streak-t0]');
      if (!st || !drill) return;
      drill.t0 = Number(st.dataset.streakT0);
      state.drill = drillKey();
      writeUrl();
      document.querySelectorAll('#pa-drill-body .pa-streak').forEach((el) => el.classList.toggle('pa-streak--active', el === st));
      if (drill.lanes) {
        const i = drill.lanes.findIndex((ln) => drill.t0 >= ln.t0 && drill.t0 <= ln.t0 + ln.len);
        if (i >= 0) {
          drill.lane = i;
          const sel = document.getElementById('pa-lane-select');
          if (sel) sel.value = String(i);
          drawLane(document.getElementById('pa-lane-canvas'), drill.lanes[i], D.matches[drill.m], drill.t0);
          const ln = drill.lanes[i];
          document.getElementById('pa-lane-raw').href = rawHref(drill.m, drill.p, [ln.t0, ln.t0 + ln.len]);
        }
      }
    });

    new MutationObserver(() => {
      markDirty();
      renderTab(activeTab());
      if (drill && drill.lanes && document.getElementById('pa-lane-canvas')) {
        drawLane(document.getElementById('pa-lane-canvas'), drill.lanes[drill.lane], D.matches[drill.m], drill.t0);
      }
      renderChips();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.tab === 'reload') { dirty.reload = true; renderTab('reload'); }
      }, 200);
    });
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  async function boot() {
    const status = document.getElementById('pa-status');
    let ix;
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ix = await res.json();
    } catch (err) {
      status.textContent = `Could not load the analysis data (${err.message}).`;
      return;
    }
    D = decode(ix);
    readUrl();
    document.getElementById('pa-data-through').textContent = `${D.players.length} players · ${D.matches.length} matches · data through ${dateStr(D.dataThroughTs)}`;
    document.querySelectorAll('.pa-howto-body').forEach((el) => { el.innerHTML = howToHtml(); });
    fillMetricSelects();
    fillReloadSelect();
    syncControls();
    wire();
    status.classList.add('d-none');
    document.getElementById('pa-body').classList.remove('d-none');
    writeUrl();
    if (state.tab !== DEFAULTS.tab) showTab(state.tab);
    else renderTab(DEFAULTS.tab);
    if (state.career) openCareerFromUrl();
    else if (state.drill) openDrillFromUrl();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
