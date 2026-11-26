/* Weapon switching ("weaving") for the shooting range.
 *
 * VSR players hold a slow weapon's cooldown open with a faster one: fire the
 * Burst Gun, switch to the Dragon Blast for the shots that fit before the
 * Burst is ready again, switch back. decide() is that rule. The live range
 * calls it every frame (js/fx/weapon-sim.js) and planWeave() replays it as a
 * discrete-event model of one engagement for the readout, so both fire in the
 * same order.
 *
 * Pure: no DOM, no three.js. A weapon's numbers come from
 * VTWeaponsCalc.weaveInput() (per hit, firing group, shotDelay, salvo,
 * ammoCost, shotSpeed x lifeSpan, aiRange) and its archetype from
 * js/fx/weapon-profile.js. No ODF property sets a weapon-switch delay.
 */

// BZCC simulates in lockstep turns, 20 per second (BZCC_DEFAULT_TPS in
// statsgate/include/ScriptUtils.h; every recorded match has tick_rate 20), so a
// newly selected weapon fires one turn after the previous one at the earliest.
export const TURN_SEC = 1 / 20;
// startSalvo() never re-arms a trigger faster than this.
export const MIN_COOLDOWN_SEC = 0.05;
// Closing stops this far off the target's surface, past the no-overlap floor.
export const CLOSE_STOP_M = 20;
// Direct fire opens with this fraction of its reach as clear air to the hull.
// Renderer choice: no ODF names an opening distance.
export const START_REACH_FRACTION = 0.5;
// Daylight between the two hull boxes at the floor. Renderer choice.
export const SURFACE_MARGIN_M = 1;
// The range slider's ceiling (lockStartDistance in js/fx/weapon-sim.js).
export const OPENING_MAX_M = 400;
// TargetingGun (0x00625A9A) fires no new leader while one is alive, so a tag
// that sticks holds its hardpoint for the leader's stickTime. 'salvo' re-arms
// when the missile burst ends instead. One-line switch.
export const TAG_RETAG_AFTER = 'leader';
const LOBBED_FLIGHT = 2000;

const EPS = 1e-6;
export const PLAN_MAX_SEC = 600;
const PLAN_MAX_STEPS = 60000;
const PLAN_MAX_PULLS = 4000;
const PREVIEW_SEC = 8;

export const WEAVE_ARCHETYPES = new Set(['projectile', 'beam', 'mortar', 'missile', 'detonator', 'targeting', 'launcher']);
const LOBBED = new Set(['mortar', 'detonator']);
const UTILITY = new Set(['shield', 'blink', 'phantom', 'damper', 'site', 'magnet', 'jetpack']);
const EXCLUDED = {
    multilock: 'Multi-lock: it holds the trigger to gather locks and fires on release.',
    charge: 'Charge gun: it holds the trigger to charge and fires on release.',
    arc: 'Arc stream: it fires only while the trigger is held.',
    static: 'Damage field: it surrounds the ship while the trigger is held.',
    torpedo: 'Steered torpedo: the damage is in the launched object.',
    popper: 'Popper: the damage is in its second stage.',
    spray: 'Payload: the damage is in what it spawns on impact.',
    dispenser: 'Dispenser: it drops a mine at the ship.',
};

/* Seconds until the same trigger can pull again. shotAlternate fires one
 * hardpoint per pull, so the group's shotDelay is shared across them (guide:
 * "ShotDelay is divided evenly between the amount of Hard Points"). */
export function pullCooldown(shotDelay, shotAlternate, hardpoints) {
    const n = Math.max(1, hardpoints || 1);
    const delay = Math.max(0, Number(shotDelay) || 0);
    return Math.max(MIN_COOLDOWN_SEC, shotAlternate && n > 1 ? delay / n : delay);
}

/* Why a mounted weapon cannot join the switch, or null when it can. */
export function exclusionReason(archetype, calc) {
    if (!calc) return 'Not in the ODF database.';
    if (UTILITY.has(archetype)) return 'Utility: it deals no damage.';
    if (!WEAVE_ARCHETYPES.has(archetype)) return EXCLUDED[archetype] || 'This weapon type is not scheduled.';
    if (calc.kind !== 'direct' && calc.kind !== 'pulse') return 'Its damage comes from components, not one hit.';
    if (calc.perHit == null) return 'The ODF gives no damage per hit.';
    if (calc.ammoMode !== 'perShot') return 'It drains ammo per second instead of per shot.';
    return null;
}

/* allowMDMCollisionDetonation (guide): -1 = auto, which is a hit on anything
 * but a building; 0 = never; 1 = always. */
export function mdmDetonates(target) {
    const rule = target && target.mdmRule != null ? Number(target.mdmRule) : -1;
    if (rule === 0) return false;
    if (rule === 1) return true;
    return !(target && target.building);
}

