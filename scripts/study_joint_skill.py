"""Study script for the joint commanding-and-fighting model.

Standalone, read-only on data/. Writes `_validation/joint_skill.{md,json}`
(gitignored). Everything `critique/decisions/joint-skill-model.md` quotes
comes from here, so the memo's numbers can be reproduced with one command:

    python scripts/study_joint_skill.py            # full run, about 12 minutes
    python scripts/study_joint_skill.py --quick    # back-test only, about 2 minutes

Sections:
  1. Noise table (the values frozen in elo_joint.DEFAULT_CONFIG).
  2. Back-test of the frozen configuration against today's win formula,
     the fixed-skill fit, exponential decay and old games counted less.
  3. Configuration check: the frozen settings against declared neighbours,
     paired and out of sample. A neighbour ahead by more than two standard
     errors blocks the memo's sign-off.
  4. Does skill change over time: early-against-late shifts and backward
     prediction of old F9 games.
  5. Switch-test threshold for three looks, by resampling sessions.
  6. Largest gaps between results and damage per regular.

Back-test windows are counted in recorded duels so they do not move as the
corpus grows: scoring starts after the first 40 recorded duels, and the
"late window" starts at recorded duel 147.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import elo_joint as J  # noqa: E402

PROCESSED = os.path.join(ROOT, "data", "processed")
OUT_DIR = os.path.join(ROOT, "_validation")

WARMUP_RECORDED = 40
LATE_WINDOW_RECORDED = 146
LOOKS = (200, 300, 400)
RESAMPLES = 40000
SEED = 20261125
REGULAR_MIN_RECORDED = 20

NEIGHBOURS = [
    ("damage loading 0.10", {"beta": 0.10}),
    ("damage loading 0.14", {"beta": 0.14}),
    ("commanding spread 0.5", {"tau_c": 0.5}),
    ("commanding spread 1.0", {"tau_c": 1.0}),
    ("fighting spread 1.5", {"tau_f": 1.5}),
    ("fighting spread 2.5", {"tau_f": 2.5}),
    ("steps halved", {"step_c_year": 0.055, "step_f_year": 0.4}),
    ("steps doubled", {"step_c_year": 0.22, "step_f_year": 1.6}),
    ("half-year blocks", {"block_months": 6}),
    ("two-month blocks", {"block_months": 2}),
]


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def load_json(name):
    with open(os.path.join(PROCESSED, name), encoding="utf-8") as f:
        return json.load(f)


def load_corpus():
    all_md = []
    for entry in load_json("matches.json"):
        path = os.path.join(PROCESSED, entry["file"])
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                all_md.append(json.load(f))
    elo_history = load_json("elo_history.json")
    cmdr_history = load_json("elo_commander_history.json")
    with open(os.path.join(ROOT, "data", "external", "f9_ledger.json"), encoding="utf-8") as f:
        ledger = json.load(f)
    return all_md, elo_history, cmdr_history, ledger.get("duels") or []


def todays_expected(cmdr_history, duels):
    """Today's win formula for each duel, from the commander history."""
    by_key = {}
    for d in cmdr_history.get("duels") or []:
        c1 = (d.get("commanders") or {}).get("1") or {}
        by_key[(d.get("match_id") or "", d.get("external_row"))] = c1.get("expected")
    out = np.array([by_key.get((d["match_id"], d["external_row"]), np.nan) for d in duels], float)
    return np.clip(out, 1e-9, 1 - 1e-9)


# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------

class Windows:
    def __init__(self, duels):
        self.tele = np.array([d["source"] == "telemetry" for d in duels])
        tidx = np.where(self.tele)[0]
        self.n = len(duels)
        self.start = int(tidx[0])
        self.score_from = int(tidx[WARMUP_RECORDED])
        self.late_from = int(tidx[LATE_WINDOW_RECORDED])
        self.y = np.array([d["y"] for d in duels], float)

    def index(self, lo, hi=None):
        hi = self.n if hi is None else hi
        return np.arange(lo, hi)[self.tele[lo:hi]]

    def losses(self, p, lo, hi=None):
        ii = self.index(lo, hi)
        pp = np.clip(p[ii], 1e-9, 1 - 1e-9)
        return -(self.y[ii] * np.log(pp) + (1 - self.y[ii]) * np.log(1 - pp))

    def score(self, p, lo, hi=None):
        ii = self.index(lo, hi)
        pp = np.clip(p[ii], 1e-9, 1 - 1e-9)
        ll = self.losses(p, lo, hi)
        return {"n": int(len(ii)), "log_loss": float(ll.mean()),
                "accuracy": float(((pp > 0.5) == (self.y[ii] == 1)).mean())}

    def summary(self, p):
        return {"early": self.score(p, self.score_from, self.late_from),
                "late": self.score(p, self.late_from),
                "all": self.score(p, self.score_from)}

    def paired(self, p, ref, lo=None, hi=None):
        lo = self.score_from if lo is None else lo
        d = self.losses(p, lo, hi) - self.losses(ref, lo, hi)
        return {"mean": float(d.mean()), "se": float(d.std(ddof=1) / math.sqrt(len(d))),
                "n": int(len(d))}


