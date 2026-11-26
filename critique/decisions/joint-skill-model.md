# Joint commanding-and-fighting model — pre-registered switch test

**Status: SIGNED 2026-11-26 (UTC).** The test is running. Recorded duels
dated after `FREEZE_DATE` = 2026-11-26 in `scripts/joint_test.py` count;
the first are dated 2026-11-27 UTC.

Settings hash: `6b38185d5538c351` (`elo_joint.config_hash()`).

## TL;DR

- VSR-T and VSR-C hold evidence about the same players and do not share
  it. VSR-T ignores who won. VSR-C ignores how well the commander
  fights.
- The joint model gives every player two skills, commanding and
  fighting, and learns both from one set of evidence: who won, and how
  much damage each player dealt compared with their own teammates.
- It runs beside today's ratings and changes none of them. Its win
  chance is shown as a labelled preview.
- It replaces today's ratings only if it predicts recorded games
  clearly better than today's win formula. The test is checked at 200,
  300 and 400 recorded duels and then ends, pass or not.
- On the games already played it is ahead (log-loss 0.5886 against
  0.6280, 67.9% of winners against 62.7%, on 252 recorded duels). Those
  games also chose its settings, so they do not count. Only duels dated
  after the sign-off do.

## The model

Skills are in logit units. A game played in calendar quarter q uses that
quarter's skills:

```
logit P(team 1 wins) = C[c1,q] - C[c2,q]
                     + mean F[team 1 fighters,q] - mean F[team 2 fighters,q]
```

- `C` is commanding skill: what a commander adds beyond their own
  fighting. `F` is fighting skill, the same number whether the player
  commands or not.
- A side's fighters are its rated thugs plus its commander.
- There are no faction, map or pick-order terms.

Recorded matches also give damage rows. Each is scored inside the
player's own team, so nothing at team level can enter: not the result,
the faction, or how well the commander supplied the team.

```
v = ln(enemy_dealt + 100) - mean of that over the team's thugs

thug       v ~ Normal(0.12 * (F - mean F of the team's thugs), noise)
commander  v ~ Normal(0.12 * (F - mean F of the team's thugs) + offset[player] + mu, noise_c)
```

- A team's k thug rows are scored together with the per-thug noise
  before centring (centred spread over `sqrt((k - 1) / k)`).
- The commander offset is one number per player, shrunk toward the
  group. A commander who fights less while commanding keeps their
  fighting skill; what that costs in wins shows up in commanding skill.

Skill over time (Whole-History Rating on quarterly blocks, Coulom 2008):

```
first quarter played   C ~ Normal(0, 0.75)                 F ~ Normal(0, 2.0)
each later quarter     C ~ Normal(C the quarter before, 0.055)
                       F ~ Normal(F the quarter before, 0.40)
offset ~ Normal(0, 0.22)
```

The steps are 0.11 and 0.8 a year. Old games stay in at full weight for
the quarter they were played in.

Fit: maximum a posteriori, Newton steps with step-halving, tolerance
1e-9. With Gaussian noise the objective is strictly convex.

History is walk-forward: a duel's win chance comes from the fit on all
earlier games.

## Frozen settings

`elo_joint.DEFAULT_CONFIG`, hash above. Changing any value restarts the
test.

| Setting | Value |
|---|---|
| Damage loading | 0.12 |
| Prior spread, commanding / fighting | 0.75 / 2.0 |
| Step per year, commanding / fighting | 0.11 / 0.8 |
| Block length | 3 months, counted from January 2025 |
| Commander offset spread | 0.22 |
| Constant added to damage before the log | 100 |
| Shortest match that gives damage rows | 240 s |
| Centred spread, thug rows, by thugs on the team (2 / 3 / 4+) | 0.196 / 0.2729 / 0.3144 |
| Per-thug noise before centring (the same, de-projected) | 0.277 / 0.334 / 0.363 |
| Spread, commander rows (2 / 3 / 4+) | 0.4015 / 0.4381 / 0.4422 |
| Length multiplier, thug rows (under 12 / 12-20 / 20-30 / 30+ min) | 1.2105 / 0.9225 / 0.8796 / 0.7722 |
| Length multiplier, commander rows | 1.2715 / 0.8503 / 0.8986 / 0.7795 |

The noise table is the within-player spread of the centred damage value
on every recorded duel through 2026-11-18 (1,844 thug rows and 510
commander rows from players with at least 8 rows).

## Who counts

- **Games:** every duel in `elo_commander_history.json` with a team
  winner: rated recorded matches and F9bomber's ledger duels. The model
  reads `elo_history.json` and `elo_commander_history.json` for
  membership only (which matches and rows are rated, and the order of
  the duels). It reads no rating from either.
- **Fighters:** the rows VSR-T rates (camera-pod, low-activity and
  zero-damage thug rows are out), plus the commander. F9 games use the
  ledger's rosters.
