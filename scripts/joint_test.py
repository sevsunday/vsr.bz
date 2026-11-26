"""The joint model's switch test: frozen baseline, prediction ledger, score.

Registered in critique/decisions/joint-skill-model.md. Stdlib only, so the
validator can score the ledger on a machine without numpy.

Three pieces:

  * `frozen_baseline_expected()` replays the win formula the joint model is
    tested against: today's VSR-C expected score on the VSR-T rules that
    were live when the memo was signed (BASELINE_RULES). It sets those
    module constants back for the length of one in-memory replay, so a
    later change to the live VSR-T rules cannot move the yardstick.
  * `append_ledger()` logs, for every recorded duel dated after the freeze,
    the joint, frozen-baseline and live win chances as first computed.
    Entries are never rewritten, so reprocessing the corpus cannot change
    a logged prediction.
  * `score_ledger()` applies the registered rule to the ledger.

The freeze date is set once, when the memo is signed. Until then nothing
is logged and the test reads "not started".
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
LEDGER_PATH = ROOT / "data" / "joint_test_ledger.json"
FINGERPRINT_PATH = ROOT / "critique" / "decisions" / "joint-skill-model.baseline.json"
LEDGER_SCHEMA_VERSION = 1

# The sign-off date ("YYYY-MM-DD", UTC like every match date) of
# critique/decisions/joint-skill-model.md. Recorded duels dated strictly
# after it count. None = the memo is not signed and nothing is logged.
# Signed 2026-11-25 22:30 US Central = 2026-11-26 UTC, so the first duels
# that count are dated 2026-11-27 UTC. Changing this restarts the test.
FREEZE_DATE: str | None = "2026-11-26"

# The registered rule. Changing any of these restarts the test.
LOOKS = (200, 300, 400)
PASS_SE = 2.0          # mean gain must be this many standard errors above 0
GUARD_SE = 2.0         # over-confidence guard: slope more than this below 1
WITHDRAW_SE = 2.0      # preview comes down when behind by this many

# The VSR-T rules the frozen baseline runs on (scripts/elo.py constants).
BASELINE_RULES = {
    "EXPECTED_REFERENCE_POOL": "lobby",
    "ENEMY_DAMAGE_TRIM_LATE_STRUCTURE": False,
    "LOWTIER_LIFT_ENABLED": True,
}


# ---------------------------------------------------------------------------
# Frozen baseline
# ---------------------------------------------------------------------------

@contextlib.contextmanager
def _baseline_rules(elo_module):
    saved = {k: getattr(elo_module, k) for k in BASELINE_RULES}
    try:
        for k, v in BASELINE_RULES.items():
            setattr(elo_module, k, v)
        yield
    finally:
        for k, v in saved.items():
            setattr(elo_module, k, v)


def frozen_baseline_expected(
    all_match_data: list[dict],
    external_duels: list[dict] | None = None,
    external_overlap_ids: Any = None,
    combat_ship_stems: Any = None,
) -> dict[str, float]:
    """`{match_id: P(team 1 wins)}` for every recorded duel under the frozen
    baseline. Pure: replays VSR-T then VSR-C in memory and writes nothing."""
    import elo
    import elo_commander

    with _baseline_rules(elo):
        _cur, hist = elo.compute_elo(all_match_data, external_duels=external_duels)
    with contextlib.redirect_stdout(io.StringIO()):
        _ccur, chist = elo_commander.compute_commander_elo(
            all_match_data, hist,
            external_duels=external_duels,
            external_overlap_ids=external_overlap_ids,
            combat_ship_stems=combat_ship_stems,
        )
    out: dict[str, float] = {}
    for d in chist.get("duels") or []:
        if d.get("source") != "telemetry" or not d.get("match_id"):
            continue
        c1 = (d.get("commanders") or {}).get("1") or {}
        if isinstance(c1.get("expected"), (int, float)):
            out[d["match_id"]] = float(c1["expected"])
    return out


def fingerprint(expected: dict[str, float]) -> dict[str, Any]:
    """Hash of a baseline's predictions, for the memo."""
    blob = json.dumps(sorted(expected.items()), separators=(",", ":"))
    return {
        "rules": dict(BASELINE_RULES),
        "duels": len(expected),
        "sha256": hashlib.sha256(blob.encode("utf-8")).hexdigest(),
        "expected": dict(sorted(expected.items())),
    }


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------