def logistic_fit(X, y, offset=None, iters=60):
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    off = np.zeros(len(y)) if offset is None else np.asarray(offset, float)
    b = np.zeros(X.shape[1])
    H = np.eye(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(off + X @ b, -30, 30)))
        H = (X * (p * (1 - p))[:, None]).T @ X + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (y - p))
        b += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return b, np.sqrt(np.diag(np.linalg.inv(H)))


def chi2_sf(x, k):
    """Upper tail of chi-square with k degrees of freedom (series form)."""
    if x <= 0:
        return 1.0
    a, xx = k / 2.0, x / 2.0
    if xx < a + 1:
        term = total = 1.0 / a
        n = a
        for _ in range(500):
            n += 1
            term *= xx / n
            total += term
            if abs(term) < abs(total) * 1e-12:
                break
        return max(0.0, 1.0 - total * math.exp(-xx + a * math.log(xx) - math.lgamma(a)))
    tiny = 1e-300
    bb = xx + 1 - a
    c = 1 / tiny
    d = 1 / bb
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        bb += 2
        d = an * d + bb
        d = tiny if abs(d) < tiny else d
        c = bb + an / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return min(1.0, math.exp(-xx + a * math.log(xx) - math.lgamma(a)) * h)


def with_config(**changes):
    cfg = json.loads(json.dumps(J.DEFAULT_CONFIG))
    cfg.update(changes)
    return cfg


def strip_damage(duels):
    out = []
    for d in duels:
        c = dict(d)
        c["blocks"] = []
        out.append(c)
    return out


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def section_noise(duels, win):
    fresh = J.calibrate_noise(duels)
    before_late = J.calibrate_noise(duels, win.late_from)
    frozen = J.DEFAULT_CONFIG["noise"]

    def flat(nz):
        return ([nz["thug"][k] for k in ("2", "3", "4")]
                + [nz["cmdr"][k] for k in ("2", "3", "4")] + [nz["cmdr_all"]]
                + list(nz["thug_length"]) + list(nz["cmdr_length"]))

    gap = max(abs(a - b) for a, b in zip(flat(fresh), flat(frozen)))
    per_thug = {k: round(fresh["thug"][k] / math.sqrt((int(k) - 1) / int(k)), 4)
                for k in ("2", "3", "4")}
    return {"all_recorded": fresh, "before_late_window": before_late, "frozen": frozen,
            "per_thug_before_centring": per_thug,
            "max_gap_frozen_vs_all_recorded": round(gap, 4)}