- **Damage rows:** recorded matches of 240 s or more. A row needs enemy
  damage above zero. A team needs two thugs with damage. A player the
  pipeline marks as benched (`match.bench`) gives no row.
- **Uneven sides:** the mean of the fighters present. No headcount term.

## What was already seen

Written after these numbers were known. They are the back-test and do
not count toward the test. `python scripts/study_joint_skill.py`
reproduces all of them (`_validation/joint_skill.md`).

Back-test, 252 recorded duels after the first 40 (800 games, 292
recorded, 2,465 damage rows, 1,099 parameters). Noise for the back-test
was measured only on duels before the late window.

| Model | Log-loss | Winners called | Late window (146) | Against frozen (± SE) |
|---|---|---|---|---|
| Frozen settings | 0.5886 | 67.9% | 0.6079 | reference |
| Today's win formula | 0.6280 | 62.7% | 0.6375 | +0.0394 ± 0.0194 |
| Fixed skill (no steps) | 0.5910 | 67.9% | 0.6116 | +0.0024 ± 0.0030 |
| Fixed skill, results only | 0.6127 | 68.7% | 0.6300 | +0.0241 ± 0.0182 |
| Fixed skill, decay 730 / 365 / 180 days | 0.5919 / 0.5937 / 0.5985 | | | +0.0033 / +0.0051 / +0.0099 |
| Fixed skill, games before recording dropped | 0.6226 | 64.7% | 0.6216 | +0.0340 ± 0.0124 |

The prototype reported 0.5884 on 2,466 damage rows. The module gives
0.5884 with the bench rule off and 0.5886 with it on (one row fewer).

Configuration check, each neighbour paired against the frozen settings
on the same 252 duels (negative = neighbour better):

| Neighbour | Difference (± SE) |
|---|---|
| Damage loading 0.10 / 0.14 | −0.0009 ± 0.0025 / +0.0017 ± 0.0020 |
| Commanding spread 0.5 / 1.0 | −0.0013 ± 0.0041 / +0.0031 ± 0.0030 |
| Fighting spread 1.5 / 2.5 | −0.0026 ± 0.0020 / +0.0024 ± 0.0014 |
| Steps halved / doubled | +0.0011 ± 0.0020 / +0.0032 ± 0.0036 |
| Half-year / two-month blocks | +0.0038 ± 0.0016 / +0.0023 ± 0.0018 |

No neighbour is ahead by two standard errors. The best is ahead by 1.3,
which is what chance gives among ten.

Why skills step by quarter when prediction cannot tell that from a fixed
skill (+0.0024 ± 0.0030):

- Thugs' damage against their own teammates shifted between the early
  and late half of the recorded months by more than chance (16 players,
  p = 0.027; Cloaket up, Lithium and judgeguns down).
- Skills fitted only on recorded-era games explain the F9 games of the
  year before and fade further back: slope 1.02 ± 0.17, 0.96 ± 0.19 and
  0.55 ± 0.26 for early 2026, late 2025 and early 2025. The fighter
  part fades; the commander part does not.
- Commanding skill shows no movement (14 commanders, p = 0.36), hence
  the small commanding step.
- A fixed-skill fit moves a player less with every game they add.

## The frozen baseline

The joint model is tested against **today's win formula on today's VSR-T
rules**:

- `scripts/elo_commander.py::expected_score`: commander VSR-C gap plus
  the gap in mean thug VSR-T, scale 400, lambda 1.0.
- VSR-T rules: expected-score reference `lobby`, late-demolition trim
  off, low-tier lift on (`joint_test.BASELINE_RULES`).

The interim VSR-T revision changes those three rules. So that it cannot
move the yardstick mid-test, `joint_test.frozen_baseline_expected()`
replays VSR-T and then VSR-C in memory with the three rules set back.

Fingerprint, taken before the interim revision:
`critique/decisions/joint-skill-model.baseline.json` holds the
baseline's win chance for all 292 recorded duels (sha256
`6684454654c9928e…`). On the day it was taken it matched the published
`elo_commander_history.json` exactly (largest difference 0.0).

## PRE-REGISTERED SWITCH TEST

**The sample.** Recorded duels dated strictly after the sign-off date,
in the order played. For each one the pipeline logs three win chances
for team 1 in `data/joint_test_ledger.json`, as first computed: the
joint model's, the frozen baseline's and the live formula's. A logged
entry is never rewritten.

**The measure.** Per duel: log-loss under the frozen baseline minus
log-loss under the joint model. Positive means the joint model was
better.

**The looks.** At 200, 300 and 400 logged duels, on the first 200, 300
and 400 entries. A look passes when all three hold:

1. The mean of the per-duel differences is at least **2.0** of its
   standard errors above zero (standard error = standard deviation over
   the square root of the count).