def load_ledger(path: Path = LEDGER_PATH) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            ledger = json.load(f)
        if isinstance(ledger, dict) and isinstance(ledger.get("entries"), list):
            return ledger
    except (OSError, json.JSONDecodeError):
        pass
    return {"schema_version": LEDGER_SCHEMA_VERSION, "freeze_date": None,
            "config_hash": None, "entries": []}


def save_ledger(ledger: dict[str, Any], path: Path = LEDGER_PATH) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=2, ensure_ascii=False)
        f.write("\n")


def append_ledger(
    ledger: dict[str, Any],
    joint_history: dict,
    cmdr_history: dict,
    baseline: Callable[[], dict[str, float]],
    freeze_date: str | None = None,
) -> int:
    """Log every recorded duel dated after the freeze that is not in the
    ledger yet. `baseline` is called only when there is something to log.
    Returns the number of entries added."""
    freeze = FREEZE_DATE if freeze_date is None else freeze_date
    if not freeze:
        return 0
    chash = joint_history.get("config_hash")
    if ledger.get("entries") and ledger.get("config_hash") not in (None, chash):
        raise RuntimeError(
            "joint model settings changed after the freeze "
            f"({ledger.get('config_hash')} -> {chash}); the test must be restarted")
    logged = {e.get("match_id") for e in ledger["entries"]}
    live = {}
    for d in cmdr_history.get("duels") or []:
        if d.get("source") == "telemetry" and d.get("match_id"):
            c1 = (d.get("commanders") or {}).get("1") or {}
            live[d["match_id"]] = c1.get("expected")
    todo = [
        r for r in joint_history.get("duels") or []
        if r.get("source") == "telemetry" and r.get("match_id")
        and str(r.get("date") or "") > freeze
        and r["match_id"] not in logged
        and r.get("outcome") in ("team1", "team2")
    ]
    if not todo:
        return 0
    base = baseline()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    added = 0
    for r in sorted(todo, key=lambda r: (r["date"], r["match_id"])):
        mid = r["match_id"]
        if not isinstance(base.get(mid), (int, float)) or not isinstance(live.get(mid), (int, float)):
            continue
        ledger["entries"].append({
            "match_id": mid,
            "date": r["date"],
            "outcome": r["outcome"],
            "p_joint": round(float(r["expected"]), 6),
            "p_baseline": round(float(base[mid]), 6),
            "p_live": round(float(live[mid]), 6),
            "logged_at": now,
        })
        added += 1
    ledger["schema_version"] = LEDGER_SCHEMA_VERSION
    ledger["freeze_date"] = freeze
    ledger["config_hash"] = chash
    return added


# ---------------------------------------------------------------------------
# Score
# ---------------------------------------------------------------------------

def _loss(p: float, y: float) -> float:
    p = min(1.0 - 1e-9, max(1e-9, p))
    return -(y * math.log(p) + (1.0 - y) * math.log(1.0 - p))


def _mean_se(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    m = sum(xs) / n
    var = sum((x - m) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
    return m, math.sqrt(var / n)


def calibration_slope(ps: list[float], ys: list[float]) -> tuple[float, float]:
    """(slope, standard error) of y on logit(p). 1.0 = the stated chances
    are right; below 1 = too extreme."""
    xs = [math.log(min(1 - 1e-9, max(1e-9, p)) / (1 - min(1 - 1e-9, max(1e-9, p)))) for p in ps]
    a = b = 0.0
    h00 = h01 = h11 = 1.0
    for _ in range(60):
        g0 = g1 = h00 = h01 = h11 = 0.0
        for x, y in zip(xs, ys):
            q = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, a + b * x))))
            w = q * (1.0 - q)
            g0 += y - q
            g1 += (y - q) * x
            h00 += w
            h01 += w * x
            h11 += w * x * x
        det = h00 * h11 - h01 * h01
        if abs(det) < 1e-12:
            return float("nan"), float("nan")
        da = (h11 * g0 - h01 * g1) / det
        db = (-h01 * g0 + h00 * g1) / det
        a += da
        b += db
        if max(abs(da), abs(db)) < 1e-10:
            break
    det = h00 * h11 - h01 * h01
    return b, math.sqrt(h00 / det) if det > 0 else float("nan")


