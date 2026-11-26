"""VSR-T fairness harness: expected-score reference, late trim, low-tier lift.

Standalone and stdlib-only. Replays VSR-T in memory under the eight
combinations of three switches in scripts/elo.py and writes
`_validation/vtsr_t_fairness.{md,json}` (gitignored). Nothing under data/
is written.

    EXPECTED_REFERENCE_POOL            "lobby" | "opponents"
    ENEMY_DAMAGE_TRIM_LATE_STRUCTURE   False | True
    LOWTIER_LIFT_ENABLED               True | False

The control is always (lobby, no trim, lift on), the rules VSR-T ran on
until the interim revision. The candidate is (opponents, trim, lift off).
The five gates of critique/decisions/vtsr-t-interim-revision.md are
applied to the candidate against the control and printed.

    python scripts/study_vtsr_t_fairness.py
"""
from __future__ import annotations

import contextlib
import io
import itertools
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import elo  # noqa: E402
import elo_commander  # noqa: E402
import vtsr_t_variants as V  # noqa: E402

OUT_DIR = os.path.join(ROOT, "_validation")
FORWARD_SINCE = "2026-10-25"
REGULAR_MIN_MATCHES = 25

CONTROL = "lobby reference, no trim, lift on"
CANDIDATE = "opponents reference, trim, lift off"

# Gates (critique/decisions/vtsr-t-interim-revision.md).
GATE_SLOPE_SHARE = 0.5          # slope at most this share of the control's
GATE_SLOPE_MAX_Z = 2.0          # and within this many standard errors of 0
GATE_RESULT_SHARE = 0.75        # team-result share at most this share
GATE_TIER_DROP = 0.01           # tier ordering may fall by at most this
GATE_FORMULA_LL = 0.005         # today's win formula may worsen by at most this


def variants():
    out = []
    for pool, trim, lift in itertools.product(("lobby", "opponents"), (False, True), (True, False)):
        name = f"{pool} reference, {'trim' if trim else 'no trim'}, lift {'on' if lift else 'off'}"
        out.append({"name": name, "pool": pool, "trim": trim, "lift": lift})
    return out


@contextlib.contextmanager
def rules(v):
    saved = (elo.EXPECTED_REFERENCE_POOL, elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE,
             elo.LOWTIER_LIFT_ENABLED)
    try:
        elo.EXPECTED_REFERENCE_POOL = v["pool"]
        elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE = v["trim"]
        elo.LOWTIER_LIFT_ENABLED = v["lift"]
        yield
    finally:
        (elo.EXPECTED_REFERENCE_POOL, elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE,
         elo.LOWTIER_LIFT_ENABLED) = saved


def tier_of(rating):
    for i, edge in enumerate((2100, 1900, 1700, 1500, 1300)):
        if rating >= edge:
            return i
    return 5


def fairness_metrics(hist, meta):
    """Slope of (score - expectation) on the team gap, the share of a
    thug's score explained by the team result, and same-game tier order."""
    xs, ys, scores, wins = [], [], [], []
    tier_n = tier_ok = 0
    for h in hist["history"]:
        if h.get("match_excluded"):
            continue
        mm = meta.get(h["match_id"])
        if not mm:
            continue
        rows = []
        for d in h["deltas"]:
            is_cmdr, team = mm["rows"].get(str(d.get("steam64")), (False, None))
            if team in (1, 2) and d.get("before") is not None:
                rows.append((d, is_cmdr, team))
        thugs = [(d, t) for d, c, t in rows if not c]
        for (a, _ta), (b, _tb) in itertools.combinations(thugs, 2):
            ta, tb = tier_of(a["before"]), tier_of(b["before"])
            if ta != tb:
                hi, lo = (a, b) if ta < tb else (b, a)
                tier_n += 1
                tier_ok += int(hi["performance"] > lo["performance"])
        for d, team in thugs:
            mates = [x["before"] for x, _c, t in rows if t == team and x is not d]
            opps = [x["before"] for x, _c, t in rows if t != team]
            if not mates or not opps:
                continue
            xs.append((sum(mates) / len(mates) - sum(opps) / len(opps)) / 100.0)
            ys.append(d["performance"] - d["expected"])
            if mm["winner"] is not None:
                scores.append(d["performance"])
                wins.append(1 if team == mm["winner"] else 0)
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    resid = sum((y - my - slope * (x - mx)) ** 2 for x, y in zip(xs, ys))
    se = math.sqrt(resid / (n - 2) / sxx)
    gm = sum(scores) / len(scores)
    between = 0.0
    for w in (0, 1):
        grp = [s for s, ww in zip(scores, wins) if ww == w]
        if grp:
            between += len(grp) * (sum(grp) / len(grp) - gm) ** 2
    total = sum((s - gm) ** 2 for s in scores)
    return {"thug_rows": n, "gap_slope": slope, "gap_slope_se": se, "gap_slope_z": slope / se,
            "team_result_share": between / total if total else float("nan"),
            "tier_ordering": tier_ok / tier_n if tier_n else float("nan"), "tier_pairs": tier_n}


