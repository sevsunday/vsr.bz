# Playstyle Analysis (`/_analysis/`)

A standalone page for looking at how players fire, switch weapons and time their reloads over time, with leader boards, history charts and side-by-side comparisons. It is reachable at `/_analysis/` but is not linked from the site's navigation, and it carries `noindex,nofollow`.

Everything here is **display-only and rating-inert**. Nothing on the page, and nothing in `_analysis/data/`, feeds a rating, a career aggregate or the match dashboard.

## Regenerating the data

Run it by hand after `scripts/process_stats.py`, the same way as `scripts/validate_elo.py`:

```
python scripts/build_analysis_data.py            # incremental (per-match cache)
python scripts/build_analysis_data.py --force    # ignore the cache
python scripts/build_analysis_data.py --only <match-id>   # one match, prints a summary, writes nothing
python _investigation/check_analysis.py          # gate (local, gitignored folder)
```

- **Inputs:**
  - the raw recordings `data/sessions/<submitter>/*.binpb.gz` (shot timing, ship and ammo per tick);
  - `data/processed/<id>.json` (tick rate, tick range, roster);
  - `data/processed/match_contributions.json`, `matches.json` and `player_slugs.json` (combat stats, names, links);
  - `data/odf.min.json` (every reload figure).
- **Cache:** per-match raw results live in `_analysis/.cache/`, which is gitignored. Each entry is keyed by the size and mtime of the processed and raw files plus `SCRIPT_VERSION`. Bump `SCRIPT_VERSION` whenever a raw-metric definition changes.
- **Outputs (committed):**
  - `_analysis/data/index.json`, the page data;
  - `_analysis/data/match/<id>.json`, one drill-down lane file per match, loaded on demand. Stale lane files are deleted.
- **Output rules:**
  - The build is deterministic; the gate builds twice and compares bytes.
  - It refuses to write past a 10 MB budget.
- **Coverage:** every player with a recorded match (no match minimum). Each board's own sample gate decides who is ranked, so a player with only a few matches can still top a board whose gate is a single match or streak.

## Forbidden consumers

`scripts/process_stats.py`, `scripts/elo.py`, `scripts/elo_commander.py`, `scripts/elo_1v1.py`, `scripts/elo_2v2.py`, `js/all-matches-aggregator.js` and every production page must never read `_analysis/` or import `scripts/build_analysis_data.py`. The dependency runs one way: the script imports `process_stats` (for decoding) and `identity_aliases`, never the reverse.

## Definitions

All timing is measured in recorded ticks and converted per match, because recordings run at 20, 30 or 60 Hz. Thresholds are therefore stated in seconds and rounded to whole ticks. Millisecond figures from a 30 or 60 Hz match are finer than a 20 Hz match can show, so record boards tag those rows with their tick rate. Quick Draw ranks a sub-50 ms median as 50 ms.

### Whose shots count

