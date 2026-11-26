# VSR-T interim revision — opponents-only reference, late-demolition trim, lift retired

**Status: SIGNED 2026-11-26 (UTC), shipped the same day.** See Results.

## TL;DR

VSR-T is a personal performance rating, and two things let the team
result leak into it. A third rule reacts badly once those two are fixed.
This memo registers one revision that changes all three in one re-rate:

1. **Expected score against the other team only.** Today a thug's
   expected score is set against the median of everyone else in the
   lobby, teammates included. Strong teammates lower the bar; weak ones
   raise it.
2. **Late demolition does not count.** Building damage in the last 180
   seconds is the winners knocking down a beaten base.
3. **The low-tier lift is retired.** With 1 and 2 in place it makes the
   ratings worse at predicting winners and reorders players.

It is interim because the joint model
(`critique/decisions/joint-skill-model.md`) has neither leak by
construction, but its test runs for months and may not pass.

This supersedes the two-memo route sketched in
`.cursor/plans/team_strength_and_endgame_1728b6f3.plan.md` and the 10%
late-share rule in `critique/decisions/vtsr-t-enemy-damage.md` ("Late
building damage").

## What changes

Three constants in `scripts/elo.py`:

```python
EXPECTED_REFERENCE_POOL = "opponents"        # was "lobby"
ENEMY_DAMAGE_TRIM_LATE_STRUCTURE = True      # was False
LOWTIER_LIFT_ENABLED = False                 # was True
```

- **Reference.** `_reference_indices()` keeps only the other team's
  rated rows. If the other team has none, it falls back to everyone
  else. Teams come from the row's slot, as the wins ladder derives
  them.
- **Trim.** `personal.enemy_structure_dealt_late` (building damage in
  the last `STRUCTURE_LATE_SEC` = 180 s of the recording) is left out
  of `enemy_damage_share`. The window is anchored on the end of the
  recording because the deciding tick is missing for 209 of 292 rated
  matches, and recordings stop within seconds of the result.
- **Lift.** The v2.8 at-base lift is switched off. Its code stays.

Nothing else moves: the single axis, the commander allowance, loss
aversion, the floor, K, bands.

## What was already seen

Written after these numbers were known. `python
scripts/study_vtsr_t_fairness.py` reproduces them
(`_validation/vtsr_t_fairness.md`). 292 rated matches, 1,921 thug rows,
292 recorded duels.

**The two leaks, today's rules.**

- A thug's score minus expectation rises with how much stronger their
  teammates are than their opponents: slope +0.040 per 100 points of
  gap (z 4.0). Thugs in the bottom fifth of team gaps average −1.2
  points a game; the other fifths +3.4 to +4.8.
- Late building damage is 8.5% of a winning thug's enemy damage and
  1.9% of a losing thug's. It pays winning thugs +2.4 points a game and
  costs losing thugs 2.5.
- With the match result held fixed the gap slope disappears. The two
  leaks are one thing seen twice: better teammates mean more wins, and
  winners out-damage losers.

**All eight combinations.**

| Reference | Trim | Lift | Gap slope (z) | Team-result share | Reliability | Tier ordering | Gain over commanders | Win formula log-loss vs today (± SE) |
|---|---|---|---|---|---|---|---|---|
| lobby | off | on | +0.040 (4.0) | 23.2% | 0.957 | 70.7% | 4.87 | today |
| lobby | off | off | +0.039 (3.9) | 23.2% | 0.961 | 71.5% | 5.09 | −0.0006 ± 0.0014 |
| lobby | on | on | +0.032 (3.3) | 13.6% | 0.979 | 72.5% | 4.63 | +0.0012 ± 0.0042 |
| lobby | on | off | +0.028 (3.0) | 13.7% | 0.983 | 73.4% | 4.91 | +0.0007 ± 0.0040 |
| opponents | off | on | +0.007 (0.8) | 23.0% | 0.953 | 69.4% | 3.72 | +0.0073 ± 0.0041 |
| opponents | off | off | +0.010 (1.1) | 23.2% | 0.961 | 71.1% | 5.45 | −0.0018 ± 0.0020 |
| opponents | on | on | −0.001 (−0.1) | 13.3% | 0.972 | 71.3% | 3.37 | +0.0092 ± 0.0046 |
| **opponents** | **on** | **off** | **−0.001 (−0.1)** | **13.7%** | **0.983** | **73.4%** | **5.15** | **+0.0002 ± 0.0040** |

- "Gain over commanders" is how much the thug-rating gap adds to
  predicting winners once the commander gap is known (log-likelihood).
- "Win formula" is today's VSR-C expected score on all 292 recorded
  duels, replayed on each variant's thug ratings.
- Winner AUC since 2026-10-25 (57 matches): 0.610 today, 0.609 for the
  candidate.

**Why the lift goes.** With the reference fixed and the lift on, the
thug gap adds less to winner prediction (3.72, 3.37) and today's win
formula gets worse (+0.007, +0.009). With the lift off neither happens.
The lift is about 120 points at a factor of 0.6, larger than its own
60-point taper, so a player who drops into its range is lifted past the
players above them. With the reference fixed, judgeguns falls 52 points
with the lift off and rises 64 with it on. Today the lift raises 4
players with 10 or more matches (Maverick +112, Totokomo +59,
The_Bylarge +49, DraconisMarch +32) and puts two of them above
judgeguns, whose rating without it is higher.

**What the candidate does to the ladder.** Of 24 players with 25 or
more rated matches, 7 change half-band and 5 change tier.

| Player | Today | Candidate | Change | Band |
|---|---|---|---|---|
| Snake | 1911 | 2020 | +110 | Tier 2 Upper to Tier 1 Upper |
| Cloaket | 1821 | 1895 | +74 | Tier 2 Upper to Tier 1 Lower |
| VTrider | 2139 | 2206 | +67 | same |
| Domakus | 2044 | 2109 | +65 | same |
| Muffin | 1896 | 1920 | +24 | Tier 2 Upper to Tier 1 Lower |
| Darkvale | 1614 | 1537 | −77 | Tier 3 Upper to Tier 3 Lower |
| The Wanderer | 1509 | 1420 | −89 | Tier 3 Lower to Tier 4 Upper |
| DraconisMarch | 1459 | 1369 | −90 | Tier 4 Upper to Tier 4 Lower |
| Monkey | 1557 | 1462 | −95 | Tier 3 Lower to Tier 4 Upper |

The other 15 move between −52 and +38 and keep their band. VSR-C moves
little: commanders with 15 or more duels shift 3.8 points on average
and 9.0 at most.

## The rule

The candidate is (opponents, trim on, lift off). The control is today's
rules (lobby, trim off, lift on). Both are replayed over the full
corpus by `scripts/study_vtsr_t_fairness.py`. The candidate ships iff
ALL five hold:

1. **Team-gap slope:** at most half of the control's, and within two
   standard errors of zero.
2. **Team-result share:** down by a quarter or more.
3. **Split-half reliability:** not lower than the control's.
4. **Same-game tier ordering:** not lower by more than 1 point.
5. **Today's win formula on recorded duels:** not worse by more than
   0.005 log-loss.

Reported, not gated: winner AUC, each change alone, and the lift-on
version of the bundle.

**Why winner AUC is not a gate.** The 2026-10-24 run rejected the trim
on a winner-AUC guard. Demolition damage predicts winners because
winners do it. A personal rating that loses that signal should be
judged on whether it measures the player (gates 1 to 4) and on whether
the thing it feeds still works (gate 5).

**This rule was written after the numbers above were seen.** It is not
a blind test. What keeps it honest is the forward check.

Anything else: nothing ships.

## Forward check

Rerun the harness once 40 more decided matches have been played after
the ship date. Revert all three constants if, on the full corpus at
that point, gate 1 or gate 3 fails. Append the result here either way.

## What ships if the rule passes

- The three constants above.
- `ELO_SCHEMA_VERSION` 21 to 22. Earlier `peak_vtsr` values are not
  comparable.
- `CMDR_ELO_SCHEMA_VERSION` 14 to 15, because the thug means in VSR-C's
  expected score change. VSR-1v1 and VSR-2v2 are untouched (VSR-2v2T
  performance reads `enemy_dealt` directly and has no late trim).
- Copy: the expected-score caption in `js/vtsr-explainers.js`; the
  fairness cards in `js/elo.js` (the "Stranded at base?" card retires,
  a late-demolition card is added).
- Docs: `DEVELOPER_GUIDE.md` §13.7.10, `docs/DATA_DICTIONARY.md`, the
  rule files, `elo/analysis/index.html` (roadmap Phase 7(c), the
  all-tier lift, is closed).

The joint model's test is not affected. Its baseline is frozen on the
rules above the line and replayed in memory
(`scripts/joint_test.py::BASELINE_RULES`).

## Undo recipe

Set the three constants back, bump `ELO_SCHEMA_VERSION` and
`CMDR_ELO_SCHEMA_VERSION` again, rerun the pipeline. The replay is
exact: at the old values `elo_history.json` is byte-identical to the
pre-revision file (checked when the hook landed).

## Source files

- `scripts/elo.py` — the three constants, `_reference_indices()`
- `scripts/study_vtsr_t_fairness.py` — the harness and the gates
- `scripts/vtsr_t_variants.py` — shared metrics
- `.cursor/plans/vtsr_next-gen_analysis_4d5207d7.plan.md` — the analysis
- This memo

## Sign-off

Signed by the operator on 2026-11-25 at about 22:30 US Central
(2026-11-26 UTC), with the gates and the regulars' band changes above
in front of them.

## Results

### Run 2026-11-26 (after sign-off) — PASS, shipped

`python scripts/study_vtsr_t_fairness.py`, same corpus as "What was
already seen" (292 rated matches, newest 2026-11-18).

| Gate | Control | Candidate | Result |
|---|---|---|---|
| Team-gap slope at most half, within 2 SE of zero | +0.0399 (z 4.0) | −0.0010 (z −0.1) | pass |
| Team-result share down by a quarter | 0.232 | 0.137 | pass |
| Split-half reliability not lower | 0.957 | 0.983 | pass |
| Same-game tier ordering not lower by more than 1 point | 0.707 | 0.734 | pass |
| Today's win formula not worse by more than 0.005 log-loss | 0.6310 | 0.6312 (+0.0002 ± 0.0040) | pass |

### Shipped 2026-11-26

`ELO_SCHEMA_VERSION` 22, `CMDR_ELO_SCHEMA_VERSION` 15.
`python scripts/process_stats.py --no-sync --no-prompt` on the same
corpus (390 cached, 0 reprocessed), so every difference is the revision.

- The published ratings equal the harness's candidate: 24 regulars, 7
  half-band changes, mean |change| 44, largest 110 (Snake).
- Six players with 5 to 24 rated matches also change band: blue (Tier 3
  Upper to Tier 2 Lower), Totokomo, The_Bylarge and Maverick (Tier 4
  Upper to Tier 4 Lower, all three had been raised by the lift),
  Manslayer (Tier 2 Upper to Tier 2 Lower), Xohm (Tier 3 Lower to Tier
  3 Upper).
- VSR-C: 23 commanders with 15 or more duels move 3.8 points on average
  and 9.0 at most. The top eight keep their order.
- Validator on the new ratings: pre-match rating against match score
  0.433 to 0.496; self-consistency 0.837 to 0.896; share of a thug's
  score explained by the team result 0.232 to 0.137; VSR-C duel
  prediction 63.1% to 63.3% (log-loss 0.627 both).
- The joint model's history did not change (0 duels refit): it reads
  which rows are rated, not their ratings.

Forward check: due once 40 decided matches dated after 2026-11-26 have
been played.