def section_backtest(duels, win, e_today, noise, quick):
    out = {}
    t0 = time.time()
    frozen = J.Design(duels, noise=noise)
    p_frozen, _, _ = J.walk_forward(frozen, win.start, final_fit=False)
    out["frozen"] = {"label": "Frozen configuration (quarterly steps)",
                     "parameters": frozen.NP, "damage_rows": int(len(frozen.v)),
                     "seconds": round(time.time() - t0, 1), **win.summary(p_frozen)}
    out["today"] = {"label": "Today's win formula", **win.summary(e_today),
                    "vs_frozen": win.paired(e_today, p_frozen),
                    "vs_frozen_late": win.paired(e_today, p_frozen, win.late_from)}
    preds = {"frozen": p_frozen, "today": e_today}

    static_cfg = with_config(block_months=0)
    static = J.Design(duels, static_cfg, noise=noise)

    def add(key, label, p):
        preds[key] = p
        out[key] = {"label": label, **win.summary(p),
                    "vs_frozen": win.paired(p, p_frozen),
                    "vs_frozen_late": win.paired(p, p_frozen, win.late_from)}

    p, _, _ = J.walk_forward(static, win.start, final_fit=False)
    add("fixed_skill", "Fixed skill (one block for all time)", p)
    if not quick:
        p, _, _ = J.walk_forward(J.Design(strip_damage(duels), static_cfg), win.start, final_fit=False)
        add("results_only", "Fixed skill, results only (no damage rows)", p)
        for days in (730, 365, 180):
            p, _, _ = J.walk_forward(static, win.start, decay_days=float(days), final_fit=False)
            add(f"decay_{days}", f"Fixed skill, exponential decay over {days} days", p)
        f9 = np.array([0.0 if t else 1.0 for t in win.tele])
        pre = np.array([1.0 if i < win.start else 0.0 for i in range(win.n)])
        for key, label, w in (
            ("f9_half", "Fixed skill, F9 games at half weight", 1 - 0.5 * f9),
            ("pre_half", "Fixed skill, games before recording at half weight", 1 - 0.5 * pre),
            ("pre_dropped", "Fixed skill, games before recording dropped", 1 - pre),
        ):
            p, _, _ = J.walk_forward(static, win.start, result_weights=w, final_fit=False)
            add(key, label, p)
    return out, preds


def section_neighbours(duels, win, noise, p_frozen):
    rows = []
    for label, change in NEIGHBOURS:
        t0 = time.time()
        design = J.Design(duels, with_config(**change), noise=noise)
        p, _, _ = J.walk_forward(design, win.start, final_fit=False)
        pair = win.paired(p, p_frozen)
        z = pair["mean"] / pair["se"] if pair["se"] > 0 else 0.0
        rows.append({"label": label, "change": change, **win.summary(p),
                     "vs_frozen": pair, "vs_frozen_late": win.paired(p, p_frozen, win.late_from),
                     "z": round(z, 2), "seconds": round(time.time() - t0, 1)})
        print(f"   neighbour {label}: {pair['mean']:+.4f} (SE {pair['se']:.4f})", flush=True)
    ahead = [r for r in rows if r["z"] < -2.0]
    return {"rows": rows, "blocking": [r["label"] for r in ahead],
            "verdict": "BLOCKED" if ahead else "CLEAR"}


