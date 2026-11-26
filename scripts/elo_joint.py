"""VSR joint commanding-and-fighting model (`elo_joint` in code). Forensic.

One model over every rated team game and every F9bomber ledger duel. Each
player has two skills, in logit units:

    C  commanding skill  (what a commander adds beyond their own fighting)
    F  fighting skill    (the same number whether they command or not)

A game played in calendar quarter q is explained by that quarter's skills:

    logit P(team 1 wins) = C[c1,q] - C[c2,q]
                         + mean F[team 1 fighters,q] - mean F[team 2 fighters,q]

Fighters are the side's rated thugs plus its commander. Recorded matches
also give damage rows, scored inside the player's own team so nothing at
team level (the result, the faction, the commander's supply) can enter:

    v = ln(enemy_dealt + 100) - mean of that over the team's thugs
    thug       v ~ Normal(beta * (F - mean F of the team's thugs), noise)
    commander  v ~ Normal(beta * (F - mean F of the team's thugs)
                          + offset[player] + mu, noise_c)

A team's k thug rows are centred on their own mean, so they carry k - 1
free values. They are scored together with the per-thug noise before
centring (centred spread / sqrt((k - 1) / k)); using the centred spread
row by row would count each team k / (k - 1) times.

Skill moves between quarters as a random walk (Whole-History Rating on
quarterly blocks, Coulom 2008): the first quarter a player appears in has
a Normal(0, spread) prior and every later quarter a Normal(quarter before,
step) prior. Old games stay in at full weight for the quarter they were
played in.

Fit: maximum a posteriori by Newton steps with step-halving. With Gaussian
damage noise the objective is strictly convex, so there is one optimum.

History is walk-forward. A duel's `expected` comes from the fit on all
earlier games; a participant's `*_before` values are read from that fit
and `*_after` from the fit that includes the duel. A refit moves players
who did not play by a fraction of a point; those moves are not recorded.

Rules that hold this module in place
(critique/decisions/joint-skill-model.md):

  * Forensic until the registered switch test passes. Nothing here feeds
    a published rating. Forbidden consumers: scripts/elo.py,
    scripts/elo_commander.py, scripts/elo_1v1.py, scripts/elo_2v2.py,
    js/all-matches-aggregator.js (gate
    _investigation/check_joint_separation.py).
  * `elo_history` and `cmdr_history` are read for membership only: which
    matches and rows are rated, and the order of the duels. No rating
    value is read from either.
  * DEFAULT_CONFIG is the frozen configuration. Its hash is recorded in
    the memo (gate _investigation/check_joint_config.py). Changing any
    value restarts the test.

numpy is required. The pipeline imports this module inside a soft-fail
block, so a machine without numpy still produces every other output.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from typing import Any, Callable

import numpy as np

JOINT_SCHEMA_VERSION = 1

# Points per logit unit on the Elo scale (400 / ln 10). Display helper for
# commanding skill only; fighting skill gets its display scale at the
# switch (memo, "Display rule").
ELO_POINTS_PER_LOGIT = 400.0 / math.log(10.0)

# ---------------------------------------------------------------------------
# Frozen configuration
# ---------------------------------------------------------------------------
# `noise` holds within-player spreads of the centred damage value, measured
# by scripts/study_joint_skill.py on every recorded duel up to the freeze:
#   thug[k] / cmdr[k]      spread by thugs-with-damage on the team (4 = 4+)
#   *_length               multiplier by match length band
# Length bands are minutes: under 12, 12 to 20, 20 to 30, 30 and over.
DEFAULT_CONFIG: dict[str, Any] = {
    "beta": 0.12,              # damage loading on fighting skill
    "tau_c": 0.75,             # prior spread, commanding skill
    "tau_f": 2.0,              # prior spread, fighting skill
    "step_c_year": 0.11,       # random-walk step per year, commanding
    "step_f_year": 0.8,        # random-walk step per year, fighting
    "sigma_offset": 0.22,      # spread of the per-player commander offset
    "block_months": 3,         # 0 = one block for all time (fixed skill)
    "origin_year": 2025,       # blocks are counted from January of this year
    "epsilon": 100.0,          # added to damage before the log
    "min_damage_sec": 240,     # shorter matches give a result, no damage rows
    "length_bands_min": [12, 20, 30],
    "noise": {
        "thug": {"2": 0.196, "3": 0.2729, "4": 0.3144},
        "cmdr": {"2": 0.4015, "3": 0.4381, "4": 0.4422},
        "cmdr_all": 0.4356,
        "thug_length": [1.2105, 0.9225, 0.8796, 0.7722],
        "cmdr_length": [1.2715, 0.8503, 0.8986, 0.7795],
    },
}


def config_hash(config: dict[str, Any] | None = None) -> str:
    """Stable hash of a configuration (sorted keys, 16 hex characters)."""
    cfg = DEFAULT_CONFIG if config is None else config
    blob = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Duel list
# ---------------------------------------------------------------------------

def _player_key(steam64: Any, name: Any) -> str:
    return str(steam64) if steam64 else "name:" + str(name or "")


def _enemy_damage(row: dict) -> float:
    pd = row.get("personal") or {}
    v = pd.get("enemy_dealt")
    if v is None:
        v = pd.get("dealt")
    return float(v or 0.0)


def build_duels(
    all_match_data: list[dict],
    elo_history: dict,
    cmdr_history: dict,
    external_duels: list[dict] | None = None,
    config: dict[str, Any] | None = None,
) -> list[dict]:
    """The games the model sees, in the commander history's order.

    Each duel: `y` (1.0 when team 1 won), the two commander keys, each
    side's fighter keys (thugs then commander), and for recorded matches
    the damage blocks (one per team with at least two thugs who dealt
    enemy damage).
    """
    cfg = DEFAULT_CONFIG if config is None else config
    eps = float(cfg["epsilon"])
    min_sec = float(cfg["min_damage_sec"])
    match_by_id = {(md.get("match") or {}).get("id"): md for md in all_match_data}
    hist_by_id = {h.get("match_id"): h for h in (elo_history.get("history") or [])}
    led_by_row = {d.get("row"): d for d in (external_duels or [])}

    duels: list[dict] = []
    for d in cmdr_history.get("duels") or []:
        if d.get("outcome") not in ("team1", "team2"):
            continue
        cm = d.get("commanders") or {}
        c1, c2 = cm.get("1") or {}, cm.get("2") or {}
        names: dict[str, str] = {}
        steam: dict[str, str | None] = {}

        def reg(steam64: Any, name: Any) -> str:
            k = _player_key(steam64, name)
            names[k] = str(name or "")
            steam[k] = str(steam64) if steam64 else None
            return k

        k1 = reg(c1.get("steam64"), c1.get("name"))
        k2 = reg(c2.get("steam64"), c2.get("name"))
        rec: dict[str, Any] = {
            "source": d.get("source") or "telemetry",
            "match_id": d.get("match_id") or "",
            "external_row": d.get("external_row"),
            "date": str(d.get("date") or "")[:10],
            "y": 1.0 if d["outcome"] == "team1" else 0.0,
            "c": (k1, k2),
            "thugs": ([], []),
            "blocks": [],
            "duration_sec": 0.0,
        }
        if rec["source"] == "telemetry":
            md = match_by_id.get(rec["match_id"])
            entry = hist_by_id.get(rec["match_id"])
            if md is None or entry is None:
                continue
            rated = {str(x.get("steam64")) for x in (entry.get("deltas") or [])}
            dur = float((md.get("match") or {}).get("duration_sec") or 0.0)
            rec["duration_sec"] = dur
            # A player who stopped fighting part-way (match.bench) has a
            # full-match total that understates them: no damage row.
            benched = str(((md.get("match") or {}).get("bench") or {}).get("steam64") or "")
            th_rows: dict[int, list[dict]] = {1: [], 2: []}
            cm_rows: dict[int, dict] = {}
            for row in md.get("leaderboard") or []:
                team = row.get("faction")
                if team not in (1, 2) or str(row.get("steam64")) not in rated:
                    continue
                if row.get("is_commander"):
                    cm_rows[team] = row
                else:
                    th_rows[team].append(row)
            for t in (1, 2):
                for row in th_rows[t]:
                    rec["thugs"][t - 1].append(reg(row.get("steam64"), row.get("name")))
            if dur >= min_sec:
                for t in (1, 2):
                    use = [r for r in th_rows[t]
                           if _enemy_damage(r) > 0 and str(r.get("steam64")) != benched]
                    if len(use) < 2:
                        continue
                    block = {
                        "team": t,
                        "k": len(use),
                        "minutes": dur / 60.0,
                        "thugs": [(_player_key(r.get("steam64"), r.get("name")),
                                   math.log(_enemy_damage(r) + eps)) for r in use],
                        "cmdr": None,
                    }
                    c_row = cm_rows.get(t)
                    if (c_row is not None and _enemy_damage(c_row) > 0
                            and str(c_row.get("steam64")) != benched):
                        block["cmdr"] = (
                            reg(c_row.get("steam64"), c_row.get("name")),
                            math.log(_enemy_damage(c_row) + eps),
                        )
                    rec["blocks"].append(block)
        else:
            led = led_by_row.get(rec["external_row"])
            if led is None:
                continue
            for t in (1, 2):
                for p in (led.get("thugs") or {}).get(str(t)) or []:
                    rec["thugs"][t - 1].append(reg(p.get("steam64"), p.get("name")))
        rec["names"] = names
        rec["steam64"] = steam
        rec["digest"] = _duel_digest(rec)
        duels.append(rec)
    return duels


def _duel_digest(rec: dict) -> str:
    blocks = [
        [b["team"], b["k"], round(b["minutes"], 4),
         [[k, round(v, 6)] for k, v in b["thugs"]],
         ([b["cmdr"][0], round(b["cmdr"][1], 6)] if b["cmdr"] else None)]
        for b in rec["blocks"]
    ]
    blob = json.dumps(
        [rec["source"], rec["match_id"], rec["external_row"], rec["date"],
         rec["y"], list(rec["c"]), [list(rec["thugs"][0]), list(rec["thugs"][1])],
         blocks],
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def fighters(rec: dict, side: int) -> list[str]:
    """Fighter keys for side 1 or 2: the thugs, then the commander."""
    return list(rec["thugs"][side - 1]) + [rec["c"][side - 1]]


# ---------------------------------------------------------------------------
# Time blocks and noise
# ---------------------------------------------------------------------------

def block_index(day: str, config: dict[str, Any]) -> int:
    """Block number of a YYYY-MM-DD date (0 for every date when static)."""
    months = int(config.get("block_months") or 0)
    if months <= 0:
        return 0
    y, m = int(day[:4]), int(day[5:7])
    return ((y - int(config["origin_year"])) * 12 + (m - 1)) // months


def block_label(index: int, config: dict[str, Any]) -> str:
    months = int(config.get("block_months") or 0)
    if months <= 0:
        return "all"
    first = index * months
    year = int(config["origin_year"]) + first // 12
    if months == 3:
        return f"{year}Q{(first % 12) // 3 + 1}"
    return f"{year}-{first % 12 + 1:02d}"


def length_band(minutes: float, config: dict[str, Any]) -> int:
    for i, edge in enumerate(config["length_bands_min"]):
        if minutes < edge:
            return i
    return len(config["length_bands_min"])


def block_noise(block: dict, config: dict[str, Any],
                noise: dict[str, Any] | None = None) -> tuple[float, float]:
    """(per-thug noise before centring, commander-row noise) for a block."""
    nz = config["noise"] if noise is None else noise
    k = int(block["k"])
    kk = str(min(k, 4))
    band = length_band(block["minutes"], config)
    thug = (float(nz["thug"][kk]) / math.sqrt((k - 1.0) / k)
            * float(nz["thug_length"][band]))
    cmdr = (float(nz["cmdr"].get(kk, nz["cmdr_all"]))
            * float(nz["cmdr_length"][band]))
    return thug, cmdr


def calibrate_noise(duels: list[dict], upto: int | None = None,
                    config: dict[str, Any] | None = None,
                    min_rows: int = 8) -> dict[str, Any]:
    """Noise table from within-player spreads on `duels[:upto]`.

    For every player with at least `min_rows` rows of a kind, each row's
    centred value minus that player's own mean is a residual. Spreads are
    taken by thugs-with-damage on the team and, as a multiplier, by match
    length band.
    """
    cfg = DEFAULT_CONFIG if config is None else config
    rows: list[tuple[str, str, float, int, float]] = []
    per: dict[tuple[str, str], list[float]] = {}
    for rec in duels[: (len(duels) if upto is None else upto)]:
        for b in rec["blocks"]:
            mu = sum(v for _, v in b["thugs"]) / len(b["thugs"])
            for key, v in b["thugs"]:
                rows.append(("thug", key, v - mu, b["k"], b["minutes"]))
                per.setdefault(("thug", key), []).append(v - mu)
            if b["cmdr"]:
                key, v = b["cmdr"]
                rows.append(("cmdr", key, v - mu, b["k"], b["minutes"]))
                per.setdefault(("cmdr", key), []).append(v - mu)
    res: dict[tuple, list[float]] = {}
    for kind, key, v, k, minutes in rows:
        vals = per[(kind, key)]
        if len(vals) < min_rows:
            continue
        r = v - sum(vals) / len(vals)
        res.setdefault((kind, str(min(k, 4))), []).append(r)
        res.setdefault((kind, "all"), []).append(r)
        res.setdefault((kind, "band", length_band(minutes, cfg)), []).append(r)

    def sd(key: tuple) -> float | None:
        vals = res.get(key)
        return float(np.std(vals)) if vals and len(vals) > 5 else None

    n_bands = len(cfg["length_bands_min"]) + 1
    out: dict[str, Any] = {"thug": {}, "cmdr": {}}
    for kind in ("thug", "cmdr"):
        overall = sd((kind, "all")) or 0.3
        for kk in ("2", "3", "4"):
            out[kind][kk] = round(sd((kind, kk)) or overall, 4)
        out[f"{kind}_length"] = [
            round((sd((kind, "band", b)) or overall) / overall, 4)
            for b in range(n_bands)
        ]
        if kind == "cmdr":
            out["cmdr_all"] = round(overall, 4)
    out["rows"] = {"thug": len(res.get(("thug", "all"), [])),
                   "cmdr": len(res.get(("cmdr", "all"), []))}
    return out


# ---------------------------------------------------------------------------
# Design
# ---------------------------------------------------------------------------

class Design:
    """Index maps, the result design matrix, damage rows and the prior."""

    def __init__(self, duels: list[dict], config: dict[str, Any] | None = None,
                 noise: dict[str, Any] | None = None):
        cfg = DEFAULT_CONFIG if config is None else config
        self.config = cfg
        self.duels = duels
        n = len(duels)
        self.n = n
        self.y = np.array([d["y"] for d in duels], float)
        self.days = np.array(
            [date.fromisoformat(d["date"]).toordinal() for d in duels], float)

        blocks = [block_index(d["date"], cfg) for d in duels]
        self.block_min = min(blocks) if blocks else 0
        self.E = (max(blocks) - self.block_min + 1) if blocks else 1
        self.epoch = np.array([b - self.block_min for b in blocks], int)
        E = self.E

        cids = sorted({k for d in duels for k in d["c"]})
        tids = sorted({k for d in duels for s in (1, 2) for k in fighters(d, s)})
        dids = sorted({b["cmdr"][0] for d in duels for b in d["blocks"] if b["cmdr"]})
        self.cids, self.tids, self.dids = cids, tids, dids
        self.ci = {k: i for i, k in enumerate(cids)}
        self.ti = {k: i for i, k in enumerate(tids)}
        self.di = {k: i for i, k in enumerate(dids)}
        nc, nt, nd = len(cids), len(tids), len(dids)
        self.nc, self.nt, self.nd = nc, nt, nd
        self.NP = nc * E + nt * E + nd + 1
        self.MU = self.NP - 1
        NP = self.NP

        X = np.zeros((n, NP))
        for i, d in enumerate(duels):
            e = int(self.epoch[i])
            X[i, self.c_col(d["c"][0], e)] += 1.0
            X[i, self.c_col(d["c"][1], e)] -= 1.0
            a, b = fighters(d, 1), fighters(d, 2)
            for k in a:
                X[i, self.f_col(k, e)] += 1.0 / len(a)
            for k in b:
                X[i, self.f_col(k, e)] -= 1.0 / len(b)
        self.X = X

        beta = float(cfg["beta"])
        ridx: list[int] = []
        A: list[np.ndarray] = []
        v: list[float] = []
        s: list[float] = []
        meta: list[tuple[str, str, int, int]] = []
        for i, d in enumerate(duels):
            e = int(self.epoch[i])
            for blk in d["blocks"]:
                k = blk["k"]
                ids = [key for key, _ in blk["thugs"]]
                mu = sum(val for _, val in blk["thugs"]) / k
                s_thug, s_cmdr = block_noise(blk, cfg, noise)
                for key, val in blk["thugs"]:
                    a_row = np.zeros(NP)
                    a_row[self.f_col(key, e)] += beta
                    for j in ids:
                        a_row[self.f_col(j, e)] -= beta / k
                    ridx.append(i); A.append(a_row); v.append(val - mu)
                    s.append(s_thug); meta.append(("thug", key, i, blk["team"]))
                if blk["cmdr"]:
                    key, val = blk["cmdr"]
                    a_row = np.zeros(NP)
                    a_row[self.f_col(key, e)] += beta
                    for j in ids:
                        a_row[self.f_col(j, e)] -= beta / k
                    a_row[self.d_col(key)] = 1.0
                    a_row[self.MU] = 1.0
                    ridx.append(i); A.append(a_row); v.append(val - mu)
                    s.append(s_cmdr); meta.append(("cmdr", key, i, blk["team"]))
        self.ridx = np.array(ridx, int)
        self.A = np.array(A) if A else np.zeros((0, NP))
        self.v = np.array(v, float)
        self.s = np.array(s, float)
        self.row_meta = meta

        self.P, self.logdet_prior = self._prior()

    def c_col(self, key: str, e: int) -> int:
        return self.ci[key] * self.E + e

    def f_col(self, key: str, e: int) -> int:
        return self.nc * self.E + self.ti[key] * self.E + e

    def d_col(self, key: str) -> int:
        return self.nc * self.E + self.nt * self.E + self.di[key]

    def _prior(self) -> tuple[np.ndarray, float]:
        cfg = self.config
        E = self.E
        months = int(cfg.get("block_months") or 0)
        per_year = (12.0 / months) if months > 0 else 1.0
        q_c = float(cfg["step_c_year"]) / math.sqrt(per_year)
        q_f = float(cfg["step_f_year"]) / math.sqrt(per_year)
        P = np.zeros((self.NP, self.NP))
        logdet = 0.0
        debut_c: dict[str, int] = {}
        debut_f: dict[str, int] = {}
        for i, d in enumerate(self.duels):
            e = int(self.epoch[i])
            for k in d["c"]:
                debut_c.setdefault(k, e)
            for side in (1, 2):
                for k in fighters(d, side):
                    debut_f.setdefault(k, e)

        def chain(col: Callable[[str, int], int], key: str, e0: int,
                  tau: float, q: float) -> None:
            nonlocal logdet
            j = col(key, e0)
            P[j, j] += 1.0 / tau ** 2
            logdet += -2.0 * math.log(tau)
            for e in range(E - 1):
                i0, i1 = col(key, e), col(key, e + 1)
                w = 1.0 / q ** 2
                P[i0, i0] += w; P[i1, i1] += w
                P[i0, i1] -= w; P[i1, i0] -= w
                logdet += -2.0 * math.log(q)

        for k in self.cids:
            chain(self.c_col, k, debut_c[k], float(cfg["tau_c"]), q_c)
        for k in self.tids:
            chain(self.f_col, k, debut_f[k], float(cfg["tau_f"]), q_f)
        sig = float(cfg["sigma_offset"])
        for k in self.dids:
            j = self.d_col(k)
            P[j, j] += 1.0 / sig ** 2
            logdet += -2.0 * math.log(sig)
        P[self.MU, self.MU] += 1e-6
        logdet += math.log(1e-6)
        return P, logdet


# ---------------------------------------------------------------------------
# Fit
# ---------------------------------------------------------------------------

def fit(design: Design, upto: int, theta: np.ndarray, G: np.ndarray,
        b: np.ndarray, weights: np.ndarray | None = None,
        max_iter: int = 80, tol: float = 1e-9
        ) -> tuple[np.ndarray, np.ndarray, float]:
    """MAP fit on results `[:upto]` plus the damage information (G, b).

    Newton steps with step-halving. Returns (theta, Hessian, objective).
    The objective omits the constant sum(v^2 / s^2) / 2 of the damage term.
    """
    Xs = design.X[:upto]
    ys = design.y[:upto]
    P = design.P
    w = np.ones(upto) if weights is None else weights

    def objective(t: np.ndarray) -> float:
        z = Xs @ t
        return float(np.sum(w * (np.logaddexp(0.0, z) - ys * z))
                     + 0.5 * t @ (G @ t) - b @ t + 0.5 * t @ (P @ t))

    f0 = objective(theta)
    H = G + P
    for _ in range(max_iter):
        p = 1.0 / (1.0 + np.exp(-np.clip(Xs @ theta, -30.0, 30.0)))
        grad = Xs.T @ (w * (ys - p)) + b - G @ theta - P @ theta
        H = (Xs * (w * p * (1.0 - p))[:, None]).T @ Xs + G + P
        step = np.linalg.solve(H, grad)
        t = 1.0
        while True:
            f1 = objective(theta + t * step)
            if f1 <= f0 + 1e-12 or t < 1e-6:
                break
            t *= 0.5
        theta = theta + t * step
        f0 = f1
        if float(np.max(np.abs(t * step))) < tol:
            break
    return theta, H, f0


def damage_information(design: Design, upto: int | None = None
                       ) -> tuple[np.ndarray, np.ndarray]:
    """(G, b) for the damage rows of duels `[:upto]`."""
    hi = len(design.ridx) if upto is None else int(np.searchsorted(design.ridx, upto))
    A = design.A[:hi]
    W = 1.0 / design.s[:hi] ** 2
    return (A * W[:, None]).T @ A, A.T @ (W * design.v[:hi])


def walk_forward(
    design: Design,
    start: int,
    on_fit: Callable[[int, np.ndarray], None] | None = None,
    decay_days: float | None = None,
    result_weights: np.ndarray | None = None,
    final_fit: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Predict every duel from `start` on with a fit on the games before it.

    `on_fit(i, theta)` is called with the fit on games `[:i]` for every
    `i` in `start..n` (`n` only when `final_fit`). `decay_days` and
    `result_weights` exist for the study script; the pipeline uses neither.

    Returns (predictions, final theta, final Hessian). Predictions before
    `start` are NaN.
    """
    n, NP = design.n, design.NP
    preds = np.full(n, np.nan)
    theta = np.zeros(NP)
    G = np.zeros((NP, NP))
    b = np.zeros(NP)
    W = 1.0 / design.s ** 2
    ptr = 0
    last_day: float | None = None
    H = design.P
    stops = list(range(start, n)) + ([n] if final_fit else [])
    for i in stops:
        hi = int(np.searchsorted(design.ridx, i))
        day_i = design.days[i] if i < n else design.days[n - 1]
        if decay_days and last_day is not None:
            f = math.exp(-(day_i - last_day) / decay_days)
            G *= f; b *= f
        if hi > ptr:
            A = design.A[ptr:hi]
            Wb = W[ptr:hi]
            if decay_days:
                Wb = Wb * np.exp(-(day_i - design.days[design.ridx[ptr:hi]]) / decay_days)
            G += (A * Wb[:, None]).T @ A
            b += A.T @ (Wb * design.v[ptr:hi])
            ptr = hi
        last_day = day_i
        wr = None
        if decay_days:
            wr = np.exp(-(day_i - design.days[:i]) / decay_days)
        if result_weights is not None:
            wr = (np.ones(i) if wr is None else wr) * result_weights[:i]
        theta, H, _ = fit(design, i, theta, G, b, wr)
        if on_fit is not None:
            on_fit(i, theta)
        if i < n:
            z = float(np.clip(design.X[i] @ theta, -30.0, 30.0))
            preds[i] = 1.0 / (1.0 + math.exp(-z))
    return preds, theta, H