A shot is the player's only if the ship they were in at that tick could have fired it: the weapon is the ship's stock mount, or it fits one of the ship's hardpoints (category plus assault flag). Stock always counts because some ODFs mount a weapon on a hardpoint whose assault flag disagrees with the weapon's own (the Hedoux LS's Particle Blaster and Heavy Laser).

The first recordings (16 Apr 2026) credited a commander with his team's AI defences: an ISDF Turret's assault Minigun fired while he stood on foot, with his ammo never moving. Those shots fail the rule and are dropped before any metric is computed; the build reports them as `foreign` in `skipped`. The combat columns come from the processed contributions and are not affected by this rule.

### Slot-credited recordings

Three of those recordings (`2026-04-16T01-27-48`, `01-49-33`, `02-11-20`) credit every unit on a team slot to that slot's player, as shooter and as victim: hits on a commander's Scavengers, Recycler or Factory count as hits on him, and his Turrets' fire counts as his. The build detects this from the data. For each match it counts the hits on a player whose victim ODF is not the ship that player was in at that tick (`slot_hits` in the cache), and it sets the match's `slot` flag when that share passes `SLOT_CREDIT_SHARE` (5%, with at least `SLOT_MIN_HITS` hits). The three run at 61%, 61% and 81%. No other recording passes 0.2%.

Since `PIPELINE_VERSION` 64 the stats pipeline repairs these matches (`_repair_slot_credited_events()` in `scripts/process_stats.py`, sharing `scripts/odf_fit.py` with this build). A hit on a player that landed on one of his AI units goes back to the AI, and so does a shot or hit whose ordnance his ship cannot fire. Damage was never mis-credited, so ratings did not move. The combat figures this build reads from the processed data are therefore the repaired ones, and the page counts them for every player.

The timing figures come from the raw shot stream, which still credits a commander with his AI units' fire. The page therefore leaves the flagged matches' commanders out of the timing boards, the reload tab and the rhythm map, because a Turret's fire is not his own timing even when it fits a hardpoint. Their combat figures still count. Thugs keep their timing rows. The drill-down says which applies.

### Reload (from the ODF, never from the recording)

The reload `R` of a weapon on a ship is resolved from `data/odf.min.json` by a port of the `js/weapons-calc.js` rules that matter here:

- **Which weapon fired:** the weapon whose ordnance was fired and that fits a hardpoint of that ship (category plus assault flag; a deployed morph tank follows its `switchMask`). The stock mount wins, then the VSR copy.
- **`R`:** `shotDelay` rounded up to whole ticks. A group of `shotAlternate` hardpoints fires at `shotDelay / hardpoints`.
- **`Rmin = R − 1`:** the shortest legal gap. The engine carries leftover reload time into the next shot, so a single gap can land one tick short.
- **Volleys:**
  - same-tick shots of one weapon count once. A two-barrel gun that does not alternate (Minigun, Chain Gun, Shell Gun) records one shot per barrel, both on the same tick, so a trigger pull is one volley; the gate checks that these guns keep about 2 shots per volley;
  - barrels of one non-alternating group that report a tick apart count once;
  - a `salvoCount` burst counts once.
- **`InitialShotDelay`** is added to the switch-back margin.
- **No reload:** charge guns, TAG / salvo launchers, lock-on launchers, dispensers, utilities and zero-delay weapons get no `R` and a reason (`why` in the weapons table). Ordnance spawned by other ordnance (Splinter fragments, mine payloads) is skipped.

The **Weapon reference** table (Reload tab) lists every (ship, weapon) that fired, with `R`, `Rmin` and the observed floor (the shortest gap anyone recorded):

- Isolated short gaps are expected and only noted. Causes include recording bunching and the MDM Mortar's banked reload after a pause.
- A pair is **flagged**, and its switch-backs dropped, only when short gaps are systematic: at least 5 and more than 1% of gaps.
- A single player-match whose barrels drifted onto separate reloads (at least 3 short gaps and more than 5%) is dropped as **desync** without flagging the weapon.

### Switching

The recording has no weapon-switch event, so every switch is read from the shots. That is also what decides damage: players hold fire while they switch, so what counts is how soon each weapon fires again once it can.

- A **switch** is two consecutive firing ticks, at most 1 s apart and in the same ship, whose weapon groups share nothing. Leaving a ship and firing the pilot's Pulse (or the reverse) is not a switch; a ship change ends the run like a pause.
- Switch measures (The Juggler, Button Masher):
  - switches per active minute;
  - the most frequent pair.
- A **round trip** is three runs of single-group firing ticks in one chain: group `A`, then `B`, then `A` again, where `B` reloads no faster than `A` and both reloads are known. `B` may fire more than once. A chain breaks on a pause over 1 s, a ship change or a tick that fires two groups at once. Trips overlap: `A B A B A` is two trips, or three when the reloads are equal.
  - Switching out while holding fire costs nothing, so only the way back is timed: `wait = A's next shot − max(B's last shot, A's last shot + R_A − 1)`, at least one tick. It counts from `A`'s first possible tick (right after `B`'s last shot, or when `A`'s own reload ends if that is later) and includes the firing tick, so a perfect return is one tick either way.
  - A **one-tick return** is a `wait` of at most 50 ms, so 30 and 60 Hz recordings compare with 20 Hz ones.
  - Every `A → B → A` lands on exactly one board: `B` faster is a switch-back (below), `B` equal or slower is a round trip. Shell Gun → Dragon Blast → Shell Gun on a Xares SGS is a round trip; Dragon Blast → Shell Gun → Dragon Blast is a switch-back.
- Round-trip measures (FastHands.exe, Quick Draw, Median return delay):
  - the share of one-tick returns;
  - the median `wait`;
  - the most-used round trip.
- The out leg is checked, not ranked. The build prints how often `B` fired within one cycle of `A`; that is 99.3% of 64,576 trips today, which is what "switching out costs nothing" means in shots. It is a cycle, not one tick, because with instant hands a 20 Hz Minigun's switch out still lands 50 or 100 ms after its last shot, depending on where in its cycle the scroll came.
- The **multi-group share** (ticks that fire two groups at once) is a sanity column, not a ranking.

### Switch-backs (reload timing)

A **switch-back** is a slow weapon `A` firing, a faster weapon `B` firing in between, and `A` firing again within `R + max(1 s, R)`. For each switch-back:

- **margin** = time after `A` was ready (`gap − R − InitialShotDelay`);
- **dead time** = partner fire lost (`A`'s return minus when the last `B` volley's own reload would have ended);
- **on the dot**: margin ≤ 50 ms;
- **seamless**: dead time ≤ 50 ms;
- **perfect**: both.

Switch-backs are skipped when the ammo at `A`'s ready tick could not pay for the return volley (`starv`). **Held cycles** (`q = −1` in the reload table) are `A` repeating with nothing between. They keep only the margin histogram, so a weapon that is simply held down is not mistaken for timing.

The Reload tab groups anchors by reload class: Hair Trigger under 0.5 s, Clockwork 0.5–1.5 s, Right On Cue over 1.5 s. The class boards rank on the Wilson lower bound of the perfect (on the dot and seamless) share, from matches with at least 30 switch-backs.

### Rhythm (alternation streaks)

- A **cycle** is a switch-back returning within `R + max(0.3 s, R)`. A **streak** is 10 or more consecutive cycles of one anchor on one ship.
- **Fit values:** each streak is fitted with a least-squares line, giving the **period** and the **spread** (the gap between the largest and smallest residual, in ticks).
- **Even-beat test:** `p` is the share of 1000 shuffles of the streak's own gaps that come out at least as even as the real order. **Even** means `p < 0.01`. A streak is **tested** only when:
  - no gap is shorter than `R` (a short gap is the engine's carry and can only follow a late shot);
  - at least 3 gaps differ from the most common gap;
  - the most common gap occurs at least 3 times.
- **Implied jitter:** the per-shot timing noise at which a simulated perfect clock (same period, ticks rounded, never faster than `R`) matches the observed spread. `>40 ms` means above the simulated grid. The page labels it **Beat wobble**.
- **Clock-steady run:** the longest run of cycles whose own fit spread stays at or below 55 ms. **Clock-steady cycles** is the share of cycles inside runs of 10 or more.

### Silent ammo drops

On ships that can drop mines or dispense (a SPEC hardpoint or a stock dispenser), a one-tick ammo fall of 60–260 beyond what the shots that tick cost is a candidate drop. A drop costs the dropped object's `maxAmmo`: Prox Mine 200; MFF Mine, MITS Mine, Seeker and Solar Flare 100. A Flame Mine or Snare Field (300) falls outside the window and is never seen.

The recording has no drop event, so each drop is named by its size. A candidate counts only within 6 ammo (`DROP_TOL`) of something that ship can drop (`drop_items`, nearest wins):

- the ship's stock dispenser of that cost (MFF Mine on the Xares SGS and FS, Prox Mine on the Xares, Missile Scout, Warrior and Locust, Seeker on the Sentry, Solar Flare on the Scion Scout);
- else the dispensers of that cost its faction's armory sells that fit the ship, from the same build-tree walk as the Weapons Lab, joined with "or" when the recording cannot tell them apart.

So 200 is always a Prox Mine; 100 is an MFF Mine on Hadean, "MITS Mine or Solar Flare" on ISDF, and "Seeker or Solar Flare" on a Scion ship without a stock 100. The tolerance removes the Scion Warrior's false drops: deploying the morph tank rescales its ammo to a new `maxAmmo` (2200 against 3000), and those falls are not the size of any item. The tolerance removed 141 candidates, 135 of them the Warrior's, and none inside a cycle.

Each drop is classed as:

- **in a cycle:** inside a counted cycle (below), between the anchor shot and its return. It is credited to that cycle's pair (`reload.din`); where two anchors' cycles overlap, to the pair with more cycles;
- **near other fire:** within 1 s of another group;
- **isolated.**

**Butterfingers** divides in-cycle drops by the cycles on a ship that carried something droppable, both read from the same reload blocks (`reload.mine`). A ship carried one when its stock item is visible to the window (`ships.drop`: the Xares types, Scion Warrior, Sentry and Scout, ISDF Missile Scout, Locust), or when that player dropped something from it in that match. The second case covers a mine fitted in an empty special slot, as on an ISDF Scout or Tank. Cycles on any other ship are left out, so flying a Hedoux or a stock ISDF Scout does not dilute the rate. The sample gate is 500 such cycles (`cycm`).

The board's first line gives the drops and the cycles they came from ("28 drops in 1,188 cycles carrying a mine"). The second leads with what was dropped, most first, then where: "18 MFF Mines, 9 Prox Mines, 1 MITS Mine or Solar Flare · most often on the Xares FS (Hadean), most often Fireball Gun + Slicer". The ship and pair shares, the Career list's ship and pair tables, and its match rows ("5 MFF Mines, 2 Prox Mines · 132 cycles carrying a mine") count drops. A player with no drops splits by cycles carrying a mine instead and reads "No drops". With a pair picked, the example names the item most often dropped on that pair.

### Combat columns

These come from the processed contributions: accuracy, PvP hit share, T-key time, PvP K/D, damage and PvP damage per minute, per weapon and per ship.

**Recorder change, 2026-10-18:** before that date the recorder counted hits on players only, so accuracy from earlier matches is not comparable. The Eagle Eye career board and Compare's accuracy use matches from that date on, plus the three slot-credited recordings, whose build already recorded every hit. The History chart shows every era and shades the earlier period.

## Data contract (`index.json`, `schema_version` 1)

Every table is `{cols, rows}` (columnar, to keep the file small). Integer fields `m`, `p`, `s`, `a`, `q`, `w` and `o` index into the `matches`, `players`, `ships`, `weapons` and `ordnance` tables.

| Table | Columns |
|-------|---------|
| `players` | id (Steam64), name, slug, n (matches) |
| `matches` | id, date (UTC `YYYY-MM-DDTHH:MM`), map, fmt, dur (s), tick0, hz, sub (submitter), slot (1 = slot-credited recording) |
| `weapons` | stem, name, cat, assault, terminal, shot_delay, alt, salvo, salvo_delay, isd, lock, cost, why |
| `ships` | stem, name, pilot, drop (stock item the drop window can see, else null) |
| `rows` (player-match) | m, p, team, cmd, camp, low, sf, sh, ph, tk, k, d, pk, pd, dmg, pdmg, mins, swn, swa, sw1–sw4, swmed, vol, mt, rtn, rt1, rtmed, din, dbr, diso, viol, pa, pb, pc, ra, rb, rc, rid |
| `ship_rows` | m, p, s, mins, sf, sh, ph, k, d, pk, pd, dmg, swn, swa, sw1–sw4, swmed, vol, mt, rtn, rt1, rtmed, din, dbr, diso |
| `ordnance` / `weapon_rows` | stem, weapon / m, p, o, sf, sh, ph, dmg |
| `streaks` | m, p, s, a, q, t0, n, per (ms), sp (ticks), pv, jit (ms), ck, g |
| `reload` | m, p, s, a, q (−1 = held), R (match ticks), sb, dot, seam, perf, cyc, starv, din, mine, ditem, held, held0, h |
| `reference` | s, w, hp, R_ms, Rmin_ms, isd_ms, grp, shots, vols, floor_ms, below, desync, flag, players |

Column notes:

- **`rows` switching and drop columns:**
  - `swn`: switch count;
  - `swa`: active seconds;
  - `sw1`–`sw4`: switch gaps in 50 ms bins (1 = 50 ms, 4 = 200 ms and over);
  - `vol` / `mt`: firing ticks / multi-group ticks;
  - `rtn` / `rt1` / `rtmed`: round trips, one-tick returns, and the median `wait` in ms (null with no trips);
  - `din` / `dbr` / `diso`: drops in a cycle, near other fire, isolated;
  - `viol`: gaps under `Rmin`;
  - `pa` / `pb` / `pc`: top switched pair and its count;
  - `ra` / `rb` / `rc`: most-used round trip (unordered, like the switch pair) and its count;
  - `rid`: the Steam64 the recording uses for this player when it differs from `players.id` (account reroutes and silent aliases), else null. The raw event browser filters on it.
- **Gap and histogram encodings:**
  - `streaks.g`: the gaps in ticks, as base-36 characters, or a leading comma and a comma-separated list when a gap exceeds 35.
  - `reload.h`: `margin_bin,dead_bin,count;...`, with margins capped at bin 20 (1 s) and dead time at bin 10 (500 ms).
  - `reload.din` / `reload.mine`: in-cycle drops credited to the block's pair, and 1 when the ship carried something droppable in that match. `rows.din` and `ship_rows.din` sum the same drops before the desync and flagged-weapon blocks are dropped, so Butterfingers reads the reload table.
  - `reload.ditem`: those drops by item, `index:count,...` into the top-level `drop_items` names (empty with none); the counts sum to `din`.
- **Other top-level keys:**
  - `drop_items`: the item names `reload.ditem` indexes;
  - `constants`: every threshold above, including `drop_tol`;
  - `metrics`: the catalog (id, group, unit, direction, aggregation, sample gate);
  - `events`: the recorder change;
  - `population`: per-weapon percentiles of the switch-back shares;
  - `skipped`: `[why, ordnance, count]` for unresolved (`unknown`), secondary and `foreign` (the ship could not fire it) ordnance.

**Lane files (`match/<id>.json`):** `{schema_version, id, m, tick0, hz, players: {p: [lane]}}`. Each lane is `{s, a, R, t0, len, shots, sb, drops}`:

- `t0` is a match tick;
- every offset inside a lane is ticks from `t0`;
- `shots` is `"dt,w;..."`;
- `sb` is `[[dt, margin, dead]]`;
- `drops` is `[[dt, residual, class, item]]`, `item` the name from the drop's size.

Lanes cover streak windows first, then switch-back windows for anchors reloading at least 0.5 s, within 300 s per player-match.

## Page

- **Files:** `index.html`, `css/analysis.css` and `js/analysis.js`.
- **Shared assets:** the site's vendored Bootstrap, Chart.js (plus the zoom plugin), theme and topnav. No new dependencies.
- **Tabs:** Career (the default), History, Compare, Reload timing, Rhythm map, All players and Moments. Each tab renders lazily and re-renders on theme change.
  - **Career** boards pool every match in the date range and rank a player only past the board's sample gate. Each board also gives the typical player, the median value of everyone it ranks, in its footer ("Typical player: 22.8% (median of 35 ranked)"). Each row shows its gap to that value, and its meta line says in how many of the player's own matches they beat it. Those matches are the ones that clear the board's per-match gate (`MATCH_GATE`), and the comparison follows the board's direction, so lower wins on Steady Hand and Zero Lag.
  - **Ranked on:** each Career row adds a muted line naming the ship (with no Ship picked) and the weapon pair (with no Weapon pair picked, on the boards that know the pair) behind the player's figure: "Mostly on the Xares SGS, most often Dragon Blast + Shell Gun". *Mostly* means at least half of the figure; *most often* means the biggest share but under half. The tooltip gives the top three of each with their shares. On a narrow screen the line wraps after a comma.
    - A ship's share is its part of the board's own sample (firing time, round trips, shots, streaks, switch-backs, cycles or minutes), the same pool the Ship filter would rank. Two boards split differently. The Undertaker splits by time in a ship, since a match flown in two ships would count twice by matches. The Juggler splits by switches, so a ship flown a lot without switching cannot lead the line.
    - The pair share counts tested streaks, switch-backs or cycles on the rhythm and reload boards (`PAIR_EXACT`); Butterfingers counts the player's drops (cycles on a ship carrying a mine when they have none), so a pair flown on a mine-less ship never names its line. The Juggler has only each match's most-switched pair, so its pair share is of switches; FastHands.exe has only each match's most-used round trip, so its share is of round trips (`PAIR_SHARE_ONLY`). Both say so.
    - Tunnel Vision and Heavy Hitter have no line: T-key time and PvP damage are recorded per match, not per ship (`NO_SHIP_SPLIT`). The combat boards have no pair line.
    - Each part hides while its own filter is set, since the filter has already fixed it.
  - **Career list:** a Career row click opens the drill-down panel as a list of what built that player's position, under the same filters as the board.
    - The header gives the career value, the rank, the typical player and the gap, and the beat-typical count.
    - **On each ship** (no Ship picked) lists the player's top 5 ships by the same share as the row line, then an Other ships remainder. Each row gives the player's figure on that ship, the typical player on it and their rank on it ("#1 of 32"), which is what the board shows with that ship picked. A figure under the board's gate is dimmed and reads Not ranked.
    - **On each weapon pair** (no pair picked) does the same for the pairs on the `PAIR_EXACT` boards. On The Juggler and FastHands.exe it lists shares only, with a note saying why a pair has no figure there.
    - Clicking a ship or pair row (or Enter on it) sets that filter, closes the panel and scrolls to the board, now ranked on that ship or pair.
    - Units are matches, except on Little Drummer Boy and Steady Hand, where they are streaks. A match row shows its ship (the filtered ship, else the one with the most minutes), its pair (the filtered pair, else the match's top pair), the value and its sample. Rows under the per-match gate are dimmed; they still count toward the career figure.
    - **Lift** is a unit's share of the gap to the typical player on pooled boards: `g × (v − typical) / Σg`, with `g` the board's sample (switches, round trips, switch-backs, shots, minutes or tested streaks). PvP K/D uses `(kills − typical × deaths) / Σ deaths`. The lifts sum exactly to the gap, and the header says how much of it the 10 biggest carry. Median boards (Steady Hand, Zero Lag, T-key time) have no lift and say so.
    - Sorts: Lift (the default where it exists), Best and Recent. 20 rows show at first, with a Show more button.
    - A row opens that match, or that streak, in the same panel with a Back link that restores the list and its scroll position. Open on History keeps the old row action: it sets the metric, adds and focuses the player and shows History.
  - **Moments** are record boards built from single matches or single streaks. The `per` toggle picks the ranking:
    - **Most often** (the default) puts a bar at the board's top 10% of moments under the current filters, ties included. Each row is a player's moments at or past that bar out of all their moments ("94 of 368 streaks in the top 10%"). Rows rank by that count, then by the better best moment, and players with none are left off. The footer gives the bar ("Top 10%: 311.2 ms or better, of 1,056 streaks"), and a row click opens the player's best moment.
    - **Best moment** ranks each player's single best, so one great night can top it.
    - **All moments** lists every moment, so one player can hold several rows.
  - **Reload timing** draws one density panel per selected player: margin across, fire lost up, cell brightness the log count. The explanation above the panels carries a corner key: bottom-left (on the dot, seamless) is best, top-right (late, lost) is worst, and each panel tags those two corners.
    - **Panel order** (`rsort`): Name A–Z (the default), Best first or Worst first. Best and Worst order by the perfect share, the bottom-left figure and the table's Both column. Players under 30 switch-backs (`RELOAD_MIN_SB`) follow in name order and read Not ranked; panels with nothing to draw come last.
    - A ranked panel shows its rank among everyone in the table below ("#3 of 20"), so the two always agree. Each player keeps their color in any order.
  - Titles in Compare and All players follow the active Moments mode.
  - Every board shows an "In game" example with VSR weapons; the rule it ranks by is the tooltip of the (i) button after its name. That copy lives in `LEADER_TITLES` in `js/analysis.js`.
  - The examples follow the filters. With a weapon pair picked, the timing and switching boards rewrite their example for it (`pairGame` in `LEADER_TITLES`, filled by `exampleCtx()`). They use the slow weapon's reload on the picked ship, or on the ship that used the pair most, from the weapon reference: the window between shots, how many partner volleys fit, the switch ceiling, and what one tick is as a share of the cycle. With only a ship picked, they use that ship's most-used pair and name it. A reload-class board whose class the pair does not fit says which board it ranks on instead.
  - With nothing picked, each of those boards uses its **most common case** (`commonCase()`): the pair, on the ship it was used on most, that holds the most of the board's own sample over every recording, led by "Most common: … on the …". The sample is streaks on the rhythm boards (Dragon Blast + Shell Gun on the Xares SGS today); round trips on Quick Draw and FastHands.exe; switches on Button Masher and The Juggler; switch-backs on the reload boards, within the class on the three class boards (FAF Msl + Minigun on the ISDF Scout, Dragon Blast + Shell Gun under 0.5 s, Arc Cannon + Gauss Gun over 1.5 s); and in-cycle drops on Butterfingers (Combat Laser + Particle Gun on the Xares), whose example names the item most often dropped there (a Prox Mine). The fixed `game` text is only the fallback and quotes the same cases.
  - The combat boards keep fixed text, written around the most common cases in the processed matches: the Scout is the player ship destroyed most, the Scavenger the AI unit and the Extractor the building; the Chain Gun deals the most damage and the Minigun lands the most hits on players.
  - The pair does not filter Quick Draw, Button Masher, The Juggler or FastHands.exe, so with a pair or ship picked those boards carry a **Ranks every weapon** tag; their example only illustrates the pair. The most common case needs no tag.
  - **A ship and a pair that never met** (`pairShipGap()`): both picks stay. An example never quotes another ship. The boards the pair filters (`PAIR_FILTERED`) say "The ISDF Walker never used Dragon Blast + Shell Gun in these recordings." and their empty state says "Nothing to rank: the ISDF Walker never used this pair." The unfiltered switching boards say so and then use the ship's own most-used pair. A notice chip under the filters says the rhythm and reload boards are empty, and the pair picker lists the other pairs under "Never used on the ISDF Walker".
  - Boards sit in one CSS grid and each card is an 8-row subgrid (two header lines, five rank rows, footer), so the titles, examples, rank rows and footers line up across every card in a visual row. Browsers without subgrid keep the grid but lose the line alignment.
- **Players:** every player is selected on load. The boards' sample gates, not the selection, keep a player with a few good moments from outranking a consistent career.
  - The Players button opens a picker modal with search, All and Clear, the picked players as removable chips, and every player in alphabetical order with their match count. Picks are staged and apply when the modal closes, so nothing re-renders until then. Enter in the search toggles the first match. With more than 6 players selected (`CROWD`) the filter bar's chip row collapses to one `N players ×` chip; at 2 to 6 the individual chips get a Clear link.
  - The boards always rank every player. They mark the selection only when it is not everyone.
  - In a crowd, History draws thin lines and a taller chart with a compact legend, Compare scrolls sideways with the metric column pinned, Reload uses smaller panels, and the strip plot rotates its names.
  - **Focus:** clicking a name in the History or Rhythm legend focuses that player (thick line, others faint, the small multiples follow it); clicking it again, or the `Focused: name ×` chip, clears it. The Career list's Open on History button adds the player and focuses them on History.
- **Ship and Weapon pair:** each button shows the current pick and opens a single-select picker modal. Search matches every word in any order. Enter picks the first result, the arrow keys move through the list, and a pick applies at once and closes the modal. With a pick set, an × button beside the field clears it, and each modal has a Clear action; the filter chips' × does the same.
  - Ships with more than 5 minutes are listed, grouped ISDF, Hadean and Scion and alphabetical within each, with the stem and minutes.
  - Pairs with 50 or more switch-backs are listed, grouped by slow weapon (with its reload) and alphabetical by partner, with the ship that used each pair most and its switch-back count. With a ship picked, that ship's pairs come first. Search also matches ship names.
  - The current pick stays listed even below those floors.
- **Hover:** every chart names what is under the cursor, in the shared glass tooltip.
  - History and its small multiples give the match and each player's value, and say when a line is the rolling mean.
  - The Compare strip gives each dot's value with that player's median, before and after a split when one is set.
  - The Rhythm map gives the streak's pair, cycle, length, p and wobble.
  - The Reload density panels give a cell's margin and fire-lost bins and its switch-back count.
  - The drill-down tick lane names each shot's weapon and match clock, each silent drop and what it dropped, and each switch-back's margin and fire lost.
- **Drill-down:** clicking a board row, chart point or rhythm dot opens a match panel with:
  - the streak gap chips;
  - the tick lane;
  - links to the match dashboard and the raw event browser.
- **Raw links:** they open `raw/` on `bulletInit` events filtered to the player (by `rid` when set):
  - streak boards and streak cards add the streak's tick window, padded by one second each side;
  - match boards and the drill-down's Raw shots button cover the whole match;
  - the tick lane links its own window;
  - career boards have none.
- **URL:** all state lives in the query string, written with `replaceState`: `tab`, `players`, `focus`, `metric`, `x`, `smooth`, `ship`, `pair`, `from`, `to`, `split`, `win`, `per`, `rw`, `rsort`, `sort`, `career` and `drill`.
  - No `players` key means every player, and the page omits the key while everyone is selected; `players=all` still works.
  - `x` is `match` (the default) or `date`.
  - `drill=<match id>~<player>[~<streak start tick>]` opens that match's drill-down, with the streak highlighted when a tick is given. Opening, closing or picking a streak in a drill-down updates it, so the address bar can be copied.
  - `career=<board id>~<player>` opens that player's Career list. With `drill` as well, the match opens on top of the list with its Back link. An unknown board or player drops the key.
  - A list (`players=nomad,muffin`) is that subset. An empty `players=` keeps the selection empty, and tabs that chart players show a panel with Select all and Pick players.
  - `focus` is one player's slug (or Steam64); it is dropped when that player is not selected.
  - `tab` defaults to `career`. `tab=leaders` (the old combined tab) and `tab=highlights` (the old name) open Moments.
  - `per` is `often` (the default), `best` or `all`.
  - `pair` is `<slow stem>~<partner stem>`; an unknown stem drops it.
- **Statistics:** the page computes only display statistics over the pre-computed rows:
  - rolling means;
  - medians;
  - Wilson lower bounds;
  - a Mann–Whitney rank-sum p for before/after splits;
  - Suggest split, a single change point with at least 8 matches per side.