function leaderReachOf(profile) {
    const lead = profile && profile.leader;
    if (!lead || !(lead.shotSpeed > 0) || !(lead.lifeSpan > 0) || lead.lifeSpan >= 1e20) return null;
    return lead.shotSpeed * lead.lifeSpan;
}

/* How far a weapon is used at: { reach, source, flight }.
 * - Launchers lock inside LauncherClass lockRange (guide 7554-7595; an
 *   omitted lockRange is shotSpeed x lifeSpan, which buildProfile stores).
 * - TAG's leader has to touch the hull: the leader's shotSpeed x lifeSpan.
 *   Tested before the lobbed branch because TAG weapons also declare aiRange
 *   (gtagcr_c 160 while leadcr_c reaches 150 x 1.1 = 165 m).
 * - Lobbed rounds: aiRange when it sits inside the ballistic throw, else the throw.
 * - Everything else flies shotSpeed x lifeSpan. */
export function engagementReach(profile, gravity) {
    if (!profile) return { reach: null, source: null, flight: null };
    const ord = profile.ord || {};
    const flight = ord.shotSpeed > 0 && ord.lifeSpan > 0 && ord.lifeSpan < 1e20
        ? ord.shotSpeed * ord.lifeSpan : null;
    const id = profile.id;
    if (id === 'launcher' || id === 'multilock') {
        const reach = profile.lockRange > 0 ? profile.lockRange : flight;
        return { reach: reach > 0 ? reach : null, source: reach > 0 ? 'lockRange' : null, flight };
    }
    if (id === 'targeting') {
        const reach = leaderReachOf(profile);
        return { reach, source: reach ? 'leader' : null, flight };
    }
    const lobbed = id === 'mortar' || id === 'detonator' || id === 'popper' || id === 'spray'
        || (flight != null && flight > LOBBED_FLIGHT);
    if (lobbed) {
        const g = Number(gravity) || 0;
        const speed = ord.shotSpeed || 0;
        const ballistic = speed > 0 && g > 0 ? (speed * speed) / g : null;
        const ai = profile.aiRange > 0 ? profile.aiRange : null;
        if (ai != null && (ballistic == null || ai <= ballistic + EPS)) return { reach: ai, source: 'aiRange', flight };
        if (ballistic != null) return { reach: ballistic, source: 'ballistic', flight };
        return { reach: null, source: null, flight };
    }
    if (flight > 0) return { reach: flight, source: 'envelope', flight };
    return { reach: null, source: null, flight };
}

/* Centre-to-centre opening distance given `floor`, the centre distance at
 * which the hull boxes clear with SURFACE_MARGIN_M to spare. Lock range is
 * measured to the centre (the memdump rule). A leader or a direct round opens
 * with clear air to the hull: 90% of leader reach, START_REACH_FRACTION of a
 * direct round's reach. OPENING_MAX_M still caps it. */
export function openingCentre(eng, floor) {
    const base = Math.max(1, Number(floor) || 1);
    const cap = Math.max(OPENING_MAX_M, base);
    if (!eng || !(eng.reach > 0)) return null;
    if (eng.source === 'lockRange') return Math.max(base, Math.min(cap, eng.reach * 0.9));
    if (eng.source === 'leader' || eng.source === 'envelope') {
        const frac = eng.source === 'leader' ? 0.9 : START_REACH_FRACTION;
        return Math.max(base, Math.min(cap, base - SURFACE_MARGIN_M + eng.reach * frac));
    }
    return null;
}

/* TAG: the pull fires only the leader, so busy is 0 and the missiles are
 * not the pull. cooldown is the whole cycle: shotDelay, or the leader's
 * flight plus stickTime ('leader') or the missile burst ('salvo'). */