def log_evidence(design: Design) -> float:
    """Laplace log evidence of the full-data fit (study script only)."""
    G, b = damage_information(design)
    theta, H, f0 = fit(design, design.n, np.zeros(design.NP), G, b)
    const = 0.5 * float(np.sum(design.v ** 2 / design.s ** 2))
    _, logdet_h = np.linalg.slogdet(H)
    return -(f0 + const) + 0.5 * design.logdet_prior - 0.5 * float(logdet_h)


def win_probability(c1: float, c2: float, f1: list[float], f2: list[float]) -> float:
    """P(team 1 wins) from the two commanding skills and each side's
    fighting skills (commander included). Mirrors `VTBalonce.jointWinProb`."""
    z = (c1 - c2) + (sum(f1) / len(f1) if f1 else 0.0) - (sum(f2) / len(f2) if f2 else 0.0)
    z = max(-30.0, min(30.0, z))
    return 1.0 / (1.0 + math.exp(-z))


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------

def first_recorded_index(duels: list[dict]) -> int:
    for i, d in enumerate(duels):
        if d["source"] == "telemetry":
            return i
    return len(duels)


def _chain_digests(duels: list[dict], seed: str) -> list[str]:
    out: list[str] = []
    h = seed
    for d in duels:
        h = hashlib.sha256((h + d["digest"]).encode("utf-8")).hexdigest()
        out.append(h[:20])
    return out