def score_ledger(ledger: dict[str, Any]) -> dict[str, Any]:
    """Apply the registered rule. Status is one of `not_started`,
    `running`, `passed`, `withdrawn`, `ended`."""
    entries = sorted(ledger.get("entries") or [], key=lambda e: (e["date"], e["match_id"]))
    out: dict[str, Any] = {
        "available": True,
        "freeze_date": ledger.get("freeze_date"),
        "config_hash": ledger.get("config_hash"),
        "duels": len(entries),
        "looks_at": list(LOOKS),
        "pass_se": PASS_SE,
        "guard_se": GUARD_SE,
        "looks": [],
        "status": "not_started" if not ledger.get("freeze_date") else "running",
        "next_look": None,
    }
    if not entries:
        if ledger.get("freeze_date"):
            out["next_look"] = LOOKS[0]
        return out

    def stats(rows: list[dict]) -> dict[str, Any]:
        ys = [1.0 if e["outcome"] == "team1" else 0.0 for e in rows]
        lj = [_loss(e["p_joint"], y) for e, y in zip(rows, ys)]
        lb = [_loss(e["p_baseline"], y) for e, y in zip(rows, ys)]
        ll = [_loss(e["p_live"], y) for e, y in zip(rows, ys)]
        gain, se = _mean_se([b - j for b, j in zip(lb, lj)])
        live_gain, _ = _mean_se([l - j for l, j in zip(ll, lj)])
        slope, slope_se = calibration_slope([e["p_joint"] for e in rows], ys)
        n = len(rows)
        return {
            "n": n,
            "log_loss_joint": round(sum(lj) / n, 4),
            "log_loss_baseline": round(sum(lb) / n, 4),
            "log_loss_live": round(sum(ll) / n, 4),
            "accuracy_joint": round(sum(1 for e, y in zip(rows, ys) if (e["p_joint"] > 0.5) == (y == 1.0)) / n, 4),
            "accuracy_baseline": round(sum(1 for e, y in zip(rows, ys) if (e["p_baseline"] > 0.5) == (y == 1.0)) / n, 4),
            "gain": round(gain, 4),
            "gain_se": round(se, 4),
            "z": round(gain / se, 2) if se > 0 else 0.0,
            "gain_over_live": round(live_gain, 4),
            "calibration_slope": round(slope, 3) if slope == slope else None,
            "calibration_slope_se": round(slope_se, 3) if slope_se == slope_se else None,
        }

    out["running"] = stats(entries)
    for look in LOOKS:
        if len(entries) < look:
            if out["status"] == "running":
                out["next_look"] = look
            break
        s = stats(entries[:look])
        guard = (s["calibration_slope"] is not None
                 and s["calibration_slope"] + GUARD_SE * s["calibration_slope_se"] < 1.0)
        s["look"] = look
        s["over_confident"] = bool(guard)
        s["ahead_of_live"] = s["gain_over_live"] > 0
        s["passed"] = bool(s["z"] >= PASS_SE and not guard and s["ahead_of_live"])
        s["withdraw"] = bool(s["z"] <= -WITHDRAW_SE)
        out["looks"].append(s)
        if out["status"] != "running":
            continue
        if s["withdraw"]:
            out["status"] = "withdrawn"
        elif s["passed"]:
            out["status"] = "passed"
        elif look == LOOKS[-1]:
            out["status"] = "ended"
    return out