def section_time(duels, win, noise, e_today):
    static_cfg = with_config(block_months=0)
    design = J.Design(duels, static_cfg, noise=noise)
    G, b = J.damage_information(design)
    theta, _, _ = J.fit(design, design.n, np.zeros(design.NP), G, b)
    names = {}
    for d in duels:
        names.update(d["names"])
    out = {}

    # Thugs: early against late half of the recorded era, damage residuals.
    resid = design.v - design.A @ theta
    per = {}
    for (kind, key, i, _team), r in zip(design.row_meta, resid):
        if kind == "thug":
            per.setdefault(key, []).append((design.days[i], float(r)))
    mid = float(np.median([day for rows in per.values() for day, _ in rows]))
    shifts = []
    for key, rows in per.items():
        early = [r for day, r in rows if day < mid]
        late = [r for day, r in rows if day >= mid]
        if len(early) >= 12 and len(late) >= 12:
            sh = float(np.mean(late) - np.mean(early))
            se = math.sqrt(np.var(late, ddof=1) / len(late) + np.var(early, ddof=1) / len(early))
            shifts.append((sh, se, names.get(key, key)))
    if shifts:
        sh = np.array([s[0] for s in shifts])
        se = np.array([s[1] for s in shifts])
        chi = float(np.sum((sh / se) ** 2))
        beta = float(static_cfg["beta"])
        out["thug_shift"] = {
            "players": len(shifts), "chi_square": round(chi, 1),
            "p_value": round(chi2_sf(chi, len(shifts)), 4),
            "real_spread_skill_units": round(
                math.sqrt(max(0.0, sh.var(ddof=1) - float(np.mean(se ** 2)))) / beta, 3),
            "largest": [{"name": n, "shift_skill_units": round(s / beta, 3), "z": round(s / e, 1)}
                        for s, e, n in sorted(shifts, key=lambda t: -abs(t[0] / t[1]))[:6]],
        }

    # Commanders: late half against early half of their own duels.
    pfit = 1 / (1 + np.exp(-np.clip(design.X @ theta, -30, 30)))
    perc = {}
    for i, d in enumerate(duels):
        info = pfit[i] * (1 - pfit[i])
        perc.setdefault(d["c"][0], []).append((design.y[i] - pfit[i], info))
        perc.setdefault(d["c"][1], []).append((-(design.y[i] - pfit[i]), info))
    zs = []
    for key, rows in perc.items():
        if len(rows) < 40:
            continue
        h = len(rows) // 2
        e1, v1 = sum(r[0] for r in rows[:h]), sum(r[1] for r in rows[:h])
        e2, v2 = sum(r[0] for r in rows[h:]), sum(r[1] for r in rows[h:])
        zs.append(((e2 / v2 - e1 / v1) / math.sqrt(1 / v1 + 1 / v2), names.get(key, key)))
    if zs:
        chi = float(sum(z * z for z, _ in zs))
        out["commander_shift"] = {"commanders": len(zs), "chi_square": round(chi, 1),
                                  "p_value": round(chi2_sf(chi, len(zs)), 3)}

    # Backward prediction: skills from recorded-era games only, used on
    # earlier F9 games that were not in the fit.
    w = np.array([0.0 if i < win.start else 1.0 for i in range(win.n)])
    th_late, _, _ = J.fit(design, design.n, np.zeros(design.NP), G, b, w)
    nc = design.nc
    g_c = design.X[:, :nc] @ th_late[:nc]
    g_f = design.X[:, nc:nc + design.nt] @ th_late[nc:nc + design.nt]
    first_recorded = duels[win.start]["date"]
    periods = [("2025 Jan-Jun", "2025-01-01", "2025-07-01"),
               ("2025 Jul-Dec", "2025-07-01", "2026-01-01"),
               ("2026 until recording began", "2026-01-01", first_recorded)]
    rows = []
    for label, lo, hi in periods:
        ix = np.array([i for i in range(win.start) if lo <= duels[i]["date"] < hi], int)
        if len(ix) < 20:
            continue
        yy = design.y[ix]
        tot = (g_c + g_f)[ix]
        b1, s1 = logistic_fit(tot[:, None], yy)
        b2, s2 = logistic_fit(np.column_stack([g_c[ix], g_f[ix]]), yy)
        rows.append({"period": label, "n": int(len(ix)),
                     "slope": round(float(b1[0]), 2), "slope_se": round(float(s1[0]), 2),
                     "commander_part": round(float(b2[0]), 2), "commander_se": round(float(s2[0]), 2),
                     "fighter_part": round(float(b2[1]), 2), "fighter_se": round(float(s2[1]), 2),
                     "calls": round(float(((tot > 0) == (yy == 1)).mean()), 3)})
    out["backward_prediction"] = {"fitted_on_games_from": first_recorded, "periods": rows}
    return out