function tagWeapon(out, calc, profile) {
    const reach = leaderReachOf(profile);
    if (!(reach > 0)) {
        out.excluded = 'The leader round has no reach.';
        return out;
    }
    const lead = profile.leader;
    const f = calc.fire;
    const g = Math.max(1, calc.g || 1);
    const p = calc.projectile || {};
    const salvoCount = Math.max(1, profile.tagSalvo || 1);
    const salvoDelay = Math.max(0, profile.tagSalvoDelay || 0);
    const firstDelay = Math.max(0, profile.firstDelay || 0);
    const stickTime = Math.max(0, lead.stickTime || 0);
    const hold = TAG_RETAG_AFTER === 'salvo' ? firstDelay + (salvoCount - 1) * salvoDelay : stickTime;
    const cooldown = Math.max(pullCooldown(f.shotDelay, false, 1), lead.lifeSpan + hold);
    return Object.assign(out, {
        perHit: calc.perHit,
        letter: calc.letter,
        g,
        alternating: false,
        barrels: g,
        shotDelay: f.shotDelay,
        shotVariance: f.shotVariance || 0,
        salvoCount,
        salvoDelay,
        cooldown,
        busy: 0,
        cycle: cooldown,
        calcInterval: calc.shotInterval,
        ammoPerRound: calc.ammoPerShot > 0 ? calc.ammoPerShot : 0,
        reach,
        reachSource: 'leader',
        aiRange: p.aiRange != null ? p.aiRange : null,
        shotSpeed: p.shotSpeed,
        hitscan: false,
        lob: false,
        shotPitch: 0,
        gravity: 0,
        homing: true,
        pulse: false,
        cap: 0,
        burst: null,
        tier: 'estimated',
        warnings: (calc.warnings || []).slice(),
        tag: {
            leaderSpeed: lead.shotSpeed,
            leaderLife: lead.lifeSpan,
            leaderAmmo: lead.ammoCost > 0 ? lead.ammoCost : 0,
            // Planner choice: tag only when the tank can also pay the first
            // missile volley. The engine would fire a leader on 1 ammo, but a
            // tag no missile can follow deals nothing.
            pullAmmo: (lead.ammoCost > 0 ? lead.ammoCost : 0) + g * (calc.ammoPerShot > 0 ? calc.ammoPerShot : 0),
            stickTime,
            firstDelay,
            hold,
            retag: TAG_RETAG_AFTER,
        },
    });
}

/* LauncherClass, one lock per shot: a pull starts the lock. The trigger is
 * held for `hold`: the press-to-shot lock in whole game turns, then the
 * pilot's release after the red ring (VTWeaponsCalc.lockTime). The lock
 * builds while the launcher reloads. The
 * missile leaves once the lock is done and the reload has run, even after
 * the player has switched away: a locked launcher that is not held fires on
 * its first trigger-up turn with the fire timer above 0 (0x0061EB23). The
 * shot clears the lock (0x0061EAF4) and the next lock starts a turn later,
 * so the cycle is max(cooldown, hold + one turn). It ranks by its reload
 * alone: the lock is player time, which a leader's gaps are for, and a
 * long lock ranked by the full cycle would lead and shut every filler out
 * (a Shadower on a signature-0.5 Bomber holds 2.05 s of every 2.1 s). */
function launcherWeapon(out, calc, profile) {
    const lock = calc.lock || null;
    if (lock && lock.never) {
        out.excluded = 'Its seeker reads ' + lock.signature + 'Signature, which this target has at 0: it never locks.';
        return out;
    }
    const reach = profile.lockRange > 0 ? profile.lockRange : null;
    if (!(reach > 0)) {
        out.excluded = 'The ODF gives it no lock range.';
        return out;
    }
    const f = calc.fire;
    const g = Math.max(1, calc.g || 1);
    const p = calc.projectile || {};
    const alternating = !!calc.alternating;
    const lockSec = lock && lock.seconds > 0 ? lock.seconds : 0;
    const release = lock && lock.release > 0 ? lock.release : 0;
    const hold = lockSec + release;
    const cooldown = pullCooldown(f.shotDelay, f.shotAlternate, g);
    return Object.assign(out, {
        perHit: calc.perHit,
        letter: calc.letter,
        g,
        alternating,
        barrels: alternating ? 1 : g,
        shotDelay: f.shotDelay,
        shotVariance: f.shotVariance || 0,
        salvoCount: 1,
        salvoDelay: 0,
        cooldown,
        busy: hold,
        cycle: Math.max(cooldown, hold + TURN_SEC),
        rank: cooldown,
        calcInterval: calc.shotInterval,
        ammoPerRound: calc.ammoPerShot > 0 ? calc.ammoPerShot : 0,
        reach,
        reachSource: 'lockRange',
        aiRange: p.aiRange != null ? p.aiRange : null,
        shotSpeed: p.shotSpeed,
        hitscan: false,
        lob: false,
        shotPitch: 0,
        gravity: 0,
        homing: true,
        pulse: false,
        cap: 0,
        burst: null,
        tier: 'estimated',
        warnings: (calc.warnings || []).slice(),
        lock: {
            hold,
            seconds: lockSec,
            release,
            turns: lock ? lock.turns : 0,
            signature: lock ? lock.signature : null,
            signatureValue: lock ? lock.signatureValue : 1,
            continuous: lock ? lock.continuous : 0,
        },
    });
}

/* One weapon of the switch: o = { key, profile, calc, gravity }. calc is
 * VTWeaponsCalc.weaveInput(); profile is buildProfile() of the same stem. */