2. The over-confidence guard does not fire. It fires when the slope of
   the outcome on the joint model's log-odds is more than 2.0 standard
   errors below 1.
3. The joint model is also ahead of the live formula on the same
   entries (mean difference above zero).

**Pass.** The first look that passes makes the joint model a switch
candidate: the Balonce meter, the VSR-T bands and VSR-C move to it
together. This memo authorizes that work; it needs its own
implementation plan.

**Hard stop.** If no look passes, the test ends at 400. The joint model
stays a forensic output. A later attempt needs a new memo and fresh
duels.

**Withdrawal.** If at a look the joint model is behind the frozen
baseline by 2.0 standard errors, the preview comes down and the test
ends.

**What to expect.** From resampling the 252 back-test differences by
session (62 sessions, 40,000 draws):

- If the two are truly equal, the test passes 5.0% of the time.
- If the joint model is truly better by 0.020 / 0.030 / 0.040 / 0.050
  log-loss, it passes 32% / 56% / 77% / 91% of the time. The back-test
  margin is 0.039 on all 252 duels and 0.030 on the last 146, and both
  are upper estimates.
- The smallest mean gain that can pass is 0.043, 0.035 and 0.031 at the
  three looks.
- Withdrawal fires 3% of the time if the two are equal, 53% if the
  joint model is truly worse by 0.030 and 93% at 0.050.
- At about 80 recorded duels a month the looks fall roughly 2.5, 4 and
  5 months after the sign-off.

The joint model is the sharper of the two, which is why the guard is in
the rule. On the back-test its favourites won 51%, 65%, 74% and 81%
where it said 55%, 65%, 75% and 87%; its slope is 0.91 ± 0.14 and
today's is 0.91 ± 0.17.

**Not allowed.** No setting is chosen or changed on logged duels. No
look is added, moved or repeated. The sample is not widened to recover
earlier games. A near-miss ends in a hold, not a relaxed rule.

Amendments need a new section, justified on method only and written
before the next look is examined.

## The preview

While the test runs, the joint model's win chance is shown as one
labelled line beside the Balonce meter ("New model (in testing)"). It
changes no rating, band or Suggest result. It is hidden when the files
are missing, the sides are uneven, a commander is not set, or the test
has been withdrawn.

At the back-test the preview and the meter differ by 10 points or more
in half of recorded duels and name a different favourite in 18%. That
is the reason for a labelled second reading and not a silent swap.

## Display rule at a switch

Fixed now, computed once on the day of the switch:

- **VSR-T band.** Fighting skill is mapped to points by a straight line
  chosen so that players with 25 or more rated matches keep the mean
  and the spread of the VSR-T that is live that day. Bands then follow
  the existing band rules.
- **VSR-C.** `1500 + 173.72 × (C + F / 5)`: commanding skill plus the
  commander's own share of a five-fighter team, on the Elo scale. The
  files also carry `C` and `F` separately, so the meter uses the real
  team sizes.

## What this memo does not authorize

- Any change to a published rating before a look passes.
- Using the joint files in `scripts/elo.py`, `scripts/elo_commander.py`,
  `scripts/elo_1v1.py`, `scripts/elo_2v2.py` or
  `js/all-matches-aggregator.js`.
- Tuning anything on the largest-gaps table in the study report. It
  lists the players whose results and damage disagree most, with the
  uncertainty of each gap, for reading only.

## Source files

- `scripts/elo_joint.py` — the model and `DEFAULT_CONFIG`
- `scripts/joint_test.py` — frozen baseline, ledger, score, `FREEZE_DATE`
- `scripts/study_joint_skill.py` — everything under "What was already
  seen" (`_validation/joint_skill.md`)
- `scripts/validate_elo.py` `metric_joint_model` — prints the test's
  state every run
- `data/joint_test_ledger.json` — the logged predictions
- `critique/decisions/joint-skill-model.baseline.json` — baseline
  fingerprint
- `critique/decisions/balonce-meter-t-term.md` — why the commander's
  own fighting is carried here and not in the VSR-C ladder
- `.cursor/plans/vtsr_next-gen_analysis_4d5207d7.plan.md` — the analysis
- This memo

## Sign-off

Signed by the operator on 2026-11-25 at about 22:30 US Central, which is
2026-11-26 UTC. Match dates are UTC, so `FREEZE_DATE` is 2026-11-26 and
no game played before the sign-off can count. The newest match in the
corpus at signing is 2026-11-20.

Signed against the working tree on top of commit `186774707`: settings
hash `6b38185d5538c351`, baseline fingerprint `6684454654c9928e…`, looks
at 200, 300 and 400, pass at 2.0 standard errors. The preview line reads
"New model (in testing)".

Results are appended below at each look.

## Results

_(appended at each look)_
