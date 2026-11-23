#!/usr/bin/env python3
"""Build the data behind the Playstyle Analysis page (/_analysis/).

Standalone and run by hand after scripts/process_stats.py, like
scripts/validate_elo.py. It reads the raw recordings for timing metrics
(weapon switching, reload timing on switch-backs, alternation rhythm,
silent ammo drops), joins the processed per-match stats, and writes

    _analysis/data/index.json        page data (columnar tables)
    _analysis/data/match/<id>.json   drill-down tick lanes, loaded on demand

Per-match raw results are cached in _analysis/.cache/ (gitignored), keyed
by the processed and raw files' size and mtime plus SCRIPT_VERSION.

    python scripts/build_analysis_data.py [--jobs N] [--force] [--only ID]

Rating-inert: scripts/process_stats.py, scripts/elo*.py and
js/all-matches-aggregator.js never read _analysis/. Metric definitions and
the data contract: _analysis/README.md.
"""

from __future__ import annotations

import argparse
import bisect
import collections
import contextlib
import io
import json
import math
import os
import random
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import odf_fit
from odf_fit import flag as _bool, num as _num, sections as _sections, stem as _stem

SCRIPT_VERSION = 9
SCHEMA_VERSION = 1

ROOT = Path(__file__).resolve().parent.parent
PROCESSED = ROOT / "data" / "processed"
SESSIONS = ROOT / "data" / "sessions"
ODF_DB = ROOT / "data" / "odf.min.json"
OUT_DIR = ROOT / "_analysis" / "data"
CACHE_DIR = ROOT / "_analysis" / ".cache"

HZ = 20                    # the usual recording rate; 30 and 60 Hz matches exist

# Windows are in seconds and converted per match, since recordings run at 20, 30 or 60 Hz.
SWITCH_MAX_GAP_S = 1.0     # a longer pause between firing ticks is not a switch
SWITCHBACK_EXTRA_S = 1.0   # switch-back window = R + max(1 s, R)
RHYTHM_EXTRA_S = 0.3       # rhythm cycle window = R + max(0.3 s, R); 12 ticks for Dragon Blast
STREAK_MIN_CYCLES = 10
BIN_MS = 50                # histogram bins; one 20 Hz tick
DOT_BINS = 1               # on the dot: margin <= 50 ms after the weapon is ready
SEAM_BINS = 1              # seamless: partner fire lost <= 50 ms
MARGIN_CAP = 20            # margin bins 0..20 (20 = 1 s or more)
DEAD_CAP = 10              # dead-time bins 0..10 (10 = 500 ms or more)
PERM_SHUFFLES = 1000
PERM_BATCH = 100
PERM_STOP = 20             # stop shuffling once p can no longer fall below EVEN_P
EVEN_P = 0.01
CLOCK_SPREAD_MS = 55       # a clock-perfect run keeps its linear-fit spread at or below this
CLOCK_MIN_CYCLES = 10
FLAG_MIN_SHORT = 5         # a weapon is flagged when short gaps are systematic, not occasional
FLAG_SHORT_SHARE = 0.01
DESYNC_MIN_SHORT = 3       # one player-match whose barrels drifted onto separate reloads
DESYNC_SHORT_SHARE = 0.05
JITTER_GRID_MS = (0, 2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40)
JITTER_SIMS = 100
JITTER_OVER = 50           # sentinel: implied jitter above the grid (">40 ms")
DROP_MIN, DROP_MAX = -260, -60
DROP_TOL = 6               # a drop is within this much of an item the ship can drop; a morph's rescale isn't
DROP_NEAR_S = 1.0
ARMORY_ROOTS = {"i": "ibrecy_vsr", "e": "ebrecym_vsr", "f": "fbrecy_vsr"}
RECORDER_CHANGE = "2026-10-18"
SLOT_CREDIT_SHARE = 0.05   # player hits whose victim ODF is not the victim's ship; clean recordings sit near 0
SLOT_MIN_HITS = 100
SIZE_BUDGET = 10 * 1024 * 1024
LANE_PAD_S = 0.5
LANE_MAX_S = 300           # drill-down lane budget per player-match; streak windows first
LANE_SLOW_S = 0.5          # switch-back windows are kept for anchors reloading at least this long

# ---------------------------------------------------------------------------
# ODF reload model (a port of the js/weapons-calc.js rules that matter here)
# ---------------------------------------------------------------------------

WEAPON_DEFAULTS = {
    "weapon": {"salvocount": 1, "salvodelay": 0, "lockdelay": 0},
    "cannon": {"shotdelay": 0.2},
    "salvo": {"shotdelay": 0.2},
    "mortar": {"shotdelay": 1.0},
    "targeting": {"shotdelay": 1.0, "salvocount": 10, "salvodelay": 0.2},
    "launcher": {"shotdelay": 0, "lockdelay": 5.0},
    "dispenser": {"shotdelay": 0},
    "satchelpack": {"shotdelay": 1.0},
    "arccannon": {"salvodelay": 0.1},
}
WEAPON_PARENT = {
    "cannon": "weapon", "machinegun": "cannon", "mortar": "cannon", "chargegun": "cannon",
    "detonator": "cannon", "salvo": "weapon", "targeting": "weapon", "launcher": "weapon",
    "imagelauncher": "launcher", "thermallauncher": "launcher", "radarlauncher": "launcher",
    "multilauncher": "launcher", "torpedolauncher": "launcher", "dispenser": "weapon",
    "satchelpack": "weapon", "arccannon": "weapon", "damagefield": "weapon", "jetpack": "weapon",
    "specialitem": "weapon", "imagerefract": "specialitem", "radardamper": "specialitem",
    "terrainexpose": "specialitem", "forcefield": "specialitem", "magnetgun": "weapon",
    "blink": "weapon", "shieldup": "weapon", "daywrecker": "weapon",
}
ORD_DEFAULTS = {
    "ordnance": {"ammocost": 0},
    "bullet": {"ammocost": 1},
    "beam": {"ammocost": 1},
    "grenade": {"ammocost": 10},
    "missile": {"ammocost": 10},
    "pulse": {"ammocost": 10},
    "magnetshell": {"ammocost": 10},
}
ORD_PARENT = {
    "bullet": "ordnance", "beam": "bullet", "grenade": "bullet", "bouncebomb": "grenade",
    "popper": "grenade", "radarpopper": "grenade", "laserpopper": "grenade", "spraybomb": "grenade",
    "missile": "bullet", "thermalmissile": "missile", "imagemissile": "missile",
    "lasermissile": "missile", "radarmissile": "missile", "pulse": "bullet",
    "magnetshell": "bullet", "snipershell": "bullet", "leader": "bullet", "lockdown": "bullet",
    "anchor": "leader", "seismic": "ordnance",
}
LAUNCHER_TERMINALS = {
    "launcher", "imagelauncher", "thermallauncher", "radarlauncher", "multilauncher", "torpedolauncher",
}
UTILITY_TERMINALS = {
    "shieldup", "jetpack", "blink", "imagerefract", "terrainexpose", "radardamper",
    "magnetgun", "forcefield", "daywrecker", "specialitem", "damagefield",
}
FIRE_SECTIONS = [
    "cannonclass", "launcherclass", "multilauncherclass", "torpedolauncherclass",
    "targetinggunclass", "salvolauncherclass", "remotedetonatorclass", "dispenserclass",
    "satchelpackclass", "chargegunclass", "arccannonclass", "damagefieldclass",
    "jetpackclass", "specialitemclass", "forcefieldclass", "magnetgunclass",
    "blinkdeviceclass", "shieldupgradeclass", "daywreckerclass",
]
PREFERRED_FIRE = {
    "targeting": ["targetinggunclass"], "dispenser": ["dispenserclass"],
    "satchelpack": ["satchelpackclass"], "chargegun": ["chargegunclass"],
    "arccannon": ["arccannonclass"], "damagefield": ["damagefieldclass"],
    "jetpack": ["jetpackclass"], "magnetgun": ["magnetgunclass"], "blink": ["blinkdeviceclass"],
}


def _terminal(entry):
    chain = entry.get("inheritanceChain")
    if isinstance(chain, list) and chain:
        return str(chain[-1]).lower()
    return ""


def _default(table, parents, terminal, key):
    t, seen = terminal, set()
    while t and t not in seen:
        seen.add(t)
        if key in table.get(t, {}):
            return table[t][key]
        t = parents.get(t)
    base = table.get("weapon") or table.get("ordnance") or {}
    return base.get(key)


def _ticks(seconds, hz):
    return max(1, math.ceil(seconds * hz - 1e-6))


def _bin(ticks, hz):
    """50 ms bin of a tick count: 0 = none, 1 = up to 50 ms, 2 = up to 100 ms..."""
    return math.ceil(ticks * 1000.0 / hz / BIN_MS - 1e-9)


