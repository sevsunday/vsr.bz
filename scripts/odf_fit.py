"""Which ordnance a ship can fire itself, from the hardpoints in data/odf.min.json.

A weapon fits a hardpoint of its own category (``wpnCategory`` against the
``HP_`` prefix of ``weaponHardN``) with the same assault flag; a deployed
morph tank also offers the hardpoints its ``switchMask`` turns assault. A
ship's stock weapons (``weaponNameN``) always count, because some ODFs mount
one on a hardpoint whose assault flag disagrees with the weapon's own (the
Hedoux LS).

Shared by scripts/process_stats.py (the slot-credited recordings, see
SLOT_CREDITED_MATCHES there) and scripts/build_analysis_data.py.
"""
from __future__ import annotations

import collections
import math

CATEGORIES = ("GUN", "CANN", "MORT", "ROCK", "SPEC", "SHIE", "HAND", "PACK")
SHIP_BUCKETS = ("Vehicle", "Pilot", "Building")


def stem(name):
    s = str(name or "").strip().lower()
    if s.endswith(".odf"):
        s = s[:-4]
    return "" if s == "null" else s


def num(value, fallback=None):
    if value is None:
        return fallback
    try:
        n = float(str(value).strip().split()[0])
    except (ValueError, IndexError):
        return fallback
    return n if math.isfinite(n) else fallback


def flag(value, fallback=False):
    if value is None:
        return fallback
    s = str(value).strip().lower()
    if not s:
        return fallback
    if s in ("true", "yes"):
        return True
    if s in ("false", "no"):
        return False
    n = num(s)
    return fallback if n is None else n != 0


def hp_category(node):
    s = str(node or "").strip().upper()
    if s.startswith("HP_"):
        s = s[3:]
    for cat in CATEGORIES:
        if s.startswith(cat):
            return cat
    return ""


def sections(entry):
    out = {}
    for name, sec in entry.items():
        if isinstance(sec, dict):
            out[name.lower()] = {str(k).lower(): v for k, v in sec.items()}
    return out


def fired_ordnance(entry):
    """Ordnance a trigger pull launches: ordName, charge stages ordNameN, a TAG leader."""
    out = []
    for name, sec in entry.items():
        if not isinstance(sec, dict) or "." in name:
            continue
        for k, v in sec.items():
            key = str(k).lower()
            if key == "leadername" or (key.startswith("ordname") and key[7:].isdigit()) or key == "ordname":
                s = stem(v)
                if s and s not in out:
                    out.append(s)
    return out


def fitting(ship, cat, assault):
    """The ship's hardpoints a weapon of this category and assault flag mounts on, or None."""
    same = [hp for hp in ship["hps"] if hp["cat"] == cat]
    exact = [hp for hp in same if hp["assault"] == assault]
    if exact:
        return exact
    if ship["morph"] and assault:
        dep = [hp for hp in ship["hps_deployed"] if hp["cat"] == cat and hp["assault"]]
        if dep:
            return dep
    return None


class HardpointFit:
    def __init__(self, db):
        self.buckets = {}
        for bucket, entries in (db or {}).items():
            if isinstance(entries, dict):
                self.buckets[bucket] = {
                    stem(f): e for f, e in entries.items() if isinstance(e, dict)
                }
        self.weapons = {}
        self.by_ord = collections.defaultdict(list)
        for w in sorted(self.buckets.get("Weapon", {})):
            entry = self.buckets["Weapon"][w]
            wc = sections(entry).get("weaponclass", {})
            self.weapons[w] = {
                "cat": str(wc.get("wpncategory") or "").strip().upper()[:4],
                "assault": flag(wc.get("isassault"), False),
            }
            for ordn in fired_ordnance(entry):
                if w not in self.by_ord[ordn]:
                    self.by_ord[ordn].append(w)
        self._ships = {}
        self._can_fire = {}

    def lookup(self, ship_stem):
        for b in SHIP_BUCKETS:
            if ship_stem in self.buckets.get(b, {}):
                return self.buckets[b][ship_stem], b
        return None, None

    def ship(self, ship_stem):
        """Hardpoints of a ship: category, assault flag, weapon group and stock weapon."""
        hit = self._ships.get(ship_stem)
        if hit is not None:
            return hit
        entry, _bucket = self.lookup(ship_stem)
        info = {"known": False, "hps": [], "hps_deployed": [], "morph": False}
        if entry is not None:
            secs = sections(entry)
            go = secs.get("gameobjectclass", {})
            mt = secs.get("morphtankclass")
            mask = str(mt.get("switchmask", "11111")).strip() if mt else ""
            hps, hps_dep = [], []
            for i in range(1, 6):
                node = go.get(f"weaponhard{i}")
                if node is None or not str(node).strip():
                    continue
                group = num(go.get(f"weapongroup{i}"))
                hp = {
                    "cat": hp_category(node),
                    "assault": flag(go.get(f"weaponassault{i}"), False),
                    "group": int(group) if group is not None else None,
                    "stock": stem(go.get(f"weaponname{i}")) or None,
                }
                hps.append(hp)
                dep = dict(hp)
                if mt is not None and len(mask) >= i and mask[len(mask) - i] == "1":
                    dep["assault"] = True
                hps_dep.append(dep)
            info = {"known": True, "hps": hps, "hps_deployed": hps_dep if mt is not None else [],
                    "morph": mt is not None}
        self._ships[ship_stem] = info
        return info

    def can_fire(self, ship_stem, ord_stem):
        """Whether the ship could have fired this ordnance itself.

        Unknown ordnance, an unknown ship and a ship without hardpoints all
        count as fireable: the check only rules out what it can prove."""
        key = (ship_stem, ord_stem)
        hit = self._can_fire.get(key)
        if hit is not None:
            return hit
        cands = self.by_ord.get(ord_stem, [])
        sh = self.ship(ship_stem)
        if not cands or not sh["known"] or not sh["hps"]:
            ok = True
        else:
            stock = {hp["stock"] for hp in sh["hps"] if hp["stock"]}
            ok = any(w in stock or fitting(sh, self.weapons[w]["cat"], self.weapons[w]["assault"])
                     for w in cands)
        self._can_fire[key] = ok
        return ok