export function weaveWeapon(o) {
    const calc = o.calc || null;
    const profile = o.profile || null;
    const archetype = profile ? profile.id : '';
    const out = {
        key: o.key,
        stem: calc ? calc.stem : (o.stem || ''),
        name: calc ? calc.name : (o.name || o.stem || ''),
        archetype,
        excluded: null,
    };
    out.excluded = exclusionReason(archetype, calc);
    if (out.excluded) return out;
    if (archetype === 'targeting') return tagWeapon(out, calc, profile);
    if (archetype === 'launcher') return launcherWeapon(out, calc, profile);
    const f = calc.fire;
    const g = Math.max(1, calc.g || 1);
    const lob = LOBBED.has(archetype);
    const gravity = Number(o.gravity) || 0;
    const p = calc.projectile || {};
    let reach = null;
    let reachSource = null;
    if (p.lobbed) {
        const ballistic = p.shotSpeed > 0 && gravity > 0 ? p.shotSpeed * p.shotSpeed / gravity : null;
        if (p.aiRange > 0 && (ballistic == null || p.aiRange <= ballistic + EPS)) {
            reach = p.aiRange;
            reachSource = 'aiRange';
        } else if (ballistic != null) {
            reach = ballistic;
            reachSource = 'ballistic';
        }
    } else if (p.range > 0) {
        reach = p.range;
        reachSource = 'envelope';
    }
    if (reach == null) {
        out.excluded = 'The ODF gives it no reach.';
        return out;
    }
    const cooldown = pullCooldown(f.shotDelay, f.shotAlternate, g);
    const salvoCount = Math.max(1, f.salvoCount || 1);
    const salvoDelay = Math.max(0, f.salvoDelay || 0);
    const busy = (salvoCount - 1) * salvoDelay;
    const alternating = !!calc.alternating;
    return Object.assign(out, {
        perHit: calc.perHit,
        letter: calc.letter,
        g,
        alternating,
        barrels: alternating ? 1 : g,
        shotDelay: f.shotDelay,
        shotVariance: f.shotVariance || 0,
        salvoCount,
        salvoDelay,
        cooldown,
        busy,
        cycle: Math.max(cooldown, busy),
        calcInterval: calc.shotInterval,
        ammoPerRound: calc.ammoPerShot > 0 ? calc.ammoPerShot : 0,
        reach,
        reachSource,
        aiRange: p.aiRange != null ? p.aiRange : null,
        shotSpeed: p.shotSpeed,
        hitscan: archetype === 'beam',
        lob,
        shotPitch: lob && profile.shotPitch > 0.05 ? profile.shotPitch : 0,
        gravity: lob ? gravity : 0,
        homing: archetype === 'missile',
        pulse: calc.kind === 'pulse',
        cap: archetype === 'detonator' ? Math.max(1, Math.round(profile.detonator.maxCount)) : 0,
        burst: archetype === 'detonator' && calc.burst ? { value: calc.burst.value, radius: calc.burst.radius } : null,
        tier: calc.tier === 'estimated' || lob || archetype === 'missile' ? 'estimated' : 'exact',
        warnings: (calc.warnings || []).slice(),
    });
}

/* Seconds from a round leaving the barrel to it reaching a target `d` metres
 * away: hitscan beams at once, lobbed shells on a flat-ground ballistic arc
 * (the range's own lob: the low angle, or the ODF's fixed shotPitch). */
export function flightTime(w, d) {
    if (w.hitscan) return 0;
    if (w.lob) {
        const v = w.shotSpeed;
        const g = w.gravity;
        if (!(v > 0) || !(g > 0)) return 0;
        if (w.shotPitch > 0) return 2 * v * Math.sin(w.shotPitch) / g;
        const s = g * d / (v * v);
        if (s > 1) return Infinity;
        return d / (v * Math.cos(0.5 * Math.asin(Math.max(0, s))));
    }
    return w.shotSpeed > 0 ? d / w.shotSpeed : 0;
}

/* How far a shell `tau` seconds out of the barrel is from the centre of a
 * target `d` metres away, on flightTime()'s arc. It closes the ground at a
 * steady rate, at the lob's height above the launch. From the flight time on
 * it lies at the target (0). */
export function shellGap(w, d, tau) {
    const total = flightTime(w, d);
    if (!Number.isFinite(total)) return d;
    const t = Math.max(0, tau);
    if (!(total > 0) || t >= total) return 0;
    let rise = 0;
    if (w.lob) {
        const v = w.shotSpeed;
        const g = w.gravity;
        const pitch = w.shotPitch > 0 ? w.shotPitch : 0.5 * Math.asin(Math.min(1, g * d / (v * v)));
        rise = v * Math.sin(pitch) * t - 0.5 * g * t * t;
    }
    return Math.hypot(d * (1 - t / total), rise);
}