class OdfModel:
    """Effective reload per (ship, weapon), resolved from data/odf.min.json."""

    def __init__(self, db):
        self.fit = odf_fit.HardpointFit(db)
        self.buckets = self.fit.buckets
        self.weapons = {stem: self._weapon_info(stem, self.buckets["Weapon"][stem])
                        for stem in sorted(self.buckets.get("Weapon", {}))}
        self.by_ord = self.fit.by_ord
        # Ordnance no weapon fires directly (Splinter fragments, flare and mine
        # payloads, pop-up grenades) is spawned by other ordnance, not by a trigger.
        self.secondary = {s for s in self.buckets.get("Ordnance", {}) if s not in self.by_ord}
        self.dispensers = {s for s, w in self.weapons.items() if w["terminal"] == "dispenser"}
        self.armory = {fac: self._armory(root) for fac, root in ARMORY_ROOTS.items()}
        self._ships = {}
        self._resolved = {}

    def _armory(self, root):
        """Dispensers a faction sells: its recycler's build tree, walked as js/weapons-calc.js does."""
        found, seen, stack = set(), set(), [root]
        while stack:
            s = stack.pop()
            if s in seen:
                continue
            seen.add(s)
            bucket = next((b for b, d in self.buckets.items() if s in d), None)
            if bucket is None:
                continue
            secs = _sections(self.buckets[bucket][s])
            if bucket == "Powerup":
                w = _stem(secs.get("weaponpowerupclass", {}).get("weaponname"))
                if w in self.dispensers:
                    found.add(w)
            for name, sec in secs.items():
                if name in ("factoryclass", "constructionrigclass") or (
                        name.startswith("armorygroup") and name[11:].isdigit()):
                    stack += [_stem(v) for k, v in sec.items() if k.startswith("builditem") and k[9:].isdigit()]
            up = _stem(secs.get("gameobjectclass", {}).get("upgradename"))
            if up:
                stack.append(up)
        return found

    def _ord_cost(self, ord_stem, secs):
        rec = self.buckets.get("Ordnance", {}).get(ord_stem)
        if rec is not None:
            n = _num(_sections(rec).get("ordnanceclass", {}).get("ammocost"))
            if n is not None:
                return n
            d = _default(ORD_DEFAULTS, ORD_PARENT, _terminal(rec), "ammocost")
            return float(d or 0)
        n = _num(secs.get("ordnance.ordnanceclass", {}).get("ammocost"))
        return n if n is not None else 1.0

    def _weapon_info(self, stem, entry):
        secs = _sections(entry)
        terminal = _terminal(entry)
        wc = secs.get("weaponclass", {})
        order = PREFERRED_FIRE.get(terminal, ["launcherclass"] if terminal in LAUNCHER_TERMINALS else [])
        merged = {}
        for name in order + FIRE_SECTIONS:
            for k, v in secs.get(name, {}).items():
                merged.setdefault(k, v)

        def val(key):
            n = _num(merged.get(key))
            if n is not None:
                return n
            d = _default(WEAPON_DEFAULTS, WEAPON_PARENT, terminal, key)
            return float(d) if d is not None else 0.0

        shot_delay = val("shotdelay")
        salvo_count = max(1, int(round(val("salvocount") or 1)))
        salvo_delay = val("salvodelay") if salvo_count > 1 else 0.0
        isd_raw = secs.get("cannonclass", {}).get("initialshotdelay")
        if isd_raw is None:
            isd_raw = secs.get("dispenserclass", {}).get("initialshotdelay")
        isd = max(0.0, _num(isd_raw, 0.0))
        lock = val("lockdelay") if terminal in LAUNCHER_TERMINALS else 0.0
        charge = terminal == "chargegun" or any(
            k.startswith("shotdelay") and k[9:].isdigit() for k in merged
        )
        ord_stem = _stem(wc.get("ordname"))
        if terminal in UTILITY_TERMINALS:
            why = "utility"
        elif terminal == "dispenser":
            why = "dispenser"
        elif charge:
            why = "charge"
        elif terminal == "targeting":
            why = "tag-salvo"
        elif terminal in LAUNCHER_TERMINALS and lock > 0:
            why = "lock-on"
        elif shot_delay <= 0:
            why = "no-delay"
        else:
            why = None
        return {
            "stem": stem,
            "name": str(wc.get("wpnname") or stem).strip().replace('"', "'"),
            "cat": str(wc.get("wpncategory") or "").strip().upper()[:4],
            "assault": _bool(wc.get("isassault"), False),
            "terminal": terminal,
            "ord": ord_stem or None,
            "sd": shot_delay,
            "alt": _bool(merged.get("shotalternate"), False),
            "sc": salvo_count,
            "sdl": salvo_delay,
            "isd": isd,
            "lock": lock,
            "cost": self._ord_cost(ord_stem, secs) if ord_stem else 0.0,
            # A drop costs the dropped object's maxAmmo (Prox Mine 200, MFF Mine 100).
            "drop_cost": _num(secs.get("dispenserobj.gameobjectclass", {}).get("maxammo"))
            if terminal == "dispenser" else None,
            "why": why,
        }

    def ship(self, stem):
        if stem in self._ships:
            return self._ships[stem]
        base = self.fit.ship(stem)
        entry, bucket = self.fit.lookup(stem)
        info = {"stem": stem, "name": stem, "pilot": "user_m" in stem, "hps": base["hps"],
                "hps_deployed": base["hps_deployed"], "morph": base["morph"], "max_ammo": 0.0,
                "add_ammo": 0.0, "known": base["known"]}
        if entry is not None:
            go = _sections(entry).get("gameobjectclass", {})
            info.update({
                "name": str(go.get("unitname") or stem).strip().replace('"', "'"),
                "pilot": bucket == "Pilot" or _terminal(entry) == "person",
                "max_ammo": _num(go.get("maxammo"), 0.0),
                "add_ammo": _num(go.get("addammo"), 0.0),
            })
        info["can_drop"] = any(hp["cat"] == "SPEC" for hp in info["hps"]) or any(
            hp["stock"] in self.dispensers for hp in info["hps"]
        )
        # What a drop of each size is on this ship: its stock item of that size, else what its faction's
        # armory sells at that size ("MITS Mine or Solar Flare" on ISDF). Only sizes the ammo residual
        # can see; a Flame Mine (300) or Snare (300) can't be.
        def visible(c):
            return -DROP_MAX <= (c or 0) <= -DROP_MIN
        stock, sold = {}, collections.defaultdict(set)
        for hp in info["hps"]:
            w = self.weapons[hp["stock"]] if hp["stock"] in self.dispensers else None
            if w and visible(w["drop_cost"]):
                stock.setdefault(w["drop_cost"], self._drop_name(w["name"]))
        if any(hp["cat"] == "SPEC" for hp in info["hps"]):
            for s in sorted(self.armory.get(stem[:1], ())):
                w = self.weapons[s]
                if visible(w["drop_cost"]) and self._fitting(info, w):
                    sold[w["drop_cost"]].add(self._drop_name(w["name"]))
        info["drop_items"] = {c: stock.get(c) or " or ".join(sorted(sold[c])) for c in sorted({*stock, *sold})}
        info["stock_drop"] = next(iter(stock.values()), None)
        self._ships[stem] = info
        return info

    @staticmethod
    def _drop_name(name):
        # "MFF MINE" -> "MFF Mine"; acronyms of three letters or fewer stay upper case.
        if not name.isupper():
            return name
        return " ".join(w if len(w) <= 3 else w.capitalize() for w in name.split())

    @staticmethod
    def _fitting(sh, w):
        return odf_fit.fitting(sh, w["cat"], w["assault"])

    def resolve(self, ship_stem, ord_stem, hz=HZ):
        """Which weapon fired an ordnance from this ship, its group and its reload in ticks."""
        key = (ship_stem, ord_stem, hz)
        hit = self._resolved.get(key)
        if hit is not None:
            return hit
        sh = self.ship(ship_stem)
        cands = self.by_ord.get(ord_stem, [])
        if not cands:
            why = "secondary" if ord_stem in self.secondary else "unknown"
            res = {"w": "ord:" + ord_stem, "g": "o:" + ord_stem, "R": None, "Rmin": None, "isd": 0,
                   "cost": 1.0, "merge": 0, "hp": 1, "why": why}
            self._resolved[key] = res
            return res
        stock = {hp["stock"] for hp in sh["hps"] if hp["stock"]}
        fitting = []
        for stem in cands:
            hps = self._fitting(sh, self.weapons[stem])
            if hps:
                fitting.append((stem, hps))

        def rank(item):
            stem = item[0]
            return (0 if stem in stock else 1, 0 if "vsr" in stem else 1, stem)

        if fitting:
            stem, hps = sorted(fitting, key=rank)[0]
        else:
            stem = sorted(cands, key=lambda s: (0 if "vsr" in s else 1, s))[0]
            hps = [hp for hp in sh["hps"] if hp["cat"] == self.weapons[stem]["cat"]]
        res = self._reload(sh, stem, hps, hz)
        self._resolved[key] = res
        return res

    def can_fire(self, ship_stem, ord_stem):
        """Whether the ship could have fired this ordnance itself.

        The first recordings credited a commander with his team's AI defences
        (an ISDF Turret's assault Minigun while he stood on foot); those shots
        fit no hardpoint and never touched his ammo."""
        return self.fit.can_fire(ship_stem, ord_stem)

    def weapon_on(self, ship_stem, stem, hz=HZ):
        """Reload of a known weapon mounted on a ship (the reference table)."""
        sh = self.ship(ship_stem)
        w = self.weapons[stem]
        hps = self._fitting(sh, w) or [hp for hp in sh["hps"] if hp["cat"] == w["cat"]]
        return self._reload(sh, stem, hps, hz)

    def _reload(self, sh, stem, hps, hz):
        w = self.weapons[stem]
        forced = sh["pilot"] or w["cat"] in ("HAND", "PACK")
        n_hp = 1 if forced else max(1, len(hps))
        groups = sorted({hp["group"] for hp in hps if hp["group"] is not None})
        if groups:
            group = "g%d" % groups[0]
        else:
            group = (w["cat"] or "?") + ("a" if w["assault"] else "c")
        reload_ticks = min_ticks = None
        merge = 0
        if w["why"] is None:
            sd = w["sd"] / n_hp if (w["alt"] and n_hp > 1) else w["sd"]
            reload_ticks = _ticks(sd, hz)
            # The engine carries leftover reload time into the next shot and the
            # recording samples it, so a single gap can land one tick short.
            min_ticks = max(1, reload_ticks - 1)
            if n_hp > 1 and not w["alt"]:
                # Barrels of one group can report a tick apart; they are one volley.
                merge = (min_ticks - 1) // 2
        if w["sc"] > 1:
            merge = max(merge, math.ceil(w["sdl"] * hz * (w["sc"] - 1) - 1e-6))
        return {
            "w": stem,
            "g": group,
            "R": reload_ticks,
            "Rmin": min_ticks,
            "isd": _ticks(w["isd"], hz) if w["isd"] > 0 else 0,
            "cost": w["cost"],
            "merge": merge,
            "hp": n_hp,
            "why": w["why"],
        }