def section_switch_test(duels, win, p_frozen, e_today):
    gains = win.losses(e_today, win.score_from) - win.losses(p_frozen, win.score_from)
    late = win.losses(e_today, win.late_from) - win.losses(p_frozen, win.late_from)
    ii = win.index(win.score_from)
    stamps = [datetime.strptime(duels[i]["match_id"], "%Y-%m-%dT%H-%M-%S") for i in ii]
    sess = np.zeros(len(ii), int)
    for k in range(1, len(ii)):
        gap = (stamps[k] - stamps[k - 1]).total_seconds()
        sess[k] = sess[k - 1] + (1 if gap > 6 * 3600 else 0)
    groups = [np.where(sess == s)[0] for s in range(int(sess.max()) + 1)]
    rng = np.random.default_rng(SEED)
    centred = gains - gains.mean()
    top = max(LOOKS)
    mean = np.zeros((RESAMPLES, len(LOOKS)))
    se = np.zeros((RESAMPLES, len(LOOKS)))
    for r in range(RESAMPLES):
        parts, n = [], 0
        while n < top:
            g = groups[rng.integers(len(groups))]
            parts.append(g)
            n += len(g)
        x = centred[np.concatenate(parts)[:top]]
        c1, c2 = np.cumsum(x), np.cumsum(x * x)
        for j, look in enumerate(LOOKS):
            m = c1[look - 1] / look
            mean[r, j] = m
            se[r, j] = math.sqrt(max((c2[look - 1] - look * m * m) / (look - 1), 1e-12) / look)
    threshold = float(np.quantile(np.max(mean / se, axis=1), 0.95))

    def pass_rate(delta, c):
        return float(np.mean(np.any((mean + delta) / se >= c, axis=1)))

    slope_x = np.log(np.clip(p_frozen[ii], 1e-9, 1 - 1e-9) / np.clip(1 - p_frozen[ii], 1e-9, 1))
    b_j, s_j = logistic_fit(np.column_stack([np.ones(len(ii)), slope_x]), win.y[ii])
    slope_t = np.log(e_today[ii] / (1 - e_today[ii]))
    b_t, s_t = logistic_fit(np.column_stack([np.ones(len(ii)), slope_t]), win.y[ii])
    fav = np.maximum(p_frozen[ii], 1 - p_frozen[ii])
    won = np.where(p_frozen[ii] >= 0.5, win.y[ii], 1 - win.y[ii])
    bands = []
    for lo, hi in ((0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.01)):
        m = (fav >= lo) & (fav < hi)
        if m.any():
            bands.append({"band": f"{int(lo * 100)}-{min(100, int(hi * 100))}%", "n": int(m.sum()),
                          "stated": round(float(fav[m].mean()), 3), "won": round(float(won[m].mean()), 3)})
    dis = np.abs(p_frozen[ii] - e_today[ii])
    return {
        "recorded_duels": int(len(gains)), "sessions": len(groups),
        "gain_mean": round(float(gains.mean()), 4),
        "gain_se": round(float(gains.std(ddof=1) / math.sqrt(len(gains))), 4),
        "gain_sd": round(float(gains.std(ddof=1)), 3),
        "gain_late_mean": round(float(late.mean()), 4),
        "gain_late_se": round(float(late.std(ddof=1) / math.sqrt(len(late))), 4),
        "looks": list(LOOKS),
        "threshold_for_5pct_false_pass": round(threshold, 2),
        "false_pass_at_2_0": round(pass_rate(0.0, 2.0), 3),
        "pass_rate_at_2_0": {f"{d:.3f}": round(pass_rate(d, 2.0), 3) for d in (0.02, 0.03, 0.04, 0.05)},
        "smallest_passing_gain": [round(2.0 * float(np.median(se[:, j])), 3) for j in range(len(LOOKS))],
        "withdrawal_rate_at_2_0": {f"{d:+.3f}": round(float(np.mean(np.any(-(mean + d) / se >= 2.0, axis=1))), 3)
                                   for d in (0.0, -0.03, -0.05)},
        "calibration_slope": {"joint": [round(float(b_j[1]), 2), round(float(s_j[1]), 2)],
                              "today": [round(float(b_t[1]), 2), round(float(s_t[1]), 2)]},
        "favourites": bands,
        "differs_by_10_points": round(float((dis >= 0.10).mean()), 3),
        "different_favourite": round(float(((p_frozen[ii] > 0.5) != (e_today[ii] > 0.5)).mean()), 3),
    }


def section_gaps(duels, noise):
    """Results-only fighting skill against the full model's, per regular."""
    static_cfg = with_config(block_months=0)
    full = J.Design(duels, static_cfg, noise=noise)
    G, b = J.damage_information(full)
    th_full, _, _ = J.fit(full, full.n, np.zeros(full.NP), G, b)
    bare = J.Design(strip_damage(duels), static_cfg)
    th_res, H_res, _ = J.fit(bare, bare.n, np.zeros(bare.NP), np.zeros((bare.NP, bare.NP)), np.zeros(bare.NP))
    cov = np.linalg.inv(H_res)
    recorded, names = {}, {}
    for d in duels:
        names.update(d["names"])
        if d["source"] == "telemetry":
            for side in (1, 2):
                for k in J.fighters(d, side):
                    recorded[k] = recorded.get(k, 0) + 1
    rows = []
    for k, n in recorded.items():
        if n < REGULAR_MIN_RECORDED:
            continue
        j_res, j_full = bare.f_col(k, 0), full.f_col(k, 0)
        gap = float(th_res[j_res] - th_full[j_full])
        sd = math.sqrt(max(cov[j_res, j_res], 1e-12))
        rows.append({"name": names.get(k, k), "recorded_games": n,
                     "results_only": round(float(th_res[j_res]), 3),
                     "with_damage": round(float(th_full[j_full]), 3),
                     "gap": round(gap, 3), "gap_sd": round(sd, 3), "z": round(gap / sd, 2)})
    rows.sort(key=lambda r: -r["z"])
    return {"regulars": len(rows), "more_impact_than_damage": rows[:6],
            "less_impact_than_damage": rows[-6:][::-1]}


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def fmt_row(r):
    a = r["all"]
    cells = [r["label"], f"{a['log_loss']:.4f}", f"{a['accuracy'] * 100:.1f}%",
             f"{r['late']['log_loss']:.4f}"]
    v = r.get("vs_frozen")
    cells.append(f"{v['mean']:+.4f} ± {v['se']:.4f}" if v else "reference")
    return "| " + " | ".join(cells) + " |"