/* A shell burst `gap` metres from the target's centre: the ground
 * explosion's damageValue anywhere inside damageRadius plus the target's
 * radius (the live range's test), no falloff. */
export function burstDamage(w, gap, target) {
    const b = w.burst;
    if (!b || !(b.radius > 0) || !(b.value > 0)) return 0;
    const reach = b.radius + (target && target.radius > 0 ? target.radius : 0);
    return gap <= reach + EPS ? b.value : 0;
}

/* Indices of `weapons` (user order), longest cycle first (a launcher's
 * reload: its `rank`), the user's order on a tie. */
export function priorityOrder(weapons) {
    const key = (w) => (w.rank != null ? w.rank : w.cycle);
    return weapons.map((w, i) => i).sort((a, b) => {
        const d = key(weapons[b]) - key(weapons[a]);
        return Math.abs(d) > EPS ? d : a - b;
    });
}

export function distanceAt(m, t) {
    if (!m || !(m.speed > 0)) return m ? m.d0 : 0;
    return Math.max(m.stop || 0, m.d0 - m.speed * Math.max(0, t - m.t0));
}

/* First time at or after `from` the target sits within `reach`. */
function rangeEntry(m, from, reach) {
    if (distanceAt(m, from) <= reach + EPS) return from;
    if (!m || !(m.speed > 0) || reach + EPS < (m.stop || 0)) return Infinity;
    return m.t0 + (m.d0 - reach) / m.speed;
}

function ammoAt(s, st, t) {
    return Math.min(s.maxAmmo, st.ammo + Math.max(0, s.regen || 0) * Math.max(0, t - st.now));
}

/* Earliest pull of weapon i. A launcher's pull starts its lock, which builds
 * during the reload, so it waits for lockFrom (a turn after its last shot)
 * rather than readyAt. */
function earliestFire(s, st, i) {
    const slot = s.weapons[i];
    const w = slot.desc;
    if (w.cap && (slot.armed || 0) >= w.cap) return Infinity;
    const sw = st.current >= 0 && st.current !== i ? s.switchSec : 0;
    const gate = w.lock ? (slot.lockFrom || 0) : (slot.readyAt || 0);
    let t = Math.max(st.now, gate, st.freeAt + sw, s.notBefore || 0);
    // A TAG pull spends only the leader (each missile pays as it launches),
    // but waits until the first missile volley is affordable too.
    const need = w.tag ? w.tag.pullAmmo : w.ammoPerRound;
    if (need > 0) {
        if (need > s.maxAmmo + EPS) return Infinity;
        if (ammoAt(s, st, t) + EPS < need) {
            if (!(s.regen > 0)) return Infinity;
            t = Math.max(t, st.now + (need - st.ammo) / s.regen);
        }
    }
    return rangeEntry(s.motion, t, w.reach);
}

/* When a pull of weapon i started at `t` puts rounds out: at once, or for a
 * launcher once its lock is held and its reload has run. */
export function shotTime(slot, t) {
    const w = slot.desc;
    return w.lock ? Math.max(t + w.lock.hold, slot.readyAt || 0) : t;
}

/* Next pull: { index, at, shot } or null when nothing can fire again.
 *
 * s = { now, freeAt, current, ammo, maxAmmo, regen, switchSec, notBefore,
 *       motion: { t0, d0, speed, stop }, weapons: [{ desc, readyAt, armed, lockFrom }] }
 * with weapons in the user's order. A weapon fires at its earliest time unless
 * its salvo or the switch back pushes back a higher-priority weapon that would
 * fire then; a pull occupies the player for its salvo (a launcher's: its
 * lock and release), and changing weapon costs switchSec. A higher-priority launcher is
 * pushed back only when its shot is, not its lock's start. A launcher whose
 * lock would span the next other pull waits for it instead when its shot
 * time does not move, so a lock is not built and then let go across another
 * weapon's pull. Ammo only gates a weapon's own pull: a dry tank does not
 * hold a faster weapon back to save rounds for a slower one. */