# ---------------------------------------------------------------------------
# Streak statistics
# ---------------------------------------------------------------------------

def _fit(ts):
    """Least-squares period and residual spread of a tick sequence."""
    n = len(ts)
    if n < 3:
        return (float(ts[-1] - ts[0]) if n == 2 else 0.0), 0.0
    mx = (n - 1) / 2.0
    my = sum(ts) / n
    sxx = n * (n * n - 1) / 12.0
    slope = sum((x - mx) * t for x, t in enumerate(ts)) / sxx
    lo = hi = None
    for x, t in enumerate(ts):
        r = t - (my + slope * (x - mx))
        if lo is None or r < lo:
            lo = r
        if hi is None or r > hi:
            hi = r
    return slope, hi - lo


def _testable(gaps, reload_ticks):
    # The shuffle test needs interchangeable gaps. A gap shorter than the
    # reload is the engine's carry and can only follow a late shot, so a
    # streak holding one is not tested.
    if min(gaps) < reload_ticks:
        return False
    counts = collections.Counter(gaps)
    mode = counts.most_common(1)[0][1]
    return len(gaps) - mode >= 3 and mode >= 3


def _perm_p(gaps, observed, rng):
    """Share of shuffles of the streak's own gaps at least as even as observed."""
    gg = list(gaps)
    hits = done = 0
    while done < PERM_SHUFFLES:
        for _ in range(PERM_BATCH):
            rng.shuffle(gg)
            t, ts = 0, [0]
            for g in gg:
                t += g
                ts.append(t)
            if _fit(ts)[1] <= observed + 1e-9:
                hits += 1
        done += PERM_BATCH
        if hits >= PERM_STOP:
            break
    return (hits + 1) / (done + 1)


def _sim_spread(n, period, sigma, min_gap, rng):
    phase = rng.random()
    prev, ts = None, []
    for k in range(n + 1):
        d = math.ceil(phase + k * period + (rng.gauss(0.0, sigma) if sigma else 0.0))
        if prev is not None and d < prev + min_gap:
            d = prev + min_gap
        ts.append(d)
        prev = d
    return _fit(ts)[1]


def _implied_jitter(n, period, observed, min_gap, tick_ms, rng):
    """Per-shot timing noise (ms) at which a perfect clock matches the observed spread."""
    prev_u = prev_s = None
    for s in JITTER_GRID_MS:
        sigma = s / tick_ms
        tighter = 0.0
        for _ in range(JITTER_SIMS):
            sp = _sim_spread(n, period, sigma, min_gap, rng)
            if sp < observed - 1e-9:
                tighter += 1
            elif abs(sp - observed) <= 1e-9:
                tighter += 0.5
        u = tighter / JITTER_SIMS
        if u <= 0.5:
            if prev_u is None:
                return 0.0
            return prev_s + (prev_u - 0.5) * (s - prev_s) / (prev_u - u)
        prev_u, prev_s = u, s
    return float(JITTER_OVER)


def _clock_run(ts, tick_ms):
    """Longest run of consecutive cycles whose own linear-fit spread stays <= CLOCK_SPREAD_MS."""
    limit = CLOCK_SPREAD_MS / tick_ms
    best, i = 0, 0
    for j in range(1, len(ts)):
        while j - i >= 2 and _fit(ts[i:j + 1])[1] > limit:
            i += 1
        best = max(best, j - i)
    return best


def _encode_gaps(gaps):
    if gaps and max(gaps) < 36 and min(gaps) >= 0:
        return "".join("0123456789abcdefghijklmnopqrstuvwxyz"[g] for g in gaps)
    return "," + ",".join(str(g) for g in gaps)


def _median_counter(counter):
    total = sum(counter.values())
    if not total:
        return None
    lo_rank, hi_rank = (total - 1) // 2, total // 2
    acc, lo_val, hi_val = 0, None, None
    for value in sorted(counter):
        nxt = acc + counter[value]
        if lo_val is None and lo_rank < nxt:
            lo_val = value
        if hi_val is None and hi_rank < nxt:
            hi_val = value
            break
        acc = nxt
    return (lo_val + hi_val) / 2.0


# ---------------------------------------------------------------------------
# Per-match analysis (runs in worker processes)
# ---------------------------------------------------------------------------

_MODEL = None
_PS = None
_ALIASES = None


def _worker_init():
    global _MODEL, _PS, _ALIASES
    sys.path.insert(0, str(ROOT / "scripts"))
    import identity_aliases  # noqa: E402
    import process_stats  # noqa: E402
    _PS, _ALIASES = process_stats, identity_aliases
    with open(ODF_DB, encoding="utf-8") as fh:
        _MODEL = OdfModel(json.load(fh))