def _r(x: float) -> float:
    return round(float(x), 6)


def compute_joint(
    all_match_data: list[dict],
    elo_history: dict,
    cmdr_history: dict,
    external_duels: list[dict] | None = None,
    previous_history: dict | None = None,
    config: dict[str, Any] | None = None,
) -> tuple[dict, dict]:
    """Fit the joint model and return `(current, history)`.

    `history["duels"]` has one row per duel from the first recorded match
    on (earlier F9 duels are in the fit but get no row). Rows from
    `previous_history` are reused when the chain of inputs up to and
    including them is unchanged, so a normal run refits only new duels.
    """
    cfg = DEFAULT_CONFIG if config is None else config
    chash = config_hash(cfg)
    duels = build_duels(all_match_data, elo_history, cmdr_history, external_duels, cfg)
    n = len(duels)
    start = first_recorded_index(duels)
    chains = _chain_digests(duels, chash)
    design = Design(duels, cfg)
    E = design.E

    # Reuse the unchanged prefix of the previous history.
    rows: list[dict] = []
    prev_rows = (previous_history or {}).get("duels") or []
    if (previous_history or {}).get("config_hash") == chash:
        for offset, row in enumerate(prev_rows):
            i = start + offset
            if i >= n or row.get("chain") != chains[i] or not row.get("complete"):
                break
            rows.append(row)
    first_new = start + len(rows)

    fits: dict[int, np.ndarray] = {}

    def keep(i: int, theta: np.ndarray) -> None:
        fits[i] = theta.copy()

    _, theta_final, H_final = walk_forward(design, first_new, on_fit=keep)

    def skills(theta: np.ndarray, key: str, e: int) -> tuple[float | None, float]:
        c = float(theta[design.c_col(key, e)]) if key in design.ci else None
        return c, float(theta[design.f_col(key, e)])

    for i in range(first_new, n):
        d = duels[i]
        e = int(design.epoch[i])
        before, after = fits[i], fits[i + 1]
        teams: dict[str, Any] = {}
        for side in (1, 2):
            ck = d["c"][side - 1]
            cb, fb = skills(before, ck, e)
            ca, fa = skills(after, ck, e)
            thugs = []
            for k in d["thugs"][side - 1]:
                _, tb = skills(before, k, e)
                _, ta = skills(after, k, e)
                thugs.append({"steam64": d["steam64"].get(k), "name": d["names"].get(k, ""),
                              "f_before": _r(tb), "f_after": _r(ta)})
            teams[str(side)] = {
                "commander": {"steam64": d["steam64"].get(ck), "name": d["names"].get(ck, ""),
                              "c_before": _r(cb or 0.0), "c_after": _r(ca or 0.0),
                              "f_before": _r(fb), "f_after": _r(fa)},
                "thugs": thugs,
            }
        z = float(np.clip(design.X[i] @ before, -30.0, 30.0))
        rows.append({
            "match_id": d["match_id"],
            "source": d["source"],
            "external_row": d["external_row"],
            "date": d["date"],
            "block": block_label(design.block_min + e, cfg),
            "outcome": "team1" if d["y"] == 1.0 else "team2",
            "expected": _r(1.0 / (1.0 + math.exp(-z))),
            "damage_rows": sum(len(b["thugs"]) + (1 if b["cmdr"] else 0) for b in d["blocks"]),
            "teams": teams,
            "chain": chains[i],
            "complete": True,
        })

    # Current skills: the last block of the fit on every game.
    cov = np.linalg.inv(H_final)
    last = E - 1
    games: dict[str, int] = {}
    recorded: dict[str, int] = {}
    commanded: dict[str, int] = {}
    last_day: dict[str, str] = {}
    names: dict[str, str] = {}
    steam: dict[str, str | None] = {}
    for d in duels:
        for side in (1, 2):
            commanded[d["c"][side - 1]] = commanded.get(d["c"][side - 1], 0) + 1
            for k in fighters(d, side):
                games[k] = games.get(k, 0) + 1
                if d["source"] == "telemetry":
                    recorded[k] = recorded.get(k, 0) + 1
                last_day[k] = d["date"]
        names.update(d["names"])
        steam.update(d["steam64"])
    ratings = []
    for k in design.tids:
        jf = design.f_col(k, last)
        entry: dict[str, Any] = {
            "steam64": steam.get(k),
            "name": names.get(k, ""),
            "f": _r(theta_final[jf]),
            "f_sd": _r(math.sqrt(max(cov[jf, jf], 0.0))),
            "c": None,
            "c_sd": None,
            "games": games.get(k, 0),
            "games_recorded": recorded.get(k, 0),
            "duels_commanded": commanded.get(k, 0),
            "last_date": last_day.get(k, ""),
        }
        if k in design.ci:
            jc = design.c_col(k, last)
            entry["c"] = _r(theta_final[jc])
            entry["c_sd"] = _r(math.sqrt(max(cov[jc, jc], 0.0)))
        if k in design.di:
            entry["commander_offset"] = _r(theta_final[design.d_col(k)])
        ratings.append(entry)
    ratings.sort(key=lambda r: (-r["f"], r["name"]))

    recorded_duels = sum(1 for d in duels if d["source"] == "telemetry")
    common = {
        "schema_version": JOINT_SCHEMA_VERSION,
        "status": "forensic",
        "config_hash": chash,
    }
    current = dict(common)
    current.update({
        "computed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": cfg,
        "games": n,
        "recorded_games": recorded_duels,
        "damage_rows": int(len(design.v)),
        "parameters": int(design.NP),
        "blocks": E,
        "current_block": block_label(design.block_min + last, cfg),
        "elo_points_per_unit": round(ELO_POINTS_PER_LOGIT, 4),
        "commander_offset_mean": _r(theta_final[design.MU]),
        "duels_refit": n - first_new,
        "ratings": ratings,
    })
    history = dict(common)
    history.update({
        "first_row_index": start,
        "duels": rows,
    })
    return current, history