export function decide(s) {
    const n = s.weapons.length;
    if (!n) return null;
    const order = priorityOrder(s.weapons.map((w) => w.desc));
    const st = { now: s.now, freeAt: s.freeAt || 0, current: s.current, ammo: s.ammo };
    const at = s.weapons.map((w, i) => earliestFire(s, st, i));
    const valid = new Array(n).fill(false);
    let best = -1;
    for (let r = 0; r < order.length; r++) {
        const j = order[r];
        if (!(at[j] < Infinity)) continue;
        const w = s.weapons[j].desc;
        const after = { now: at[j], freeAt: at[j] + w.busy, current: j, ammo: ammoAt(s, st, at[j]) };
        let ok = true;
        for (let q = 0; q < r && ok; q++) {
            const k = order[q];
            const slot = s.weapons[k];
            if (valid[k] && shotTime(slot, earliestFire(s, after, k)) > shotTime(slot, at[k]) + EPS) ok = false;
        }
        valid[j] = ok;
        if (ok && (best < 0 || at[j] < at[best] - EPS)) best = j;
    }
    if (best < 0) return null;
    const lockShot = shotTime(s.weapons[best], at[best]);
    if (s.weapons[best].desc.lock) {
        let k = -1;
        for (let i = 0; i < n; i++) {
            if (i !== best && valid[i] && (k < 0 || at[i] < at[k] - EPS)) k = i;
        }
        if (k >= 0 && at[k] < lockShot - EPS) {
            const after = {
                now: at[k],
                freeAt: at[k] + s.weapons[k].desc.busy,
                current: k,
                ammo: Math.max(0, ammoAt(s, st, at[k]) - pullSpend(s.weapons[k].desc)),
            };
            if (shotTime(s.weapons[best], earliestFire(s, after, best)) <= lockShot + EPS) {
                return { index: k, at: at[k], shot: shotTime(s.weapons[k], at[k]) };
            }
        }
    }
    return { index: best, at: at[best], shot: lockShot };
}

// Ammo one pull of `w` takes from the tank, regen during its salvo aside.
function pullSpend(w) {
    const round = w.ammoPerRound > 0 ? w.ammoPerRound : 0;
    if (w.tag) return w.tag.leaderAmmo + w.salvoCount * w.barrels * round;
    if (w.lock) return w.barrels * round;
    return Math.max(1, w.salvoCount || 1) * w.barrels * round;
}

function roundDamage(w, target) {
    if (w.cap && !mdmDetonates(target)) return 0;
    return w.perHit > 0 ? w.perHit : 0;
}

function blockedReason(s, st) {
    const reasons = s.weapons.map((slot) => {
        const w = slot.desc;
        if (w.cap && slot.armed >= w.cap) return 'capped';
        if (w.ammoPerRound > s.maxAmmo + EPS) return 'ammo';
        if (w.ammoPerRound > 0 && st.ammo + EPS < w.ammoPerRound && !(s.regen > 0)) return 'ammo';
        if (rangeEntry(s.motion, st.now, w.reach) === Infinity) return w.lock ? 'lock' : 'range';
        return 'other';
    });
    const kinds = Array.from(new Set(reasons));
    if (kinds.length === 1) return kinds[0];
    return kinds.every((k) => k === 'range' || k === 'lock') ? 'range' : 'mixed';
}

/* When every weapon of `weapons` is first in range (Infinity if one never is). */
export function allInRangeAt(weapons, distance, closing) {
    const m = { t0: 0, d0: distance, speed: closing && closing.speed > 0 ? closing.speed : 0, stop: closing ? closing.stop || 0 : 0 };
    return weapons.reduce((t, w) => Math.max(t, rangeEntry(m, 0, w.reach)), 0);
}

/* One engagement from Fire at t = 0: pulls in decide() order, each round
 * landing after its flight, until the hull reaches 0. A pull of another
 * weapon bursts the last one's armed MDM shells where they are.
 *
 * o = { weapons: [desc], switchSec, distance, closing: { speed, stop } | null,
 *       ammo: { max, regen, start }, target: { maxHealth, building, mdmRule, radius },
 *       notBefore } */