def formula_losses(cmdr_hist):
    """Per recorded duel: log-loss of the VSR-C expected score."""
    out = {}
    for d in cmdr_hist.get("duels") or []:
        if d.get("source") != "telemetry" or d.get("outcome") not in ("team1", "team2"):
            continue
        e = min(1 - 1e-9, max(1e-9, d["commanders"]["1"]["expected"]))
        y = 1.0 if d["outcome"] == "team1" else 0.0
        out[d["match_id"]] = (-(y * math.log(e) + (1 - y) * math.log(1 - e)), (e > 0.5) == (y == 1.0))
    return out


def band(r):
    return r.get("band_label") or f"Tier {r.get('band_tier')}"


def main():
    all_md = V.load_matches()
    meta = V.match_meta(all_md)
    cgap = V.commander_gaps()
    with open(os.path.join(ROOT, "data", "external", "f9_ledger.json"), encoding="utf-8") as f:
        ledger = json.load(f)
    f9 = ledger.get("duels") or []
    overlap = frozenset(o.get("match_id") for o in (ledger.get("overlaps") or []) if o.get("match_id"))

    runs = {}
    for v in variants():
        with rules(v):
            cur, hist = elo.compute_elo(all_md, external_duels=f9)
        with contextlib.redirect_stdout(io.StringIO()):
            ccur, chist = elo_commander.compute_commander_elo(
                all_md, hist, external_duels=f9, external_overlap_ids=overlap)
        runs[v["name"]] = (cur, hist, ccur, chist)
        print(f"replayed: {v['name']}", flush=True)

    base_cur, _bh, base_ccur, base_chist = runs[CONTROL]
    base_loss = formula_losses(base_chist)
    base_r = {r["steam64"]: r for r in base_cur["ratings"]}
    regulars = [k for k, r in base_r.items() if r["matches_played"] >= REGULAR_MIN_MATCHES]
    base_c = {r["steam64"]: r for r in base_ccur["ratings"]}
    cmdrs = [k for k, r in base_c.items() if (r.get("matches_commanded_rated") or 0) >= 15]

    summary = {}
    for name, (cur, hist, ccur, chist) in runs.items():
        s = fairness_metrics(hist, meta)
        recs = V.decided_records(hist, meta, cgap)
        full = V.outcome_metrics(recs[V.WARMUP_MATCHES:])
        fwd_recs = [r for r in recs if r["date"][:10] >= FORWARD_SINCE]
        fwd = V.outcome_metrics(fwd_recs) if fwd_recs else {"auc": float("nan"), "n": 0}
        s["reliability"] = V.reliability(hist, meta)["spearman_brown"]
        s["winner_auc"] = full["auc"]
        s["winner_auc_forward"] = fwd["auc"]
        s["forward_matches"] = fwd["n"]
        s["gain_over_commanders"] = full["ll_gain_over_commanders"]
        loss = formula_losses(chist)
        ids = [k for k in base_loss if k in loss]
        diffs = [loss[k][0] - base_loss[k][0] for k in ids]
        m = sum(diffs) / len(diffs)
        sd = math.sqrt(sum((d - m) ** 2 for d in diffs) / (len(diffs) - 1)) if len(diffs) > 1 else 0.0
        s["formula_log_loss"] = sum(loss[k][0] for k in ids) / len(ids)
        s["formula_accuracy"] = sum(1 for k in ids if loss[k][1]) / len(ids)
        s["formula_log_loss_vs_control"] = m
        s["formula_log_loss_vs_control_se"] = sd / math.sqrt(len(diffs))
        s["recorded_duels"] = len(ids)
        rv = {r["steam64"]: r for r in cur["ratings"]}
        moves = sorted(((rv[k]["vtsr"] - base_r[k]["vtsr"], base_r[k]["name"], k) for k in regulars if k in rv))
        s["regulars"] = len(moves)
        s["half_band_changes"] = sum(1 for _d, _n, k in moves if band(rv[k]) != band(base_r[k]))
        s["tier_changes"] = sum(1 for _d, _n, k in moves if rv[k].get("band_tier") != base_r[k].get("band_tier"))
        s["mean_abs_move"] = sum(abs(d) for d, _n, _k in moves) / len(moves) if moves else 0.0
        s["moves"] = [{"name": n, "control": round(base_r[k]["vtsr"], 1), "variant": round(rv[k]["vtsr"], 1),
                       "change": round(d, 1), "control_band": band(base_r[k]), "variant_band": band(rv[k])}
                      for d, n, k in moves]
        s["lift_recipients"] = sum(1 for r in cur["ratings"]
                                   if (r.get("lowtier_lift_factor") or 0) > 0 and r["matches_played"] >= 10)
        cv = {r["steam64"]: r for r in ccur["ratings"]}
        cm = [abs(cv[k]["vtsr_c"] - base_c[k]["vtsr_c"]) for k in cmdrs if k in cv]
        s["vsr_c_mean_abs_move"] = sum(cm) / len(cm) if cm else 0.0
        s["vsr_c_max_abs_move"] = max(cm) if cm else 0.0
        s["vsr_c_commanders"] = len(cm)
        summary[name] = s

    c, k = summary[CONTROL], summary[CANDIDATE]
    gates = [
        {"gate": "team-gap slope at most half of the control's and within 2 SE of zero",
         "control": round(c["gap_slope"], 4), "candidate": round(k["gap_slope"], 4),
         "passed": abs(k["gap_slope"]) <= GATE_SLOPE_SHARE * abs(c["gap_slope"])
                   and abs(k["gap_slope_z"]) < GATE_SLOPE_MAX_Z},
        {"gate": "team-result share down by a quarter or more",
         "control": round(c["team_result_share"], 3), "candidate": round(k["team_result_share"], 3),
         "passed": k["team_result_share"] <= GATE_RESULT_SHARE * c["team_result_share"]},
        {"gate": "split-half reliability not lower",
         "control": round(c["reliability"], 3), "candidate": round(k["reliability"], 3),
         "passed": k["reliability"] >= c["reliability"]},
        {"gate": "same-game tier ordering not lower by more than 1 point",
         "control": round(c["tier_ordering"], 3), "candidate": round(k["tier_ordering"], 3),
         "passed": k["tier_ordering"] >= c["tier_ordering"] - GATE_TIER_DROP},
        {"gate": "today's win formula not worse by more than 0.005 log-loss",
         "control": round(c["formula_log_loss"], 4), "candidate": round(k["formula_log_loss"], 4),
         "passed": k["formula_log_loss_vs_control"] <= GATE_FORMULA_LL},
    ]
    verdict = "PASS" if all(g["passed"] for g in gates) else "FAIL"
    live = {"pool": elo.EXPECTED_REFERENCE_POOL, "trim": elo.ENEMY_DAMAGE_TRIM_LATE_STRUCTURE,
            "lift": elo.LOWTIER_LIFT_ENABLED}
    report = {"control": CONTROL, "candidate": CANDIDATE, "live_rules": live,
              "rated_matches": sum(1 for h in runs[CONTROL][1]["history"] if not h.get("match_excluded")),
              "gates": gates, "verdict": verdict, "summary": summary}

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "vtsr_t_fairness.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    L = ["# VSR-T fairness harness", "",
         f"{report['rated_matches']} rated matches, {c['thug_rows']} thug rows, {c['recorded_duels']} recorded duels. "
         f"Control: {CONTROL}. Candidate: {CANDIDATE}.", "",
         f"## Gates: **{verdict}**", "", "| Gate | Control | Candidate | Result |", "|---|---|---|---|"]
    for g in gates:
        L.append(f"| {g['gate']} | {g['control']} | {g['candidate']} | {'pass' if g['passed'] else 'FAIL'} |")
    L += ["", "## All eight variants", "",
          "| Variant | Gap slope (z) | Team-result share | Reliability | Tier ordering | Winner AUC (all / forward) "
          "| Gain over commanders | Win formula log-loss (vs control ± SE) | Regulars: half-band / tier changes | Lift recipients |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for name, s in summary.items():
        L.append(f"| {name} | {s['gap_slope']:+.4f} ({s['gap_slope_z']:+.1f}) | {s['team_result_share']:.3f} "
                 f"| {s['reliability']:.3f} | {s['tier_ordering']:.3f} | {s['winner_auc']:.3f} / {s['winner_auc_forward']:.3f} "
                 f"| {s['gain_over_commanders']:.2f} | {s['formula_log_loss']:.4f} ({s['formula_log_loss_vs_control']:+.4f} ± "
                 f"{s['formula_log_loss_vs_control_se']:.4f}) | {s['half_band_changes']} / {s['tier_changes']} of {s['regulars']} "
                 f"| {s['lift_recipients']} |")
    L += ["", f"Forward window: {c['forward_matches']} decided matches since {FORWARD_SINCE}.",
          f"VSR-C under the candidate: commanders with 15+ duels move {k['vsr_c_mean_abs_move']:.1f} points on average, "
          f"{k['vsr_c_max_abs_move']:.1f} at most ({k['vsr_c_commanders']} commanders).", "",
          f"## Regulars under the candidate ({REGULAR_MIN_MATCHES}+ rated matches)", "",
          "| Player | Control | Candidate | Change | Control band | Candidate band |", "|---|---|---|---|---|---|"]
    for m in k["moves"]:
        flag = "" if m["control_band"] == m["variant_band"] else " **"
        L.append(f"| {m['name']} | {m['control']:.0f} | {m['variant']:.0f} | {m['change']:+.0f} "
                 f"| {m['control_band']} | {m['variant_band']}{flag} |")
    with open(os.path.join(OUT_DIR, "vtsr_t_fairness.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L) + "\n")

    for g in gates:
        print(f"[{'pass' if g['passed'] else 'FAIL'}] {g['gate']}: {g['control']} -> {g['candidate']}")
    print(f"gates: {verdict}")
    print(f"wrote {os.path.join(OUT_DIR, 'vtsr_t_fairness.md')}")
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