def write_report(rep):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "joint_skill.json"), "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=2)
    L = ["# Joint commanding-and-fighting model: study", "",
         f"Config hash `{rep['config_hash']}`. {rep['games']} games "
         f"({rep['recorded']} recorded), through {rep['through']}.",
         f"Scored on the {rep['backtest']['frozen']['all']['n']} recorded duels after the first "
         f"{WARMUP_RECORDED}; late window = the last {rep['backtest']['frozen']['late']['n']}.", ""]
    nz = rep["noise"]
    L += ["## 1. Noise table", "",
          f"Per-thug noise before centring, by thugs on the team (2 / 3 / 4+): "
          f"{nz['per_thug_before_centring']['2']} / {nz['per_thug_before_centring']['3']} / "
          f"{nz['per_thug_before_centring']['4']}.",
          f"Commander rows: {nz['all_recorded']['cmdr']}. Length multipliers (thug): "
          f"{nz['all_recorded']['thug_length']}; (commander): {nz['all_recorded']['cmdr_length']}.",
          f"Largest gap between the frozen table and a fresh one on all recorded duels: "
          f"{nz['max_gap_frozen_vs_all_recorded']}.", ""]
    L += ["## 2. Back-test", "",
          "| Model | Log-loss | Winners called | Late-window log-loss | Log-loss vs frozen (± SE) |",
          "|---|---|---|---|---|"]
    for key in rep["backtest"]:
        L.append(fmt_row(rep["backtest"][key]))
    L.append("")
    if rep.get("neighbours"):
        nb = rep["neighbours"]
        L += ["## 3. Configuration check", "",
              f"Verdict: **{nb['verdict']}**" + (f" ({', '.join(nb['blocking'])})" if nb["blocking"] else "") + ".", "",
              "| Neighbour | Log-loss | Winners called | Late-window log-loss | Log-loss vs frozen (± SE) |",
              "|---|---|---|---|---|"]
        L += [fmt_row(r) for r in nb["rows"]]
        L.append("")
    if rep.get("time"):
        t = rep["time"]
        L += ["## 4. Does skill change over time", ""]
        if "thug_shift" in t:
            s = t["thug_shift"]
            L.append(f"- Thugs, early against late half of the recorded era: {s['players']} players, "
                     f"chi-square {s['chi_square']} (p = {s['p_value']}), real spread "
                     f"{s['real_spread_skill_units']} skill units. Largest: "
                     + ", ".join(f"{x['name']} {x['shift_skill_units']:+.2f} (z {x['z']:+.1f})" for x in s["largest"][:4]) + ".")
        if "commander_shift" in t:
            s = t["commander_shift"]
            L.append(f"- Commanders with 40+ duels, late against early results: {s['commanders']} commanders, "
                     f"chi-square {s['chi_square']} (p = {s['p_value']}).")
        L += ["", f"Backward prediction (skills fitted on games from {t['backward_prediction']['fitted_on_games_from']} only):", "",
              "| Period | Games | Slope | Commander part | Fighter part | Winners called |", "|---|---|---|---|---|---|"]
        for r in t["backward_prediction"]["periods"]:
            L.append(f"| {r['period']} | {r['n']} | {r['slope']} ± {r['slope_se']} | {r['commander_part']} ± {r['commander_se']} "
                     f"| {r['fighter_part']} ± {r['fighter_se']} | {r['calls'] * 100:.1f}% |")
        L.append("")
    if rep.get("switch_test"):
        s = rep["switch_test"]
        L += ["## 5. Switch test", "",
              f"- Per-duel gain over today's formula: {s['gain_mean']} ± {s['gain_se']} on {s['recorded_duels']} duels "
              f"({s['sessions']} sessions, SD {s['gain_sd']}); late window {s['gain_late_mean']} ± {s['gain_late_se']}.",
              f"- Looks at {s['looks']}: a 5% false-pass rate needs {s['threshold_for_5pct_false_pass']} standard errors; "
              f"at 2.0 the false-pass rate is {s['false_pass_at_2_0'] * 100:.1f}%.",
              "- Pass rate at 2.0 by true gain: " + ", ".join(f"{k}: {v * 100:.0f}%" for k, v in s["pass_rate_at_2_0"].items()) + ".",
              f"- Smallest mean gain that passes at each look: {s['smallest_passing_gain']}.",
              "- Withdrawal (behind by 2.0 SE at a look) by true gain: "
              + ", ".join(f"{k}: {v * 100:.0f}%" for k, v in s["withdrawal_rate_at_2_0"].items()) + ".",
              f"- Calibration slope: joint {s['calibration_slope']['joint'][0]} ± {s['calibration_slope']['joint'][1]}, "
              f"today's {s['calibration_slope']['today'][0]} ± {s['calibration_slope']['today'][1]}.",
              "- Joint favourites, stated against actual: "
              + ", ".join(f"{b['band']}: said {b['stated'] * 100:.0f}%, won {b['won'] * 100:.0f}% (n={b['n']})" for b in s["favourites"]) + ".",
              f"- Against today's meter: differs by 10 points or more in {s['differs_by_10_points'] * 100:.0f}% of duels, "
              f"names a different favourite in {s['different_favourite'] * 100:.0f}%.", ""]
    if rep.get("gaps"):
        g = rep["gaps"]
        L += ["## 6. Largest gaps between results and damage", "",
              f"{g['regulars']} regulars with {REGULAR_MIN_RECORDED}+ recorded games. Gap = results-only fighting skill "
              "minus the full model's, in skill units, with the results-only uncertainty. Nothing is tuned on this.", "",
              "| Player | Recorded games | Results only | With damage | Gap | ± | z |", "|---|---|---|---|---|---|---|"]
        for r in g["more_impact_than_damage"] + g["less_impact_than_damage"]:
            L.append(f"| {r['name']} | {r['recorded_games']} | {r['results_only']:+.2f} | {r['with_damage']:+.2f} "
                     f"| {r['gap']:+.2f} | {r['gap_sd']:.2f} | {r['z']:+.1f} |")
        L.append("")
    with open(os.path.join(OUT_DIR, "joint_skill.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--quick", action="store_true", help="noise table and the main back-test only")
    args = ap.parse_args()

    t0 = time.time()
    all_md, elo_history, cmdr_history, f9 = load_corpus()
    duels = J.build_duels(all_md, elo_history, cmdr_history, f9)
    win = Windows(duels)
    e_today = todays_expected(cmdr_history, duels)
    print(f"{len(duels)} games, {int(win.tele.sum())} recorded ({time.time() - t0:.0f}s)", flush=True)

    rep = {"config_hash": J.config_hash(), "config": J.DEFAULT_CONFIG, "games": len(duels),
           "recorded": int(win.tele.sum()), "through": duels[-1]["date"]}
    rep["noise"] = section_noise(duels, win)
    # The back-test scores the late window, so its noise table is measured
    # on the duels before that window only.
    noise_bt = rep["noise"]["before_late_window"]
    rep["backtest"], preds = section_backtest(duels, win, e_today, noise_bt, args.quick)
    f = rep["backtest"]["frozen"]
    t = rep["backtest"]["today"]
    print(f"frozen: log-loss {f['all']['log_loss']:.4f}, {f['all']['accuracy'] * 100:.1f}% of winners "
          f"(late window {f['late']['log_loss']:.4f}); today's formula {t['all']['log_loss']:.4f}, "
          f"{t['all']['accuracy'] * 100:.1f}%", flush=True)
    if not args.quick:
        rep["neighbours"] = section_neighbours(duels, win, noise_bt, preds["frozen"])
        print(f"configuration check: {rep['neighbours']['verdict']}", flush=True)
        rep["time"] = section_time(duels, win, noise_bt, e_today)
        rep["switch_test"] = section_switch_test(duels, win, preds["frozen"], e_today)
        print(f"switch test: threshold {rep['switch_test']['threshold_for_5pct_false_pass']} SE for three looks", flush=True)
        rep["gaps"] = section_gaps(duels, noise_bt)
    write_report(rep)
    print(f"wrote {os.path.join(OUT_DIR, 'joint_skill.md')} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