export function planWeave(o) {
    const weapons = (o.weapons || []).filter((w) => w && !w.excluded);
    const target = o.target || {};
    const hp0 = target.maxHealth > 0 ? target.maxHealth : 0;
    const out = {
        ttk: Infinity,
        reason: null,
        firstShotAt: null,
        pulls: [],
        weapons: weapons.map((w) => ({ key: w.key, name: w.name, pulls: 0, rounds: 0, damage: 0, ammo: 0, bursts: 0, burstDealt: 0, firstAt: null })),
        ammoUsed: 0,
    };
    if (!weapons.length) {
        out.reason = 'none';
        return out;
    }
    const motion = {
        t0: 0,
        d0: o.distance,
        speed: o.closing && o.closing.speed > 0 ? o.closing.speed : 0,
        stop: o.closing ? o.closing.stop || 0 : 0,
    };
    const deal = weapons.map((w) => roundDamage(w, target));
    const contact = mdmDetonates(target);
    // Only a change of weapon bursts an MDM shell, so a lone MDM never does.
    const switching = weapons.length > 1;
    const lethal = hp0 > 0 && weapons.some((w, k) => deal[k] > 0 || (switching && w.cap && burstDamage(w, 0, target) > 0));
    const horizon = lethal ? PLAN_MAX_SEC : PREVIEW_SEC;
    const maxAmmo = o.ammo && o.ammo.max > 0 ? o.ammo.max : 0;
    const s = {
        maxAmmo,
        regen: o.ammo ? o.ammo.regen || 0 : 0,
        switchSec: o.switchSec > 0 ? o.switchSec : 0,
        motion,
        notBefore: o.notBefore || 0,
        weapons: weapons.map((w) => ({ desc: w, readyAt: 0, armed: 0, lockFrom: 0 })),
    };
    const st = { now: 0, freeAt: 0, current: -1, ammo: o.ammo && o.ammo.start != null ? o.ammo.start : maxAmmo };
    const pending = [];
    // Armed MDM shells the target bounced (a building): they lie beside it.
    const resting = [];
    let hp = hp0;
    const burstShells = (k, t) => {
        const w = weapons[k];
        [pending, resting].forEach((list) => {
            for (let n = list.length - 1; n >= 0; n--) {
                const shell = list[n];
                if (shell.i !== k || !shell.frees) continue;
                list.splice(n, 1);
                s.weapons[k].armed -= 1;
                out.weapons[k].bursts += 1;
                const dmg = burstDamage(w, shellGap(w, shell.d0, t - shell.t0), target);
                if (lethal && dmg > 0 && hp > EPS) {
                    hp -= dmg;
                    out.weapons[k].damage += dmg;
                    out.weapons[k].burstDealt += dmg;
                }
            }
        });
    };
    let steps = 0;
    while (steps++ < PLAN_MAX_STEPS) {
        const dec = decide(Object.assign({}, s, st));
        const tPull = dec ? dec.at : Infinity;
        let tLand = Infinity;
        pending.forEach((p) => { if (p.t < tLand) tLand = p.t; });
        if (tLand === Infinity && tPull === Infinity) {
            out.reason = blockedReason(s, st);
            break;
        }
        if (tLand <= tPull + EPS) {
            for (let k = pending.length - 1; k >= 0; k--) {
                const p = pending[k];
                if (p.t > tLand + EPS) continue;
                pending.splice(k, 1);
                if (p.frees) s.weapons[p.i].armed -= 1;
                if (lethal && p.dmg > 0 && hp > EPS) {
                    hp -= p.dmg;
                    out.weapons[p.i].damage += p.dmg;
                }
            }
            if (lethal && hp <= EPS) {
                out.ttk = tLand;
                out.reason = 'killed';
                break;
            }
            if (st.now < tLand) {
                st.ammo = ammoAt(s, st, tLand);
                st.now = tLand;
            }
            continue;
        }
        if (tPull > horizon) {
            out.reason = lethal ? 'timeout' : (hp0 > 0 ? 'nodamage' : 'notarget');
            break;
        }
        const i = dec.index;
        if (st.current >= 0 && st.current !== i) {
            burstShells(st.current, tPull);
            if (lethal && hp <= EPS) {
                out.ttk = tPull;
                out.reason = 'killed';
                break;
            }
        }
        const w = weapons[i];
        const slot = s.weapons[i];
        const rec = out.weapons[i];
        if (w.tag) {
            // The leader leaves on this pull and the player is free at once.
            // A hit queues salvoCount missiles per hardpoint at firstDelay,
            // then salvoDelay apart. Every missile pays its ammoCost from the
            // tank the filler also uses; the planner sets the whole salvo's
            // ammo aside at the pull so the filler cannot spend it first.
            const d0 = distanceAt(motion, tPull);
            const hitAt = tPull + (w.tag.leaderSpeed > 0 ? d0 / w.tag.leaderSpeed : 0);
            const missileT = w.shotSpeed > 0 ? d0 / w.shotSpeed : 0;
            let ammo = ammoAt(s, st, tPull) - w.tag.leaderAmmo;
            rec.ammo += w.tag.leaderAmmo;
            out.ammoUsed += w.tag.leaderAmmo;
            let fired = 0;
            for (let k = 0; k < w.salvoCount; k++) {
                const tr = hitAt + w.tag.firstDelay + k * w.salvoDelay;
                let volley = 0;
                for (let b = 0; b < w.barrels; b++) {
                    if (w.ammoPerRound > 0) {
                        if (ammo + EPS < w.ammoPerRound) break;
                        ammo -= w.ammoPerRound;
                        rec.ammo += w.ammoPerRound;
                        out.ammoUsed += w.ammoPerRound;
                    }
                    volley += 1;
                    pending.push({ t: tr + missileT, i, dmg: deal[i], frees: false, t0: tr, d0 });
                }
                if (!volley) break;
                fired += volley;
            }
            rec.pulls += 1;
            rec.rounds += fired;
            if (rec.firstAt == null) rec.firstAt = tPull;
            if (out.firstShotAt == null) out.firstShotAt = tPull;
            if (out.pulls.length < PLAN_MAX_PULLS) out.pulls.push({ t: tPull, index: i, d: d0, rounds: fired });
            // Inside leader reach the leader flies d / shotSpeed, not its
            // whole lifeSpan, so the hardpoint frees that much sooner.
            slot.readyAt = Math.max(tPull + pullCooldown(w.shotDelay, false, 1), hitAt + w.tag.hold);
            st.ammo = ammo;
            st.freeAt = tPull;
            st.current = i;
            st.now = tPull;
            continue;
        }
        if (w.lock) {
            // The player holds the lock from tPull; the volley leaves once it
            // is done and the reload has run, whatever is selected by then.
            // Planner choice, as for TAG: its ammo is set aside at the lock's
            // start so a filler cannot spend it first.
            const tShot = shotTime(slot, tPull);
            const d = distanceAt(motion, tShot);
            let ammo = ammoAt(s, st, tPull);
            let volley = 0;
            for (let b = 0; b < w.barrels; b++) {
                if (w.ammoPerRound > 0) {
                    if (ammo + EPS < w.ammoPerRound) break;
                    ammo -= w.ammoPerRound;
                    rec.ammo += w.ammoPerRound;
                    out.ammoUsed += w.ammoPerRound;
                }
                volley += 1;
                pending.push({ t: tShot + flightTime(w, d), i, dmg: deal[i], frees: false, t0: tShot, d0: d });
            }
            rec.pulls += 1;
            rec.rounds += volley;
            if (rec.firstAt == null || tShot < rec.firstAt) rec.firstAt = tShot;
            if (out.firstShotAt == null || tShot < out.firstShotAt) out.firstShotAt = tShot;
            if (out.pulls.length < PLAN_MAX_PULLS) out.pulls.push({ t: tShot, index: i, d, rounds: volley, lockFrom: tPull });
            slot.readyAt = tShot + w.cooldown;
            slot.lockFrom = tShot + TURN_SEC;
            st.ammo = Math.min(maxAmmo, ammo + s.regen * w.busy);
            st.freeAt = tPull + w.busy;
            st.current = i;
            st.now = tPull + w.busy;
            continue;
        }
        let ammo = ammoAt(s, st, tPull);
        let fired = 0;
        for (let k = 0; k < w.salvoCount; k++) {
            const tr = tPull + k * w.salvoDelay;
            if (k > 0) ammo = Math.min(maxAmmo, ammo + s.regen * w.salvoDelay);
            let volley = 0;
            for (let b = 0; b < w.barrels; b++) {
                if (w.ammoPerRound > 0) {
                    if (ammo + EPS < w.ammoPerRound) break;
                    ammo -= w.ammoPerRound;
                    rec.ammo += w.ammoPerRound;
                    out.ammoUsed += w.ammoPerRound;
                }
                volley += 1;
                const d = distanceAt(motion, tr);
                const round = { t: tr + flightTime(w, d), i, dmg: deal[i], frees: !!w.cap, t0: tr, d0: d };
                if (w.cap) slot.armed += 1;
                if (w.cap && !contact) resting.push(round);
                else pending.push(round);
            }
            if (!volley) break;
            fired += volley;
        }
        rec.pulls += 1;
        rec.rounds += fired;
        if (rec.firstAt == null) rec.firstAt = tPull;
        if (out.firstShotAt == null) out.firstShotAt = tPull;
        if (out.pulls.length < PLAN_MAX_PULLS) out.pulls.push({ t: tPull, index: i, d: distanceAt(motion, tPull), rounds: fired });
        slot.readyAt = tPull + w.cooldown;
        st.freeAt = tPull + w.busy;
        st.current = i;
        st.now = tPull + w.busy;
        st.ammo = ammo;
    }
    if (!out.reason) out.reason = 'timeout';
    // A launcher's volley can leave after a later pull of another weapon,
    // or never, when the kill lands while it waits on its lock or reload.
    out.pulls.sort((a, b) => a.t - b.t);
    if (out.reason === 'killed') {
        out.pulls = out.pulls.filter((p) => {
            if (p.t <= out.ttk + EPS) return true;
            const rec = out.weapons[p.index];
            const spent = p.rounds * (weapons[p.index].ammoPerRound || 0);
            rec.pulls -= 1;
            rec.rounds -= p.rounds;
            rec.ammo -= spent;
            out.ammoUsed -= spent;
            if (rec.firstAt != null && rec.firstAt > out.ttk + EPS) rec.firstAt = null;
            return false;
        });
    }
    return out;
}