def _stat(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return [st.st_size, int(st.st_mtime)]


def _new_switch():
    return {"n": 0, "act": 0, "h": [0, 0, 0, 0], "gaps": collections.Counter(),
            "vol": 0, "mt": 0, "pairs": collections.Counter(),
            "rtn": 0, "rt1": 0, "rtoc": 0, "rteq": 0, "rtgt": 0, "rtg": collections.Counter(),
            "rtp": collections.Counter()}


def _top_pair(counter):
    if not counter:
        return None
    (a, b), c = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    return [a, b, c]


def _finish_switch(s, hz):
    med = _median_counter(s["gaps"])
    rtmed = _median_counter(s["rtg"])
    return {
        "n": s["n"], "act": round(s["act"] / hz, 2), "h": s["h"], "vol": s["vol"], "mt": s["mt"],
        "med": None if med is None else round(med * 1000.0 / hz, 1), "pair": _top_pair(s["pairs"]),
        "rtn": s["rtn"], "rt1": s["rt1"], "rtoc": s["rtoc"], "rteq": s["rteq"], "rtgt": s["rtgt"],
        "rtmed": None if rtmed is None else round(rtmed * 1000.0 / hz, 1), "rtpair": _top_pair(s["rtp"]),
    }


class _Volley:
    __slots__ = ("t", "last", "ship", "w", "g", "R", "Rmin", "isd", "cost", "merge", "n")

    def __init__(self, t, ship, res):
        self.t = self.last = t
        self.ship = ship
        self.w, self.g, self.R, self.Rmin = res["w"], res["g"], res["R"], res["Rmin"]
        self.isd, self.cost, self.merge = res["isd"], res["cost"], res["merge"]
        self.n = 1


def _analyze_player(mid, pid, shots, st_t, st_odf, st_ammo, ship_names, hz):
    model = _MODEL
    tick_ms = 1000.0 / hz
    switch_max = round(SWITCH_MAX_GAP_S * hz)
    sb_extra = round(SWITCHBACK_EXTRA_S * hz)
    rh_extra = round(RHYTHM_EXTRA_S * hz)
    drop_near = round(DROP_NEAR_S * hz)
    lane_pad = round(LANE_PAD_S * hz)
    lane_slow = round(LANE_SLOW_S * hz)

    shots.sort(key=lambda s: s[0])
    recs = []
    skipped = collections.Counter()
    for t, ordn in shots:
        i = bisect.bisect_right(st_t, t) - 1
        ship = ship_names[st_odf[i]] if i >= 0 else ""
        res = model.resolve(ship, ordn, hz)
        if res["why"] in ("unknown", "secondary"):
            skipped[(res["why"], ordn)] += 1
            if res["why"] == "secondary":
                continue
        elif not model.can_fire(ship, ordn):
            skipped[("foreign", ordn)] += 1
            continue
        recs.append((t, ship, res))

    # Volleys: same-tick shots of one weapon, adjacent barrels and one salvo count once.
    vols, last = [], {}
    for t, ship, res in recs:
        key = (ship, res["w"])
        j = last.get(key)
        if j is not None:
            v = vols[j]
            if t == v.last or (v.merge and t - v.t <= v.merge):
                v.n += 1
                v.last = t
                continue
        vols.append(_Volley(t, ship, res))
        last[key] = len(vols) - 1

    # Weapon switching over firing ticks.
    tick_groups, tick_ship, tick_rep, tick_R = {}, {}, {}, {}
    for t, ship, res in recs:
        groups = tick_groups.setdefault(t, set())
        groups.add(res["g"])
        tick_ship.setdefault(t, ship)
        rep = tick_rep.setdefault(t, {})
        if res["g"] not in rep or res["w"] < rep[res["g"]]:
            rep[res["g"]] = res["w"]
            tick_R.setdefault(t, {})[res["g"]] = res["R"]
    sw_all = _new_switch()
    sw_ship = collections.defaultdict(_new_switch)
    ticks = sorted(tick_groups)
    for t in ticks:
        for s in (sw_all, sw_ship[tick_ship[t]]):
            s["vol"] += 1
            if len(tick_groups[t]) > 1:
                s["mt"] += 1
    for t1, t2 in zip(ticks, ticks[1:]):
        gap = t2 - t1
        # Leaving a ship for the pilot's Pulse (or back) is not a weapon switch.
        if gap > switch_max or tick_ship[t1] != tick_ship[t2]:
            continue
        targets = (sw_all, sw_ship[tick_ship[t2]])
        disjoint = tick_groups[t1].isdisjoint(tick_groups[t2])
        if disjoint:
            a = min(tick_rep[t1].values())
            b = min(tick_rep[t2].values())
            pair = (a, b) if a <= b else (b, a)
            hbin = min(max(_bin(gap, hz), 1), 4) - 1
        for s in targets:
            s["act"] += gap
            if disjoint:
                s["n"] += 1
                s["h"][hbin] += 1
                s["gaps"][gap] += 1
                s["pairs"][pair] += 1

    # Round trips: runs of one group A, then B (reloading no faster), then A again.
    # Switching out while holding fire costs nothing, so only the way back is timed,
    # from the moment A could fire again: after B's last shot, or when A's own reload
    # ends if that is later. Firing on that first possible tick is one tick either way,
    # so a return held up by A's reload gets no free tick. A tick firing two groups
    # breaks the chain.
    chain, chain_last, prev_t = [], {}, None
    for t in ticks:
        groups = tick_groups[t]
        if (prev_t is None or len(groups) > 1 or t - prev_t > switch_max
                or tick_ship[t] != tick_ship[prev_t]):
            chain, chain_last = [], {}
        prev_t = t
        if len(groups) > 1:
            continue
        (g,) = groups
        R = tick_R[t][g]
        if chain and chain[-1][0] == g:
            chain[-1][2], chain[-1][3] = t, R
            continue
        # run: group, first tick, last tick, reload, weapon, this group's previous run
        run = [g, t, t, R, tick_rep[t][g], chain_last.get(g)]
        chain.append(run)
        chain_last[g] = run
        if len(chain) < 3:
            continue
        a, b = chain[-3], chain[-2]
        if a[0] != g or a[3] is None or b[3] is None or b[3] < a[3]:
            continue
        a_ready = a[2] + a[3] - 1
        wait = max(1, t - max(b[2], a_ready))
        b_ready = b[5][2] + b[3] if b[5] is not None else None
        out = b[1] - (a[2] if b_ready is None else max(a[2], b_ready))
        pair = (a[4], b[4]) if a[4] <= b[4] else (b[4], a[4])
        for s in (sw_all, sw_ship[tick_ship[t]]):
            s["rtn"] += 1
            s["rt1"] += _bin(wait, hz) <= 1
            s["rtoc"] += out <= a[3]
            s["rteq"] += b[3] == a[3]
            s["rtgt"] += a_ready > b[2]
            s["rtg"][wait] += 1
            s["rtp"][pair] += 1

    # Reload timing on switch-backs, alternation rhythm, floors.
    vt = [v.t for v in vols]
    streams = collections.defaultdict(list)
    for idx, v in enumerate(vols):
        streams[(v.ship, v.w)].append(idx)
    blocks = {}
    held = {}
    stream_rows = []
    streak_rows = []
    lane_windows = []   # (priority, order, t0, t1, ship, anchor, R)
    sb_marks = collections.defaultdict(list)   # (ship, anchor) -> [b_tick, margin ticks, dead ticks]
    anchor_cycles = collections.Counter()      # (ship, anchor) -> rhythm cycles
    cycle_spans = collections.defaultdict(list)   # ship -> [(a_tick, b_tick, block key)] per counted cycle

    def ammo_at(t):
        i = bisect.bisect_right(st_t, t) - 1
        return st_ammo[i] if i >= 0 else None

    for (ship, w), idxs in sorted(streams.items()):
        first = vols[idxs[0]]
        R, Rmin = first.R, first.Rmin
        n_shots = sum(vols[i].n for i in idxs)
        min_gap, below = None, 0
        win_sb = R + max(sb_extra, R) if R else None
        win_rh = R + max(rh_extra, R) if R else None
        cur, cur_partners = [], collections.Counter()

        def close():
            if len(cur) - 1 >= STREAK_MIN_CYCLES:
                partner = sorted(cur_partners.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                streak_rows.append(_streak_row(mid, pid, ship, w, partner, list(cur), R, Rmin, tick_ms))
                lane_windows.append((0, -(len(cur) - 1), cur[0] - lane_pad, cur[-1] + lane_pad, ship, w, R))
            cur.clear()
            cur_partners.clear()

        for ia, ib in zip(idxs, idxs[1:]):
            va, vb = vols[ia], vols[ib]
            gap = vb.t - va.t
            min_gap = gap if min_gap is None else min(min_gap, gap)
            if R is None:
                continue
            if gap < Rmin:
                below += 1
                close()
                continue
            if gap > win_sb:
                close()
                continue
            lo = bisect.bisect_right(vt, va.t)
            hi = bisect.bisect_left(vt, vb.t)
            between = [k for k in range(lo, hi) if vols[k].g != va.g]
            if not between:
                h = held.setdefault((ship, w), {"R": R, "n": 0, "h0": 0, "hist": collections.Counter()})
                mbin = min(_bin(max(0, gap - R), hz), MARGIN_CAP)
                h["n"] += 1
                h["h0"] += mbin <= DOT_BINS
                h["hist"][mbin] += 1
                close()
                continue
            faster = [k for k in between if vols[k].R is not None and vols[k].R < R]
            if not faster:
                close()
                continue
            p = vols[faster[-1]]
            blk = blocks.setdefault((ship, w, p.w), {
                "R": R, "sb": 0, "dot": 0, "seam": 0, "perf": 0, "cyc": 0, "starv": 0, "din": 0,
                "hist": collections.Counter(), "ditem": collections.Counter(),
            })
            ammo = ammo_at(va.t + R)
            if ammo is not None and va.cost > 0 and ammo < va.cost * max(1, vb.n):
                blk["starv"] += 1
                close()
                continue
            margin = max(0, gap - (R + va.isd))
            dead = max(0, vb.t - p.t - p.R)
            mbin = min(_bin(margin, hz), MARGIN_CAP)
            dbin = min(_bin(dead, hz), DEAD_CAP)
            dot = mbin <= DOT_BINS
            seam = dbin <= SEAM_BINS
            blk["sb"] += 1
            blk["dot"] += dot
            blk["seam"] += seam
            blk["perf"] += dot and seam
            blk["hist"][(mbin, dbin)] += 1
            sb_marks[(ship, w)].append((vb.t, margin, dead))
            if R >= lane_slow:
                lane_windows.append((1, va.t, va.t - lane_pad, vb.t + lane_pad, ship, w, R))
            if gap <= win_rh:
                blk["cyc"] += 1
                anchor_cycles[(ship, w)] += 1
                cycle_spans[ship].append((va.t, vb.t, (ship, w, p.w)))
                if not cur:
                    cur.append(va.t)
                cur.append(vb.t)
                for k in faster:
                    cur_partners[vols[k].w] += 1
            else:
                close()
        close()
        min_gap_ms = None if min_gap is None else round(min_gap * tick_ms, 1)
        stream_rows.append([ship, w, len(idxs), n_shots, min_gap_ms, below if R else None, R, Rmin])

    # Silent ammo drops (mines, dispensers): residual after the shots' own cost. A drop inside a
    # counted cycle is credited to that cycle's pair, so Butterfingers counts drops and cycles alike.
    spent = collections.Counter()
    for t, ship, res in recs:
        spent[t] += res["cost"]
    anchors = {}
    for (ship, w), _n in sorted(anchor_cycles.items(), key=lambda kv: (-kv[1], kv[0])):
        if ship not in anchors:
            idxs = streams[(ship, w)]
            R = vols[idxs[0]].R
            anchors[ship] = ([vols[i].t for i in idxs], R + max(rh_extra, R), vols[idxs[0]].g)
    spans = {s: sorted(v) for s, v in cycle_spans.items()}
    span_t0 = {s: [x[0] for x in v] for s, v in spans.items()}
    span_len = {s: max(x[1] - x[0] for x in v) for s, v in spans.items()}
    drops = collections.defaultdict(lambda: [0, 0, 0])
    drop_rows = []
    for i in range(len(st_t) - 1):
        if st_t[i + 1] != st_t[i] + 1 or st_odf[i + 1] != st_odf[i]:
            continue
        ship = ship_names[st_odf[i]]
        sh = model.ship(ship)
        if not sh["can_drop"]:
            continue
        r = st_ammo[i + 1] - st_ammo[i] + spent.get(st_t[i], 0.0)
        cost = min(sh["drop_items"], key=lambda c: abs(r + c), default=None)
        if cost is None or abs(r + cost) > DROP_TOL:
            continue
        item = sh["drop_items"][cost]
        t = st_t[i]
        cls = 2
        # Overlapping cycles of two anchors: the drop goes to the pair cycled most.
        inside = []
        sp = spans.get(ship)
        if sp:
            j = bisect.bisect_right(span_t0[ship], t) - 1
            while j >= 0 and t - sp[j][0] <= span_len[ship]:
                if t < sp[j][1]:
                    inside.append(sp[j][2])
                j -= 1
        if inside:
            cls = 0
            blk = blocks[max(inside, key=lambda k: (blocks[k]["cyc"], k))]
            blk["din"] += 1
            blk["ditem"][item] += 1
        else:
            anc = anchors.get(ship)
            if anc:
                A, win, grp = anc
                k = bisect.bisect_right(A, t) - 1
                if k >= 0 and t - A[k] <= win:
                    lo = bisect.bisect_left(vt, t - drop_near)
                    hi = bisect.bisect_right(vt, t + drop_near)
                    if any(vols[j].g != grp for j in range(lo, hi)):
                        cls = 1
        drops[ship][cls] += 1
        drop_rows.append((t, int(round(r)), cls, ship, item))
    # A ship carried a droppable item if its stock one is visible, or if this player dropped
    # something from it in this match (a mine fitted in an empty special slot).
    carried = {s for s in {k[0] for k in blocks}
               if model.ship(s)["stock_drop"] or sum(drops.get(s, ())) > 0}

    lanes = _build_lanes(lane_windows, vols, vt, sb_marks, drop_rows, round(LANE_MAX_S * hz))

    return {
        "sw": {"all": _finish_switch(sw_all, hz),
               "ships": {s: _finish_switch(v, hz) for s, v in sorted(sw_ship.items())}},
        "reload": [[s, a, q, b["R"], b["sb"], b["dot"], b["seam"], b["perf"], b["cyc"], b["starv"],
                    sorted([m, d, c] for (m, d), c in b["hist"].items()), b["din"], 1 if s in carried else 0,
                    sorted([n, c] for n, c in b["ditem"].items())]
                   for (s, a, q), b in sorted(blocks.items())],
        "held": [[s, a, h["R"], h["n"], h["h0"], sorted([m, c] for m, c in h["hist"].items())]
                 for (s, a), h in sorted(held.items())],
        "streams": stream_rows,
        "streaks": streak_rows,
        "drops": {s: v for s, v in sorted(drops.items())},
        "lanes": lanes,
        "skipped": sorted([why, o, c] for (why, o), c in skipped.items()),
    }


def _streak_row(mid, pid, ship, anchor, partner, ts, reload_ticks, min_gap, tick_ms):
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    period, spread = _fit(ts)
    rng = random.Random(zlib.crc32(f"{mid}|{pid}|{ship}|{anchor}|{ts[0]}".encode()))
    p = _perm_p(gaps, spread, rng) if _testable(gaps, reload_ticks) else None
    jit = _implied_jitter(len(gaps), period, spread, min_gap, tick_ms, rng)
    return [ship, anchor, partner, ts[0], len(gaps), round(period * tick_ms, 2), round(spread, 3),
            None if p is None else round(p, 5), round(jit, 1), _clock_run(ts, tick_ms), _encode_gaps(gaps)]


def _build_lanes(windows, vols, vt, sb_marks, drop_rows, budget):
    if not windows:
        return []
    windows.sort(key=lambda w: (w[0], w[1], w[2]))
    by_key = collections.defaultdict(list)
    for _prio, _order, t0, t1, ship, anchor, R in windows:
        spans = by_key[(ship, anchor, R)]
        merged = [s for s in spans if t0 <= s[1] and t1 >= s[0]]
        if merged:
            lo = min([t0] + [s[0] for s in merged])
            hi = max([t1] + [s[1] for s in merged])
            extra = (hi - lo) - sum(s[1] - s[0] for s in merged)
            if extra > budget:
                continue
            budget -= extra
            for s in merged:
                spans.remove(s)
            spans.append([lo, hi])
        else:
            if t1 - t0 > budget:
                continue
            budget -= t1 - t0
            spans.append([t0, t1])
    out = []
    for (ship, anchor, R), spans in sorted(by_key.items()):
        for t0, t1 in sorted(spans):
            lo = bisect.bisect_left(vt, t0)
            hi = bisect.bisect_right(vt, t1)
            shots = [(vols[k].t - t0, vols[k].w) for k in range(lo, hi)]
            marks = [[b - t0, m, d] for b, m, d in sb_marks.get((ship, anchor), []) if t0 <= b <= t1]
            drops = [[t - t0, r, c, item] for t, r, c, s, item in drop_rows if s == ship and t0 <= t <= t1]
            out.append({"ship": ship, "a": anchor, "R": R, "t0": t0, "len": t1 - t0,
                        "shots": shots, "sb": marks, "drops": drops})
    return out


def analyze_match(job):
    """Decode one recording and compute every raw metric for every player in it."""
    mid, proc_path = job["mid"], job["proc"]
    ps = _PS
    with open(proc_path, encoding="utf-8") as fh:
        pj = json.load(fh)
    m = pj.get("match", {})
    raw = SESSIONS / str(m.get("submitter") or "") / str(m.get("source_file") or "")
    hz = int(m.get("tick_rate") or HZ)
    tick0 = (m.get("tick_range") or [0])[0]
    result = {"v": SCRIPT_VERSION, "mid": mid, "proc": _stat(proc_path), "raw_path": str(raw),
              "raw": _stat(raw), "hz": hz, "tick0": tick0, "players": {}, "error": None}
    wanted = {str(r.get("steam64")) for r in pj.get("leaderboard", []) if r.get("steam64")}
    if result["raw"] is None:
        result["error"] = "raw file missing"
        return result
    try:
        session, schema = ps.load_session(str(raw))
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"decode failed: {exc}"
        return result
    events = session.event_stream
    remap = {}
    # The pipeline already printed its roster warnings when it built this match.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        slot_to_s64, _s2s, s64_to_nick, *_ = ps._build_identity_maps(session.header, schema, events)
        for r in ps._resolve_account_reroutes(slot_to_s64, s64_to_nick) or []:
            remap[r["from_s64"]] = r["to_s64"]
            slot_to_s64[r["slot"]] = r["to_s64"]
        try:
            hits = _ALIASES.resolve_silent_aliases(slot_to_s64, match_label=str(m.get("source_file") or ""),
                                                   no_prompt=True) or {}
        except Exception:  # noqa: BLE001
            hits = {}
    for _slot, (src, tgt) in hits.items():
        remap[src] = tgt

    canon_cache = {}

    def canon(s64):
        c = canon_cache.get(s64)
        if c is None:
            x, seen = s64, set()
            while x in remap and x not in seen:
                seen.add(x)
                x = remap[x]
            c = str(x)
            canon_cache[s64] = c
        return c

    ship_names, ship_idx = [], {}
    states = collections.defaultdict(lambda: ([], [], []))
    shots = collections.defaultdict(list)
    victim_hits = []
    recorded_ids = collections.defaultdict(collections.Counter)
    for e in events:
        kind = e.WhichOneof("event_type")
        if kind == "update_tick":
            u = e.update_tick
            t = u.tick
            for p in u.players:
                pid = canon(p.player)
                if pid not in wanted:
                    continue
                odf = _stem(p.odf)
                k = ship_idx.get(odf)
                if k is None:
                    k = ship_idx[odf] = len(ship_names)
                    ship_names.append(odf)
                st = states[pid]
                st[0].append(t)
                st[1].append(k)
                st[2].append(p.ammo)
        elif kind == "bullet_init":
            b = e.bullet_init
            if b.shooter:
                pid = canon(b.shooter)
                if pid in wanted:
                    shots[pid].append((b.tick, _stem(b.ordnance_odf)))
                    if str(b.shooter) != pid:
                        recorded_ids[pid][str(b.shooter)] += 1
        elif kind == "bullet_hit":
            h = e.bullet_hit
            if h.shooter and h.victim:
                vid = canon(h.victim)
                if vid in wanted:
                    victim_hits.append((h.tick, vid, _stem(h.victim_odf)))
    # Rerouted and aliased players carry another Steam64 in the recording; the
    # page needs it to filter the raw event browser to their shots.
    result["raw_ids"] = {pid: sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
                         for pid, c in sorted(recorded_ids.items())}
    # Hits on a player whose victim ODF is not the ship that player was in: a
    # recording that credits a team slot's AI units (Scavengers, Recycler,
    # Turrets) to the slot's player, as shooter and as victim.
    off = 0
    for t, vid, vodf in victim_hits:
        st_t, st_odf, _a = states[vid]
        i = bisect.bisect_right(st_t, t) - 1
        if i >= 0 and ship_names[st_odf[i]] != vodf:
            off += 1
    result["slot_hits"] = [off, len(victim_hits)]
    for pid in sorted(wanted):
        if not shots.get(pid):
            continue
        st_t, st_odf, st_ammo = states[pid]
        result["players"][pid] = _analyze_player(mid, pid, shots[pid], st_t, st_odf, st_ammo, ship_names, hz)
    return result


def _cached(job):
    cache = CACHE_DIR / f"{job['mid']}.json"
    if not cache.exists():
        return None
    try:
        with open(cache, encoding="utf-8") as fh:
            hit = json.load(fh)
    except (OSError, ValueError):
        return None
    if (hit.get("v") == SCRIPT_VERSION and hit.get("proc") == _stat(job["proc"])
            and hit.get("raw") == _stat(hit.get("raw_path") or "")):
        return hit
    return None


def _run_job(job):
    result = analyze_match(job)
    cache = CACHE_DIR / f"{job['mid']}.json"
    tmp = cache.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, separators=(",", ":"))
    os.replace(tmp, cache)
    return result


# ---------------------------------------------------------------------------
# Join + output
# ---------------------------------------------------------------------------

METRICS = [
    # id, group, unit, direction (1: higher ranks first, -1: lower ranks first), aggregation, gate
    {"id": "sw_rate", "group": "switching", "unit": "per_min", "dir": 1, "agg": "pool", "gate": ["swa", 120]},
    {"id": "sw_1tick", "group": "switching", "unit": "share", "dir": 1, "agg": "pool", "gate": ["rtn", 50]},
    {"id": "sw_median", "group": "switching", "unit": "ms", "dir": -1, "agg": "median", "gate": ["rtn", 50]},
    {"id": "even_share", "group": "rhythm", "unit": "share", "dir": 1, "agg": "pool", "gate": ["stt", 5]},
    {"id": "period", "group": "rhythm", "unit": "ms", "dir": -1, "agg": "median", "gate": ["stk", 3]},
    {"id": "jitter", "group": "rhythm", "unit": "ms", "dir": -1, "agg": "median", "gate": ["stk", 3]},
    {"id": "clock_share", "group": "rhythm", "unit": "share", "dir": 1, "agg": "pool", "gate": ["cyc", 100],
     "caveat": "integer"},
    {"id": "dot_share", "group": "reload", "unit": "share", "dir": 1, "agg": "pool", "gate": ["sb", 30]},
    {"id": "seam_share", "group": "reload", "unit": "share", "dir": 1, "agg": "pool", "gate": ["sb", 30]},
    {"id": "perfect_share", "group": "reload", "unit": "share", "dir": 1, "agg": "pool", "gate": ["sb", 30]},
    {"id": "margin", "group": "reload", "unit": "ms", "dir": -1, "agg": "hist", "gate": ["sb", 30]},
    {"id": "drops_per_k", "group": "rhythm", "unit": "per_k", "dir": 1, "agg": "pool", "gate": ["cycm", 500]},
    {"id": "multi_share", "group": "sanity", "unit": "share", "dir": 0, "agg": "pool", "gate": ["vol", 100]},
    {"id": "pvp_hit", "group": "combat", "unit": "share", "dir": 1, "agg": "pool", "gate": ["sf", 500]},
    {"id": "accuracy", "group": "combat", "unit": "share", "dir": 1, "agg": "pool", "gate": ["sf", 500],
     "era": "post"},
    {"id": "tkey", "group": "combat", "unit": "share", "dir": 1, "agg": "median", "gate": ["tkn", 5]},
    {"id": "pvp_kd", "group": "combat", "unit": "ratio", "dir": 1, "agg": "pool", "gate": ["n", 5]},
    {"id": "dpm", "group": "combat", "unit": "per_min", "dir": 1, "agg": "pool", "gate": ["mins", 30]},
    {"id": "pvp_dpm", "group": "combat", "unit": "per_min", "dir": 1, "agg": "pool", "gate": ["mins", 30]},
]


def _r(x, nd=2):
    return None if x is None else round(x, nd)


class _Index:
    """Stable string -> int table."""

    def __init__(self):
        self.items, self.pos = [], {}

    def __call__(self, key):
        i = self.pos.get(key)
        if i is None:
            i = self.pos[key] = len(self.items)
            self.items.append(key)
        return i


def _switch_cols(s):
    if not s:
        return [0, 0.0, 0, 0, 0, 0, None, 0, 0, 0, 0, None]
    return [s["n"], s["act"], s["h"][0], s["h"][1], s["h"][2], s["h"][3], s["med"], s["vol"], s["mt"],
            s["rtn"], s["rt1"], s["rtmed"]]


def _pct(xs, q):
    if not xs:
        return 0.0
    k = (len(xs) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def build(results, model):
    with open(PROCESSED / "match_contributions.json", encoding="utf-8") as fh:
        contribs = json.load(fh)
    with open(PROCESSED / "matches.json", encoding="utf-8") as fh:
        manifest = {m["id"]: m for m in json.load(fh)}
    try:
        with open(PROCESSED / "player_slugs.json", encoding="utf-8") as fh:
            slugs = json.load(fh).get("slugs", {})
    except OSError:
        slugs = {}

    counts = collections.Counter()
    latest_name = {}
    entries = []
    for key, entry in contribs.items():
        mid = key[:-5] if key.endswith(".json") else key
        entries.append((str(entry.get("date") or manifest.get(mid, {}).get("date") or ""), mid, entry))
    entries.sort(key=lambda e: (e[0], e[1]))
    for _date, _mid, entry in entries:
        for row in entry.get("leaderboard", []):
            sid = str(row.get("steam64") or "")
            if sid:
                counts[sid] += 1
                latest_name[sid] = row.get("name") or sid
    covered = set(counts)

    def pname(sid):
        return (slugs.get(sid) or {}).get("name") or latest_name.get(sid) or sid

    players = sorted(covered, key=lambda s: (pname(s).lower(), s))
    p_idx = {sid: i for i, sid in enumerate(players)}
    w_idx, s_idx, o_idx, d_idx = _Index(), _Index(), _Index(), _Index()

    match_rows, rows, ship_rows, streak_rows, reload_rows, weapon_rows = [], [], [], [], [], []
    stream_agg = {}
    lanes_out = {}
    skipped = collections.Counter()
    desync_count = collections.Counter()
    errors = []
    data_through = ""
    for date, mid, entry in entries:
        res = results.get(mid)
        rp = (res or {}).get("players", {})
        hz = (res or {}).get("hz") or HZ
        for pid, pr in rp.items():
            for why, ordn, c in pr.get("skipped", []):
                skipped[(why, ordn)] += c
            for ship, w, n_vol, n_shots, min_gap_ms, below, R, Rmin in pr.get("streams", []):
                a = stream_agg.setdefault((ship, w), {"vols": 0, "gaps": 0, "shots": 0, "floor": None,
                                                      "below": 0, "players": set()})
                a["vols"] += n_vol
                a["gaps"] += max(0, n_vol - 1)
                a["shots"] += n_shots
                a["players"].add(pid)
                if min_gap_ms is not None and n_vol > 1:
                    a["floor"] = min_gap_ms if a["floor"] is None else min(a["floor"], min_gap_ms)
                a["below"] += below or 0
        lb = [r for r in entry.get("leaderboard", []) if str(r.get("steam64")) in covered]
        if not lb:
            continue
        if res is None or res.get("error"):
            errors.append((mid, (res or {}).get("error") or "not analysed"))
        m_i = len(match_rows)
        man = manifest.get(mid, {})
        off, n_hits = (res or {}).get("slot_hits") or [0, 0]
        slot = 1 if n_hits >= SLOT_MIN_HITS and off > SLOT_CREDIT_SHARE * n_hits else 0
        match_rows.append([mid, date[:16], man.get("name") or entry.get("map") or "",
                           entry.get("match_format") or man.get("match_format") or "",
                           _r(entry.get("duration_sec"), 1), (res or {}).get("tick0", 0), hz,
                           entry.get("submitter") or man.get("submitter") or "", slot])
        data_through = max(data_through, date[:10])
        lane_players = {}
        for row in lb:
            sid = str(row["steam64"])
            pi = p_idx[sid]
            pr = rp.get(sid) or {}
            ships = row.get("per_ship_combat") or []
            mins = sum((s.get("time_seconds") or 0) for s in ships) / 60.0
            if not mins:
                mins = (entry.get("duration_sec") or 0) / 60.0
            tk = row.get("target_lock_pct") if entry.get("has_target_lock_data") else None
            sw = (pr.get("sw") or {}).get("all")
            pair = (sw or {}).get("pair")
            rpair = (sw or {}).get("rtpair")
            drops = [0, 0, 0]
            for v in (pr.get("drops") or {}).values():
                for k in range(3):
                    drops[k] += v[k]
            viol = sum((s[5] or 0) for s in pr.get("streams", []))
            rows.append([
                m_i, pi, row.get("team"), 1 if row.get("is_commander") else 0,
                1 if row.get("is_campod") else 0, 1 if row.get("is_low_activity") else 0,
                row.get("shots_fired") or 0, row.get("shots_hit") or 0, row.get("pvp_shots_hit") or 0,
                _r(tk, 4), row.get("kills") or 0, row.get("deaths") or 0,
                row.get("pvp_kills") or 0, row.get("pvp_deaths") or 0,
                _r(row.get("dealt") or 0, 0), _r(row.get("pvp_dealt") or 0, 0), _r(mins, 2),
                *_switch_cols(sw), *drops, viol,
                w_idx(pair[0]) if pair else None, w_idx(pair[1]) if pair else None, pair[2] if pair else 0,
                w_idx(rpair[0]) if rpair else None, w_idx(rpair[1]) if rpair else None,
                rpair[2] if rpair else 0,
                ((res or {}).get("raw_ids") or {}).get(sid),
            ])
            sw_ships = (pr.get("sw") or {}).get("ships") or {}
            seen_ships = set()
            for s in ships:
                stem = _stem(s.get("ship"))
                seen_ships.add(stem)
                d = (pr.get("drops") or {}).get(stem) or [0, 0, 0]
                ship_rows.append([
                    m_i, pi, s_idx(stem), _r((s.get("time_seconds") or 0) / 60.0, 2),
                    s.get("shots") or 0, s.get("hits") or 0, s.get("pvp_hits") or 0,
                    s.get("kills") or 0, s.get("deaths") or 0, s.get("pvp_kills") or 0, s.get("pvp_deaths") or 0,
                    _r(s.get("dealt") or 0, 0), *_switch_cols(sw_ships.get(stem)), *d,
                ])
            for stem in sorted(set(sw_ships) - seen_ships):
                if not stem or sw_ships[stem]["vol"] < 1:
                    continue
                d = (pr.get("drops") or {}).get(stem) or [0, 0, 0]
                ship_rows.append([m_i, pi, s_idx(stem), 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                  *_switch_cols(sw_ships[stem]), *d])
            for label, wb in sorted((row.get("weapon_breakdown") or {}).items()):
                shots = (wb or {}).get("shots") or 0
                if shots <= 0:
                    continue
                ordn = label.rsplit("(", 1)[-1].rstrip(")").strip() if "(" in label else label
                weapon_rows.append([m_i, pi, o_idx(_stem(ordn)), shots, wb.get("hits") or 0,
                                    wb.get("pvp_hits") or 0, _r(wb.get("dealt") or 0, 0)])
            for ship, a, q, t0, n, per, sp, pv, jit, ck, g in pr.get("streaks", []):
                streak_rows.append([m_i, pi, s_idx(ship), w_idx(a), w_idx(q), t0, n, per, sp, pv, jit, ck, g])
            desync = set()
            for ship, w, n_vol, _ns, _mg, below, _R, _Rm in pr.get("streams", []):
                if below and below >= DESYNC_MIN_SHORT and below > DESYNC_SHORT_SHARE * max(1, n_vol - 1):
                    desync.add((ship, w))
                    desync_count[(ship, w)] += 1
            for ship, a, q, R, sb, dot, seam, perf, cyc, starv, hist, din, mine, ditem in pr.get("reload", []):
                if (ship, a) in desync:
                    continue
                h = ";".join(f"{m_},{d_},{c_}" for m_, d_, c_ in hist)
                di = ",".join(f"{d_idx(n_)}:{c_}" for n_, c_ in ditem)
                reload_rows.append([m_i, pi, s_idx(ship), w_idx(a), w_idx(q), R, sb, dot, seam, perf,
                                    cyc, starv, din, mine, di, 0, 0, h])
            for ship, a, R, n, h0, hist in pr.get("held", []):
                if (ship, a) in desync:
                    continue
                h = ";".join(f"{m_},0,{c_}" for m_, c_ in hist)
                reload_rows.append([m_i, pi, s_idx(ship), w_idx(a), -1, R, 0, 0, 0, 0, 0, 0, 0, 0, "", n, h0, h])
            if pr.get("lanes"):
                lane_players[pi] = pr["lanes"]
        if lane_players:
            lanes_out[mid] = (m_i, (res or {}).get("tick0", 0), hz, lane_players)

    # Weapon reference: one row per (ship, weapon) that fired, R in 20 Hz terms.
    # Single short gaps are left out where they occur (recording bunching, the
    # MDM's banked reload after a pause). A pair is flagged, and its
    # switch-backs dropped, only when short gaps are systematic.
    flagged = set()
    reference = []
    for (ship, w) in sorted(stream_agg):
        a = stream_agg[(ship, w)]
        res = model.weapon_on(ship, w, HZ) if w in model.weapons else None
        R_ms = res["R"] * 1000 // HZ if res and res["R"] else None
        Rmin_ms = res["Rmin"] * 1000 // HZ if res and res["Rmin"] else None
        flag = 1 if a["below"] >= FLAG_MIN_SHORT and a["below"] > FLAG_SHORT_SHARE * max(1, a["gaps"]) else 0
        if flag:
            flagged.add((ship, w))
        reference.append([s_idx(ship), w_idx(w), res["hp"] if res else None, R_ms, Rmin_ms,
                          res["isd"] * 1000 // HZ if res else 0, res["g"] if res else None,
                          a["shots"], a["vols"], a["floor"], a["below"], desync_count[(ship, w)], flag,
                          len(a["players"])])
    reload_rows = [r for r in reload_rows
                   if (s_idx.items[r[2]], w_idx.items[r[3]]) not in flagged]

    # Per-weapon population of switch-back shares (all time, players with >= 30 switch-backs).
    pooled = collections.defaultdict(lambda: [0, 0, 0, 0])
    for r in reload_rows:
        if r[4] < 0:
            continue
        k = pooled[(r[3], r[1])]
        k[0] += r[6]
        k[1] += r[7]
        k[2] += r[8]
        k[3] += r[9]
    population = {}
    by_w = collections.defaultdict(list)
    for (wi, _pi), (sb, dot, seam, perf) in sorted(pooled.items()):
        if sb >= 30:
            by_w[wi].append((dot / sb, seam / sb, perf / sb))
    for wi in sorted(by_w):
        vals = by_w[wi]
        population[str(wi)] = {"n": len(vals)}
        for j, key in enumerate(("dot", "seam", "perf")):
            xs = sorted(v[j] for v in vals)
            population[str(wi)][key] = [round(_pct(xs, q), 4) for q in (10, 25, 50, 75, 90)]

    match_files = {}
    for mid, (m_i, tick0, hz, lane_players) in sorted(lanes_out.items()):
        out_players = {}
        for pi in sorted(lane_players):
            enc = []
            for ln in lane_players[pi]:
                enc.append({
                    "s": s_idx(ln["ship"]), "a": w_idx(ln["a"]), "R": ln["R"], "t0": ln["t0"], "len": ln["len"],
                    "shots": ";".join(f"{dt},{w_idx(w)}" for dt, w in ln["shots"]),
                    "sb": ln["sb"], "drops": ln["drops"],
                })
            out_players[str(pi)] = enc
        match_files[mid] = {"schema_version": SCHEMA_VERSION, "id": mid, "m": m_i, "tick0": tick0, "hz": hz,
                            "players": out_players}

    weapons = []
    for stem in w_idx.items:
        w = model.weapons.get(stem)
        if w is None:
            why = "secondary" if stem[4:] in model.secondary else "unknown"
            weapons.append([stem, stem[4:] if stem.startswith("ord:") else stem, "", 0, "", None, 0, 1, 0, 0, 0,
                            None, why])
            continue
        weapons.append([stem, w["name"], w["cat"], 1 if w["assault"] else 0, w["terminal"], _r(w["sd"], 3),
                        1 if w["alt"] else 0, w["sc"], _r(w["sdl"], 3), _r(w["isd"], 3), _r(w["lock"], 3),
                        _r(w["cost"], 2), w["why"]])
    ships = []
    for stem in s_idx.items:
        sh = model.ship(stem)
        ships.append([stem, sh["name"], 1 if sh["pilot"] else 0, sh["stock_drop"]])

    index = {
        "schema_version": SCHEMA_VERSION,
        "script_version": SCRIPT_VERSION,
        "data_through": data_through,
        "recorder_change": RECORDER_CHANGE,
        "constants": {
            "switch_max_gap_s": SWITCH_MAX_GAP_S, "switchback_extra_s": SWITCHBACK_EXTRA_S,
            "rhythm_extra_s": RHYTHM_EXTRA_S, "streak_min_cycles": STREAK_MIN_CYCLES,
            "bin_ms": BIN_MS, "dot_bins": DOT_BINS, "seam_bins": SEAM_BINS, "margin_cap": MARGIN_CAP,
            "dead_cap": DEAD_CAP, "even_p": EVEN_P, "clock_spread_ms": CLOCK_SPREAD_MS,
            "clock_min_cycles": CLOCK_MIN_CYCLES, "jitter_over": JITTER_OVER,
            "drop_range": [DROP_MIN, DROP_MAX], "drop_tol": DROP_TOL, "flag_min_short": FLAG_MIN_SHORT,
            "flag_short_share": FLAG_SHORT_SHARE, "slot_credit_share": SLOT_CREDIT_SHARE,
            "slot_min_hits": SLOT_MIN_HITS,
        },
        "events": [{"date": RECORDER_CHANGE, "kind": "recorder"}],
        "metrics": METRICS,
        "players": {"cols": ["id", "name", "slug", "n"],
                    "rows": [[sid, pname(sid), (slugs.get(sid) or {}).get("slug"), counts[sid]]
                             for sid in players]},
        "matches": {"cols": ["id", "date", "map", "fmt", "dur", "tick0", "hz", "sub", "slot"], "rows": match_rows},
        "weapons": {"cols": ["stem", "name", "cat", "assault", "terminal", "shot_delay", "alt", "salvo",
                             "salvo_delay", "isd", "lock", "cost", "why"], "rows": weapons},
        "ships": {"cols": ["stem", "name", "pilot", "drop"], "rows": ships},
        "drop_items": d_idx.items,
        "rows": {"cols": ["m", "p", "team", "cmd", "camp", "low", "sf", "sh", "ph", "tk", "k", "d", "pk", "pd",
                          "dmg", "pdmg", "mins", "swn", "swa", "sw1", "sw2", "sw3", "sw4", "swmed", "vol", "mt",
                          "rtn", "rt1", "rtmed", "din", "dbr", "diso", "viol", "pa", "pb", "pc", "ra", "rb", "rc",
                          "rid"], "rows": rows},
        "ship_rows": {"cols": ["m", "p", "s", "mins", "sf", "sh", "ph", "k", "d", "pk", "pd", "dmg", "swn",
                               "swa", "sw1", "sw2", "sw3", "sw4", "swmed", "vol", "mt", "rtn", "rt1", "rtmed",
                               "din", "dbr", "diso"],
                      "rows": ship_rows},
        "ordnance": {"cols": ["stem", "weapon"],
                     "rows": [[o, (model.by_ord.get(o) or [None])[0]] for o in o_idx.items]},
        "weapon_rows": {"cols": ["m", "p", "o", "sf", "sh", "ph", "dmg"], "rows": weapon_rows},
        "streaks": {"cols": ["m", "p", "s", "a", "q", "t0", "n", "per", "sp", "pv", "jit", "ck", "g"],
                    "rows": streak_rows},
        "reload": {"cols": ["m", "p", "s", "a", "q", "R", "sb", "dot", "seam", "perf", "cyc", "starv",
                            "din", "mine", "ditem", "held", "held0", "h"], "rows": reload_rows},
        "reference": {"cols": ["s", "w", "hp", "R_ms", "Rmin_ms", "isd_ms", "grp", "shots", "vols", "floor_ms",
                               "below", "desync", "flag", "players"], "rows": reference},
        "population": population,
        "skipped": [[why, o, c] for (why, o), c in sorted(skipped.items())],
    }
    return index, match_files, errors


def _dumps(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write_outputs(index, match_files):
    blobs = {OUT_DIR / "index.json": _dumps(index)}
    for mid, data in match_files.items():
        blobs[OUT_DIR / "match" / f"{mid}.json"] = _dumps(data)
    total = sum(len(b.encode("utf-8")) for b in blobs.values())
    if total > SIZE_BUDGET:
        raise SystemExit(f"size budget exceeded: {total / 1e6:.2f} MB > {SIZE_BUDGET / 1e6:.2f} MB")
    (OUT_DIR / "match").mkdir(parents=True, exist_ok=True)
    for path, blob in blobs.items():
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(blob)
        os.replace(tmp, path)
    keep = {f"{mid}.json" for mid in match_files}
    for old in (OUT_DIR / "match").glob("*.json"):
        if old.name not in keep:
            old.unlink()
    return total


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--force", action="store_true", help="ignore the per-match cache")
    ap.add_argument("--only", help="analyse one match id and print a summary (writes no page data)")
    args = ap.parse_args(argv)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(PROCESSED / "match_contributions.json", encoding="utf-8") as fh:
        mids = sorted(k[:-5] if k.endswith(".json") else k for k in json.load(fh))
    if args.only:
        mids = [args.only]
    jobs = [{"mid": mid, "proc": str(PROCESSED / f"{mid}.json")} for mid in mids]

    results, todo = {}, []
    for job in jobs:
        hit = None if (args.force or args.only) else _cached(job)
        if hit is not None:
            results[job["mid"]] = hit
        else:
            todo.append(job)
    started = time.time()
    print(f"{len(results)} cached, {len(todo)} to analyse with {args.jobs} job(s)", flush=True)
    if todo:
        if args.jobs <= 1 or len(todo) == 1:
            _worker_init()
            for i, job in enumerate(todo, 1):
                results[job["mid"]] = _run_job(job)
                print(f"  [{i}/{len(todo)}] {job['mid']}", flush=True)
        else:
            with ProcessPoolExecutor(max_workers=args.jobs, initializer=_worker_init) as pool:
                for i, res in enumerate(pool.map(_run_job, todo, chunksize=1), 1):
                    results[res["mid"]] = res
                    if i % 25 == 0 or i == len(todo):
                        print(f"  [{i}/{len(todo)}] {time.time() - started:.0f}s", flush=True)

    if args.only:
        res = results[args.only]
        print(json.dumps({"error": res.get("error"), "hz": res.get("hz"), "players": {
            pid: {"switches": pr["sw"]["all"]["n"], "round_trips": pr["sw"]["all"]["rtn"],
                  "one_tick_returns": pr["sw"]["all"]["rt1"], "streaks": len(pr["streaks"]),
                  "reload_blocks": len(pr["reload"]), "drops": pr["drops"]}
            for pid, pr in res["players"].items()}}, indent=1))
        return 0

    with open(ODF_DB, encoding="utf-8") as fh:
        model = OdfModel(json.load(fh))
    index, match_files, errors = build(results, model)
    total = write_outputs(index, match_files)
    for mid, err in errors:
        print(f"  warning: {mid}: {err}")
    print(f"wrote {len(match_files)} match files + index.json, {total / 1e6:.2f} MB, "
          f"{len(index['players']['rows'])} players, {len(index['rows']['rows'])} rows, "
          f"{len(index['streaks']['rows'])} streaks, {time.time() - started:.0f}s")
    trips = collections.Counter()
    for res in results.values():
        for pr in (res.get("players") or {}).values():
            sw = (pr.get("sw") or {}).get("all") or {}
            for k in ("rtn", "rteq", "rtgt", "rtoc", "rt1"):
                trips[k] += sw.get(k) or 0
    n = trips["rtn"]
    print(f"{n} round trips ({trips['rteq']} equal reload, {trips['rtgt']} waited on the first weapon's "
          f"reload) · out leg inside one cycle {100.0 * trips['rtoc'] / max(1, n):.1f}% · "
          f"one-tick returns {100.0 * trips['rt1'] / max(1, n):.1f}%")
    rc = {c: i for i, c in enumerate(index["reload"]["cols"])}
    cyc = sum(r[rc["cyc"]] for r in index["reload"]["rows"])
    cyc_mine = sum(r[rc["cyc"]] for r in index["reload"]["rows"] if r[rc["mine"]])
    din = sum(r[rc["din"]] for r in index["reload"]["rows"])
    items = collections.Counter()
    for r in index["reload"]["rows"]:
        for part in filter(None, r[rc["ditem"]].split(",")):
            i, c = part.split(":")
            items[index["drop_items"][int(i)]] += int(c)
    print(f"{din} mid-cycle drops ({', '.join(f'{c} {k}' for k, c in items.most_common())}) · "
          f"{cyc_mine} of {cyc} cycles on ships carrying a droppable item")
    return 0


if __name__ == "__main__":
    sys.exit(main())
