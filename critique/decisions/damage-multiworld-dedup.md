# Damage multi-world duplication (evidence)

## What was measured

`record_damage` in the statsgate collector had no `curWorld != 0` guard until commit `103284d` (2026-08-30). Before that, each in-game damage event was written once per game world.

On the raw wire, per weapon, `r = (player-vs-player DamageDealt events) / (player-vs-player BulletHits)`:

- Post-fix v4: r = 1.000. One `BulletHit` lines up with one `DamageDealt` of the same ordnance. Chain gun, slicer, shell gun, minigun, lockdown and plasma ball all sat on that line in the sampled matches.
- Pre-fix (v1 and v2): r is about 2.15, and the same factor shows up on every weapon in a match. Per-event amounts do not change across the eras (a chain-gun pellet is still 11, a plasma ball 100/80). The extra rows are duplicates, not a different damage model.

Plasma Stream is not a special case. Certified Bad Guy on Amino (`2026-04-29T01-23-55`) recorded 14 stream hits and a damage-event ratio inside the lobby's ~2.2 band. The 75,075 damage is duplicated damage events, most of them against non-humans, not 14 enormous hits.

## What the pipeline does with it

`match.event_calibration.damage_scale` is `1 / r_lobby` when `r_lobby >= 1.5`, else 1. The scale is applied to both sides of each damage event after the sentinel filter, and to the timeline recompute. Lobby-relative rating axes see both teams scaled by the same match factor. Absolute totals (career damage, damage per minute, highlight values) were inflated by about 2.15x on the 132 matches recorded before 2026-08-30 (all of v1, v2, and v3).

Matches with no usable BulletHit reference, and the three slot-credited 2026-04-16 recordings (`d72eb40`, missing `IsPlayer`), use `DAMAGE_DUP_FALLBACK_R = 2.15`. Proto v4 with no reference uses 1.0.

## The three slot-credited recordings (`PIPELINE_VERSION` 64)

The `d72eb40` build credited every unit on a team slot to that slot's player in `BulletInit` and `BulletHit`. A hit on a commander's Scavenger counted as a PvP hit on him, and his Turret's fire counted as his. Damage events were attributed correctly. Since v64, `_repair_slot_credited_events()` in `scripts/process_stats.py` returns those shots and hits to the AI before calibration (`SLOT_CREDITED_MATCHES`).

Measured on the repaired hits, the in-match r is 2.149, 2.137 and 2.101, against 0.898, 0.687 and 0.333 before the repair. The repaired hits therefore line up with the rest of the duplication era. The fallback stays in use for these three, so no damage figure moved; the in-match value is within 2.3% of it. Their non-human hits are on the wire, so `hits_est_source` is `wire`. Gate: `_investigation/golden_slot_credit_inert.py`.

## What this does not do

It does not invent `BulletHit` rows. Non-human hits are a separate reconstruction (`pve_hits_est = damage events against non-humans / r`), capped by rounds fired. See `critique/decisions/accuracy-recon-axis.md` for whether that reconstruction may re-enter VTSR-T.
