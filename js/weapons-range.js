/* Shooting range: the Weapons Lab's main pill (also `?tab=range` and the old
 * `?tab=scenario`). Loaded from weapons/index.html unless the page opens on
 * the Damage matrix.
 *
 * Composes ObjectViewer (the shooter), a second prop (the target) and the
 * ODF effect runtime. Cameras are fixed views: chase (default), a slow
 * orbit around the ship, and first person on hp_eyepoint with the optional
 * cockpit mesh. The turret tracks the target on its own; there is no mouse
 * control. The in-view weapon panel (the Explorer's pill rows and status
 * gauge, js/explorer/hud.js) picks which slot fires, and each pill's swap
 * button opens the page's weapon drawer on that hardpoint group.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ObjectViewer } from './models-viewer.js';
import { createFxRuntime, SIM_GRAVITY } from './fx/odf-fx.js';
import { createAudio } from './fx/odf-audio.js';
import { createRangeSim } from './fx/weapon-sim.js';
import { buildProfile, profileAssets, shieldEffectFor, explosionEntry, stemOf } from './fx/weapon-profile.js';
import {
    weaveWeapon, planWeave, priorityOrder, allInRangeAt, engagementReach, openingCentre,
    TURN_SEC, CLOSE_STOP_M, PLAN_MAX_SEC, SURFACE_MARGIN_M, OPENING_MAX_M,
} from './weapons-weave.js';
import { createStatusGauge, applyGamePalette } from './explorer/hud.js';

const GEOM = '../data/models/geometry/';
const MODELS_INDEX = '../data/models/index.json';
const RETICLE = '../data/ui/reticles/';
const HUD_ICONS = '../data/ui/hud/';
const COCKPIT = '../data/models/cockpits/';
const ORBIT_RATE = 0.16;          // rad/s, the hover-around-the-ship view
const RESPAWN_SEC = 2.5;
const VOLUME_KEY = 'vt.wpn.range.volume';   // localStorage, 0..100; missing = 100
const LOCK_VOLUME_KEY = 'vt.wpn.range.lockVolume';   // localStorage, 0..100 of master; missing = 50
const RAVE_PEAK = 0.62;           // CannonClass.raveFlash wash; fades to clear across shotDelay
const HP_ICONS = { GUN: 'gun', CANN: 'cannon', MORT: 'mortar', ROCK: 'rocket', SPEC: 'special', SHIE: 'shield', HAND: 'hand', PACK: 'pack' };
// Hardpoint category codes -> display words (same words as SLOT_LABELS in js/models.js).
const HP_LABELS = { GUN: 'Gun', CANN: 'Cannon', MORT: 'Mortar', ROCK: 'Rocket', SPEC: 'Special', SHIE: 'Shield', HAND: 'Hand', PACK: 'Pack' };
const HULL_TURN_FALLBACK = 1.5;   // rad/s when the models index has no drive.omegaTurn
const HULL_PITCH_MIN = -25 * Math.PI / 180;   // nose-down limit for hull-fixed guns
const HULL_PITCH_MAX = 45 * Math.PI / 180;    // nose-up limit
const NO_PARTS = { turretNodes: [], pitchNodes: [], recoilNodes: [], head: null };
const _gltf = new GLTFLoader();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

let viewer = null;
let fx = null;
let audio = null;
let sim = null;
let db = null;
let fxIndex = null;
let cockpitIndex = null;
let reticleIndex = null;
let modelsByStem = null;      // Promise<Map stem -> data/models/index.json entry>
let rangeAxis = new THREE.Vector3(0, 0, -1);   // the hull's flat forward at load; the range is laid along it
let hullYaw = 0;              // radians the hull has turned off rangeAxis (hull-fixed guns only)
let hullPitch = 0;            // radians of nose up when no joint can pitch the gun
let hullTurnRate = HULL_TURN_FALLBACK;
let rootEl = null;
let loop = true;
let raveEl = null;
let raveColors = [];
let raveIndex = -1;
let raveLeft = 0;
let raveDur = 0.4;
let raveShotDelay = 0.4;

let target = null;
let targetKind = 'ship';
let targetRadius = 6;
let targetLocalBox = null;    // hull box in the target's own frame (what the .msh header bakes)
let targetNear = 0;           // how far that box reaches back toward the ship
let targetLift = 0;
let targetCom = null;   // hp_com node, the engine's lock-circle anchor; null = mesh origin
let targetName = '';
let targetLetter = 'N';
let hp = 0;
let maxHp = 0;
let hpRegen = 0;
let deadFor = 0;
let deathXpl = '';
let shieldDef = null;
let floorSize = 0;
let shipTravel = 0;             // metres the viewer has the ship ahead of its home pivot
let distance = 80;
let moving = false;
let clock = 0;
let cameraMode = 'chase';
let showCockpit = false;
let cockpit = null;
let orbitAngle = 0;

let snapshot = null;
let shooterKey = '';
let onPickSlot = null;
/* One slot per hardpoint GROUP: every hardpoint sharing a category and an
 * assault flag mounts the same weapon and fires together, like the game
 * (a weapon powerup replaces the whole group). A combat and an assault
 * hardpoint of the same category stay separate slots.
 * [{key, index, category, assault, nodes, count, weapon, options}] */
let slots = [];
let activeSlot = -1;
let lastReticle = '';
let hudEls = {};
let gauge = null;               // createStatusGauge(): the ship's hull and the shared ammo tank
let slotStats = [];             // per slot: snapshot.statsFor() of its mount, rebuilt with the pills
let pillShots = [];             // per slot: { el, text } of the pill's shots-left cell
let hudText = {};               // last text painted into each per-frame HUD cell

/* Weapon switch: the ticked groups share the trigger (js/weapons-weave.js).
 * Range-local view state, like the distance and the view. */
const SWITCH_MAX_SEC = 1;
const RIBBON_RUNS = 18;
const PLAN_HORIZON_MIN = PLAN_MAX_SEC / 60;
let weaveOn = false;
const weavePicks = new Map();   // slot key -> the user's tick; see isPicked() for untouched keys
let weaveOrder = [];            // slot keys in the user's order, which breaks equal cycles
let weaveDescs = [];            // per slot: weaveWeapon() of its mount
let switchSec = TURN_SEC;
let closing = false;
let closeSpeed = null;          // m/s typed by the user; null = the ship's ODF velocForward
let startDistance = 80;
let weavePlan = null;
let lastWeaveKey;
let hasDetonator = false;
let fight = null;               // { elapsed, from } while Fire is held from a full hull
let lastKill = null;            // { sec, from }
let dragKey = null;
const profileCache = new Map();

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Sound volumes as 0..100 percentages: master, and lock-on tones on top of
 * it. Missing or unreadable storage falls back to the channel's default. */
const VOLUMES = {
    master: { key: VOLUME_KEY, fallback: 100 },
    lock: { key: LOCK_VOLUME_KEY, fallback: 50 },
};

function loadVolume(channel) {
    const c = VOLUMES[channel];
    try {
        const raw = localStorage.getItem(c.key);
        if (raw == null) return c.fallback;
        const n = Number(raw);
        return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : c.fallback;
    } catch (err) {
        return c.fallback;
    }
}

function saveVolume(channel, pct) {
    try { localStorage.setItem(VOLUMES[channel].key, String(pct)); } catch (err) { /* storage unavailable */ }
}

function applyVolume(channel, pct) {
    if (audio) {
        if (channel === 'lock') audio.setLockVolume(pct / 100);
        else audio.setVolume(pct / 100);
    }
    const out = rootEl && rootEl.querySelector('[data-range-volume-out="' + channel + '"]');
    if (out) out.textContent = pct + '%';
    if (channel !== 'master') return;
    const icon = rootEl && rootEl.querySelector('[data-range-volume-icon]');
    if (icon) {
        icon.className = 'bi ' + (pct <= 0 ? 'bi-volume-mute' : pct < 50 ? 'bi-volume-down' : 'bi-volume-up');
    }
    const text = rootEl && rootEl.querySelector('[data-range-volume-text]');
    if (text) text.textContent = pct + '%';
}

function mergeFxIndex(stock, extras) {
    const out = {
        textures: Object.assign({}, (stock && stock.textures) || {}),
        geometry: Object.assign({}, (stock && stock.geometry) || {}),
        sounds: Object.assign({}, (stock && stock.sounds) || {}),
        credits: ((stock && stock.credits) || []).slice(),
    };
    (extras || []).forEach((src) => {
        if (!src) return;
        ['textures', 'geometry', 'sounds'].forEach((key) => {
            Object.keys(src[key] || {}).forEach((stem) => {
                if (!out[key][stem]) out[key][stem] = src[key][stem];
            });
        });
    });
    return out;
}

function assetMaps() {
    const textures = {};
    const geometry = {};
    const idx = fxIndex || {};
    Object.keys(idx.textures || {}).forEach((stem) => { textures[stem] = '../data/' + idx.textures[stem].file; });
    Object.keys(idx.geometry || {}).forEach((stem) => { geometry[stem] = '../data/' + idx.geometry[stem].file; });
    return { textures, geometry };
}

function contribSoundUrls() {
    const urls = {};
    const sounds = (fxIndex && fxIndex.sounds) || {};
    Object.keys(sounds).forEach((stem) => {
        const file = sounds[stem] && sounds[stem].file;
        if (file && file.indexOf('audio/') !== 0) urls[stem] = '../data/' + file;
    });
    return urls;
}

function reticleFile(frame) {
    if (!frame || !reticleIndex || !reticleIndex.frames) return '';
    const hit = reticleIndex.frames[frame] || reticleIndex.frames[frame + '.0'];
    return hit ? RETICLE + hit.file : '';
}

/* ---- shooter / loadout ------------------------------------------------- */

function activeWeapon() {
    const slot = slots[activeSlot];
    return slot ? slot.weapon : null;
}

/* Hardpoints that fire with a slot (the active one unless the weapon switch
 * names another): the whole group. */
function firingNodes(key) {
    const slot = key ? slots.find((s) => s.key === key) : slots[activeSlot];
    if (!slot || !slot.weapon) return [];
    return slot.nodes.slice();
}

function groupKeyOf(hp) {
    return String(hp.category || 'GUN') + (hp.assault ? ':a' : ':c');
}

function hullForward(out) {
    viewer.worldForwardOf(null, out);
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    return out;
}

function muzzles(key) {
    const nodes = firingNodes(key);
    if (!nodes.length) nodes.push(null);
    const hull = hullForward(new THREE.Vector3());
    return nodes.map((node) => {
        const pos = (viewer.worldPointOf(node, _v) || viewer.worldPointOf(null, _v) || new THREE.Vector3(0, 1.5, 0)).clone();
        const fwd = (viewer.worldForwardOf(node, _fwd) || hull).clone();
        if (Math.abs(fwd.y) > 0.85 || fwd.lengthSq() < 1e-6) fwd.copy(hull);
        return { position: pos, forward: fwd.normalize(), node };
    });
}

/* The page owns the loadout (it is in the URL), so `snap.loadout` is the
 * authority on what each group carries; `hp.mounted` is only the fallback for
 * a snapshot that carries no map. keepActive holds the firing slot where the
 * user left it, which no loadout edit should move. */
function buildSlots(snap, keepActive) {
    const prevKey = keepActive && slots[activeSlot] ? slots[activeSlot].key : null;
    const lo = snap.loadout || {};
    const groups = new Map();
    (snap.hardpoints || []).forEach((hp) => {
        const key = groupKeyOf(hp);
        let g = groups.get(key);
        if (!g) {
            g = {
                key,
                index: hp.index,
                category: hp.category,
                assault: !!hp.assault,
                nodes: [],
                count: 0,
                weapon: (Object.prototype.hasOwnProperty.call(lo, key) ? lo[key] : hp.mounted) || null,
                options: snap.optionsFor ? snap.optionsFor(hp) : [],
            };
            groups.set(key, g);
        }
        g.count += 1;
        if (hp.node && !g.nodes.includes(hp.node)) g.nodes.push(hp.node);
    });
    slots = Array.from(groups.values());
    // No ship picked (or no fitting hardpoint): still fire the scenario weapon
    // from a virtual slot at the ship origin. The page's loadout map already
    // put the scenario weapon on its own group when the ship has one.
    if (snap.weaponStem && !slots.some((s) => s.weapon === snap.weaponStem)) {
        slots.push({
            key: 'virtual', index: slots.length + 1, category: snap.weaponCategory || 'GUN', assault: false,
            nodes: [null], count: 1, weapon: snap.weaponStem, options: [], virtual: true,
        });
    }
    let idx = prevKey ? slots.findIndex((s) => s.key === prevKey && s.weapon) : -1;
    if (idx < 0 && snap.scenarioKey) idx = slots.findIndex((s) => s.key === snap.scenarioKey && s.weapon);
    if (idx < 0 && snap.weaponStem) idx = slots.findIndex((s) => s.weapon === snap.weaponStem);
    if (idx < 0) idx = slots.findIndex((s) => s.weapon);
    activeSlot = idx;
}

function ammoState() {
    return { max: snapshot ? snapshot.maxAmmo : 0, regen: snapshot ? snapshot.regen : 0 };
}

function applyActiveSlot(keepAmmo) {
    const stem = activeWeapon();
    const entry = stem && db.Weapon && db.Weapon[stem + '.odf'];
    const profile = entry ? buildProfile(entry, db && db.Ordnance, db) : null;
    // Fetch this weapon's textures, meshes and sounds, then upload and compile
    // them. Fire stays live while that runs; the stage chip says so.
    const epoch = warmEpoch;
    if (entry) scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + stem);
    sim.setWeapon(profile, db, ammoState(), keepAmmo);
    // Closing: a timed weapon holds fire until the target is within its reach.
    const desc = weaveDescs[activeSlot];
    sim.setReachGate(closingSpec() && desc && !desc.excluded ? desc.reach : null);
    raveColors = profile && profile.raveFlash ? (profile.raveColors || []) : [];
    raveShotDelay = profile && profile.shotDelay > 0 ? profile.shotDelay : 0.4;
    clearRave();
    renderPills();
    if (entry) warmOtherSlots(epoch, stem);
}

/* Mount changes, slot picks and weapon-switch settings all land here. */
function applyWeapons(keepAmmo) {
    hasDetonator = slots.some((s) => {
        const p = profileFor(s.weapon);
        return !!p && p.id === 'detonator';
    });
    refreshWeave();
    if (!weaveOn) {
        applyActiveSlot(keepAmmo);
        renderWeave();
        return;
    }
    const entries = weaveEntries();
    const epoch = warmEpoch;
    entries.forEach(({ slot }) => {
        const entry = db.Weapon && db.Weapon[slot.weapon + '.odf'];
        if (entry) scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + slot.weapon);
    });
    sim.setWeave({
        slots: entries.map(({ slot, desc }) => ({ key: slot.key, stem: slot.weapon, profile: profileFor(slot.weapon), desc })),
        switchSec,
        // The sim's decide() reads distance as the hull gap.
        closing: closingGapSpec(),
    }, db, ammoState(), keepAmmo);
    raveColors = [];
    clearRave();
    renderPills();
    renderWeave();
}

/* ---- weapon switch ----------------------------------------------------- */

function profileFor(stem) {
    if (!stem || !db || !db.Weapon) return null;
    if (profileCache.has(stem)) return profileCache.get(stem);
    const entry = db.Weapon[stem + '.odf'];
    const profile = entry ? buildProfile(entry, db.Ordnance, db) : null;
    profileCache.set(stem, profile);
    return profile;
}

function shipSpeed() {
    return snapshot && snapshot.shooterSpeed ? snapshot.shooterSpeed : null;
}

function closeSpeedNow() {
    if (snapshot && snapshot.shooterAlwaysDeployed) return 0;
    if (closeSpeed != null) return closeSpeed;
    const ship = shipSpeed();
    return ship ? ship.speed : 0;
}

/* Closing in the range's own units (centre to centre): stop CLOSE_STOP_M
 * past the no-overlap floor, so CLOSE_STOP_M is clear air to the hull. */
function closingSpec() {
    const v = closeSpeedNow();
    if (!(closing && v > 0)) return null;
    return { speed: v, stop: separationFloor() + CLOSE_STOP_M };
}

/* The same in the planner's units, which measure to the hull (hullGap). */
function closingGapSpec() {
    const v = closeSpeedNow();
    return closing && v > 0 ? { speed: v, stop: CLOSE_STOP_M + SURFACE_MARGIN_M } : null;
}

function refreshWeave() {
    weaveDescs = slots.map((slot) => {
        if (!slot.weapon || !snapshot || !snapshot.weaveInput) return null;
        return weaveWeapon({
            key: slot.key,
            profile: profileFor(slot.weapon),
            calc: snapshot.weaveInput(slot.weapon, slot.key),
            gravity: SIM_GRAVITY,
        });
    });
    const keys = slots.map((s) => s.key);
    weaveOrder = weaveOrder.filter((k) => keys.includes(k)).concat(keys.filter((k) => !weaveOrder.includes(k)));
}

/* A group the user has not touched starts ticked, except a mortar group,
 * which joins the switch only once ticked. */
function isPicked(key) {
    if (weavePicks.has(key)) return weavePicks.get(key);
    const slot = slots.find((s) => s.key === key);
    return !(slot && slot.category === 'MORT');
}

/* Ticked, schedulable groups in the user's order. */
function weaveEntries() {
    const out = [];
    weaveOrder.forEach((key) => {
        const i = slots.findIndex((s) => s.key === key);
        const desc = i >= 0 ? weaveDescs[i] : null;
        if (!desc || desc.excluded || !slots[i].weapon || !isPicked(key)) return;
        out.push({ slot: slots[i], desc, color: i % 5 });
    });
    return out;
}

function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function clearRave() {
    raveLeft = 0;
    raveIndex = -1;
    if (!raveEl) return;
    raveEl.hidden = true;
    raveEl.style.opacity = '0';
}

/* The weapon switch passes the profile that fired, so the wash uses that
 * weapon's colours and shotDelay. */
function onRaveFlash(p) {
    const colors = p && p.raveColors && p.raveColors.length ? p.raveColors : raveColors;
    if (reducedMotion() || !colors.length || !raveEl) return;
    raveIndex = (raveIndex + 1) % colors.length;
    const c = colors[raveIndex];
    raveDur = Math.max(0.05, p && p.shotDelay > 0 ? p.shotDelay : raveShotDelay);
    raveLeft = raveDur;
    raveEl.hidden = false;
    raveEl.style.backgroundColor = 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')';
    raveEl.style.opacity = String(RAVE_PEAK);
}

function paintRave(dt) {
    if (!raveEl || raveLeft <= 0) return;
    raveLeft = Math.max(0, raveLeft - dt);
    if (raveLeft <= 0 || raveDur <= 0) {
        raveEl.hidden = true;
        raveEl.style.opacity = '0';
        return;
    }
    raveEl.style.opacity = String(RAVE_PEAK * (raveLeft / raveDur));
}

/* ---- in-view weapon panel ---------------------------------------------- */

function slotName(s, st) {
    if (!s.weapon) return HP_LABELS[s.category] || s.category || '';
    if (st && st.name) return st.name;
    const option = s.options.find((o) => o.stem === s.weapon);
    if (option) return option.name;
    return snapshot && snapshot.weaponStem === s.weapon && snapshot.weaponName ? snapshot.weaponName : s.weapon;
}

/* Shots left in the shared tank, like the game's WeaponPanel: whole shots
 * for a per-shot weapon, seconds for a per-second drain, infinity when free. */
function shotsLeft(st, ammo) {
    if (!st) return '';
    if (st.ammoMode === 'perShot') {
        if (st.ammoPerShot > 0) return String(Math.floor(Math.max(0, ammo) / st.ammoPerShot));
        return st.ammoPerShot === 0 ? '\u221e' : '';
    }
    if (st.ammoMode === 'perSecond') {
        if (st.ammoPerSec > 0) return Math.floor(Math.max(0, ammo) / st.ammoPerSec) + 's';
        return st.ammoPerSec === 0 ? '\u221e' : '';
    }
    return '\u221e';
}

/* One pill per hardpoint group. With the switch off the pill is a radio
 * (the green pill fires); with it on, a visible checkbox puts the group in
 * the switch. The swap button opens the page's weapon drawer on the group. */
function pillHtml(s, i) {
    const st = slotStats[i];
    const name = slotName(s, st);
    const word = HP_LABELS[s.category] || s.category || '';
    const desc = weaveDescs[i];
    const why = weaveOn && s.weapon && desc && desc.excluded ? desc.excluded : '';
    const can = weaveOn ? !!s.weapon && !!desc && !why : !!s.weapon;
    const picked = weaveOn && can && isPicked(s.key);
    const on = !weaveOn && i === activeSlot;
    const id = 'vt-range-pill-' + i;
    const cls = 'vt-xp-wpn vt-wpn-range-pill is-c' + (i % 5)
        + (on ? ' is-on' : '') + (s.weapon ? '' : ' is-empty') + (s.virtual ? ' is-virtual' : '')
        + (weaveOn ? ' is-weave' + (picked ? ' is-picked' : '') + (can ? '' : ' is-excluded') : '');
    const where = s.virtual
        ? 'Not mounted: ' + ((snapshot && snapshot.shooterName) || 'this ship') + ' has no hardpoint for it, so it fires from the hull'
        : word + (s.assault ? ' (assault)' : '') + (s.count > 1 ? ', ' + s.count + ' hardpoints fire together' : '');
    const title = where + ' \u00b7 ' + (s.weapon ? name : 'empty') + (why ? ' \u00b7 ' + why : '')
        + (!weaveOn && s.weapon && i < 5 ? ' \u00b7 key ' + (i + 1) : '');
    const input = weaveOn
        ? '<input type="checkbox" class="form-check-input vt-wpn-range-pill-pick" id="' + id + '" data-range-weave-slot="' + i + '"'
            + (picked ? ' checked' : '') + (can ? '' : ' disabled') + ' aria-label="' + esc('Include ' + name + ' in the weapon switch') + '">'
        : '<input type="radio" class="visually-hidden" id="' + id + '" name="vt-range-slot" value="' + i + '"'
            + (on ? ' checked' : '') + (s.weapon ? '' : ' disabled') + ' aria-label="' + esc('Slot ' + (i + 1) + ': ' + (s.weapon ? name : word + ', empty')) + '">';
    const mult = !s.virtual && s.count > 1 ? '<span class="vt-mono vt-wpn-range-pill-mult" aria-hidden="true">&times;' + s.count + '</span>' : '';
    const tag = s.virtual ? '<span class="vt-wpn-range-pill-tag" aria-hidden="true">Not mounted</span>' : '';
    const swapText = s.weapon ? 'Swap ' + name + ' (' + (s.virtual ? 'not mounted' : word) + ')' : 'Mount a weapon on the ' + word + ' hardpoint';
    const swap = onPickSlot
        ? '<button type="button" class="vt-wpn-range-pill-swap" data-range-slot-open="' + i + '" aria-label="' + esc(swapText) + '" title="' + esc(swapText) + '">'
            + '<i class="bi bi-arrow-left-right" aria-hidden="true"></i></button>'
        : '';
    return '<label class="' + cls + '" for="' + id + '" data-slot-key="' + esc(s.key) + '" title="' + esc(title) + '">'
        + input
        + '<span class="vt-xp-wpn-badge"><img src="' + HUD_ICONS + 'hp_' + (HP_ICONS[s.category] || 'gun') + '.png" alt=""></span>'
        + '<span class="vt-mono vt-wpn-range-pill-key" aria-hidden="true">' + (i + 1) + '</span>'
        + '<span class="vt-xp-wpn-name">' + esc(name) + '</span>' + mult + tag
        + '<span class="vt-xp-wpn-shots" data-range-pill-shots="' + i + '">' + (s.weapon ? '' : '\u2297') + '</span>'
        + swap
        + '</label>';
}

function renderPills() {
    const box = hudEls.pills;
    if (!box) return;
    lastWeaveKey = undefined;
    slotStats = slots.map((s) => (s.weapon && snapshot && snapshot.statsFor ? snapshot.statsFor(s.weapon, s.key) : null));
    box.setAttribute('role', weaveOn ? 'group' : 'radiogroup');
    box.setAttribute('aria-label', weaveOn ? 'Weapons in the switch' : 'Firing weapon');
    box.innerHTML = slots.length
        ? slots.map(pillHtml).join('')
        : '<p class="vt-wpn-range-pills-empty">Pick a ship to load out.</p>';
    pillShots = slots.map((s, i) => ({ el: box.querySelector('[data-range-pill-shots="' + i + '"]'), text: s.weapon ? null : '\u2297' }));
}

function paintPills(state) {
    const ammo = state ? state.ammo : 0;
    pillShots.forEach((p, i) => {
        if (!p.el || !slots[i] || !slots[i].weapon) return;
        const text = shotsLeft(slotStats[i], ammo);
        if (text !== p.text) {
            p.text = text;
            p.el.textContent = text;
        }
    });
}

/* The ship's own hull (nothing shoots back, so it stays full) over the
 * shared ammo tank. */
function paintGauge(state) {
    if (!gauge) return;
    const hull = snapshot && snapshot.shooterHp > 0 ? Math.ceil(snapshot.shooterHp) : null;
    const max = state && state.maxAmmo > 0 ? state.maxAmmo : 0;
    const ammo = state && max ? Math.floor(state.ammo) : null;
    const key = hull + '|' + ammo + '|' + (max ? (state.ammo / max).toFixed(3) : '0');
    if (key === hudText.gauge) return;
    hudText.gauge = key;
    gauge.paint(hull != null ? 1 : 0, hull, max ? state.ammo / max : 0, ammo);
}

/* ---- readout (top left) ------------------------------------------------ */

const NO_KILL_SHORT = {
    notarget: 'no target', nodamage: 'no damage', range: 'out of reach', ammo: 'tank runs dry',
    capped: 'MDM shells armed', timeout: 'over ' + PLAN_HORIZON_MIN + ' min',
};

function readoutLine(key, value, opts) {
    const o = opts || {};
    return '<div class="vt-wpn-range-ro-line' + (o.extra ? ' is-extra' : '') + '"' + (o.title ? ' title="' + esc(o.title) + '"' : '') + '>'
        + '<span class="vt-wpn-range-ro-k">' + key + '</span>'
        + '<span class="vt-wpn-range-ro-v"' + (o.attr ? ' ' + o.attr : '') + '>' + value + '</span></div>';
}

function estTag(text) {
    return ' <span class="vt-wpn-range-ro-est">' + esc(text) + '</span>';
}

/* The lines that only change with the loadout, the target or the plan. The
 * gap and the last live kill are painted per frame into their cells. */
function renderReadout() {
    const box = hudEls.readoutBody;
    if (!box) return;
    const lines = [];
    const slot = slots[activeSlot];
    const st = !weaveOn && slot && slot.weapon ? slotStats[activeSlot] : null;
    const desc = !weaveOn && slot ? weaveDescs[activeSlot] : null;
    let reach = null;
    if (weaveOn) {
        const entries = weaveEntries();
        const ttk = !entries.length ? 'tick weapons'
            : weavePlan && Number.isFinite(weavePlan.ttk) ? esc(fmtSec(weavePlan.ttk)) + estTag('switch')
                : esc(weavePlan ? NO_KILL_SHORT[weavePlan.reason] || '\u2014' : '\u2014');
        lines.push(readoutLine('TTK', ttk, { title: 'Planned time to kill with the weapon switch, from Fire at the start distance' }));
        lines.push(readoutLine('SWITCH', esc(entries.length + (entries.length === 1 ? ' weapon' : ' weapons') + ' \u00b7 ' + fmtNum(switchSec) + ' s'), { extra: true }));
    } else if (st || slot) {
        let ttk = '\u2014';
        let title = '';
        if (weavePlan) {
            const est = desc && desc.tier === 'estimated';
            ttk = Number.isFinite(weavePlan.ttk)
                ? esc(fmtSec(weavePlan.ttk)) + (est ? estTag('est.') : '')
                : esc(NO_KILL_SHORT[weavePlan.reason] || '\u2014');
            title = 'Planned from Fire at the start distance: travel time, reach and ammo included';
        } else if (st) {
            if (st.ttk === Infinity) ttk = 'never';
            else if (st.ttk != null) ttk = esc(fmtSec(st.ttk)) + (st.ttkEstimated ? estTag('est.') : '');
            title = st.lock
                ? 'Calculator time to kill: one lock before every release (estimated)'
                : 'Calculator time to kill';
        }
        lines.push(readoutLine('TTK', ttk, { title }));
        const lock = st && st.lock;
        if (lock) {
            const sig = lock.signature ? ' \u00b7 ' + lock.signature + ' ' + fmtNum(lock.signatureValue) : '';
            const value = lock.never ? 'never' + (lock.signature ? ' \u00b7 ' + lock.signature + ' 0' : '') : esc(fmtSec(lock.seconds)) + esc(sig);
            lines.push(readoutLine('LOCK', value, {
                title: 'lockDelay ' + fmtNum(lock.lockDelay) + ' s' + (lock.stages > 1 ? ' x ' + (lock.stages - 1) + '/' + lock.stages : '')
                    + (lock.signature ? ' / ' + lock.signature + 'Signature ' + fmtNum(lock.signatureValue) : '')
                    + ' \u00b7 cone ' + fmtNum(lock.coneAngle, 3) + ' rad',
            }));
            if (lock.lockRange > 0) reach = { m: lock.lockRange, word: 'lock' };
        }
        if (st && st.dps != null) {
            const hit = st.perHit != null ? ' \u00b7 ' + fmtNum(st.perHit, 1) + '/hit ' + (st.letter || '') : '';
            lines.push(readoutLine('DPS', esc(fmtNum(st.dps, 1) + hit), { extra: true, title: 'Damage per second of the whole group against this target\'s armor class' }));
        }
        if (st && st.shotsToKill != null && Number.isFinite(st.shotsToKill)) {
            const tank = st.tankFraction != null ? ' \u00b7 ' + Math.round(st.tankFraction * 100) + '% tank' : '';
            lines.push(readoutLine('SHOTS', esc(st.shotsToKill + ' to kill' + tank), { extra: true }));
        }
        if (!reach && desc && desc.reach > 0) reach = { m: desc.reach, word: 'reach' };
    }
    const reachText = reach ? ' \u00b7 ' + reach.word + ' ' + fmtNum(reach.m, 0) + ' m' : '';
    lines.push(readoutLine('GAP', '', { extra: true, attr: 'data-range-ro-gap', title: 'Clear air from the nose (or muzzle) to the target\'s hull' + (reach ? ', against the weapon\'s ' + reach.word : '') }));
    lines.push(readoutLine('KILL', '', { extra: true, attr: 'data-range-ro-kill', title: 'Last kill in the live range, timed from Fire on a full hull' }));
    box.innerHTML = lines.join('');
    hudEls.roGap = box.querySelector('[data-range-ro-gap]');
    hudEls.roKill = box.querySelector('[data-range-ro-kill]');
    hudText.reach = reach ? reach.m : null;
    hudText.reachText = reachText;
    hudText.gap = undefined;
    hudText.kill = undefined;
}

function paintReadout(state) {
    if (hudEls.roHead) {
        const head = state && state.archetype
            ? (state.honesty === 'approximated' ? 'a' : 'd') + '|' + (state.name || '') + '|' + (state.label || '')
            : (weaveOn ? 'weave' : 'none');
        if (head !== hudText.head) {
            hudText.head = head;
            const approx = state && state.honesty === 'approximated';
            hudEls.roHead.innerHTML = state && state.archetype
                ? '<span class="vt-wpn-range-ro-tag' + (approx ? ' is-approx' : '') + '" title="'
                    + (approx ? 'Approximated: the effect stands in for a class the range cannot draw from the ODF' : 'Data-driven: drawn from the ODF effect definitions') + '">'
                    + (approx ? 'Approximated' : 'Data-driven') + '</span>'
                    + '<span class="vt-wpn-range-ro-name">' + esc(state.name || state.label) + '</span>'
                    + '<span class="vt-wpn-range-ro-arch">' + esc(state.label) + '</span>'
                : '<span class="vt-wpn-range-ro-name">' + (weaveOn ? 'Weapon switch' : 'No weapon in this slot') + '</span>';
        }
    }
    if (hudEls.roGap) {
        const gap = Math.round(hullGap(distance));
        if (gap !== hudText.gap) {
            hudText.gap = gap;
            hudEls.roGap.textContent = gap + ' m' + (hudText.reachText || '');
            hudEls.roGap.classList.toggle('is-warn', hudText.reach != null && gap > hudText.reach);
        }
    }
    if (hudEls.roKill && lastKill !== hudText.kill) {
        hudText.kill = lastKill;
        hudEls.roKill.textContent = lastKill ? fmtSec(lastKill.sec) + ' from ' + fmtNum(lastKill.from, 0) + ' m' : '\u2014';
    }
}

/* The hint over the pills: release to fire, locking, out of the cone. */
function paintHint(state) {
    if (!hudEls.hint) return;
    const text = state && state.hint ? state.hint : '';
    if (text === hudText.hint) return;
    hudText.hint = text;
    hudEls.hint.textContent = text;
    hudEls.hint.hidden = !text;
}

function fmtNum(value, digits) {
    const C = window.VTWeaponsCalc;
    if (C && C.fmt) return C.fmt(value, digits);
    return value == null || !Number.isFinite(value) ? '\u2014' : String(Number(value.toFixed(digits == null ? 2 : digits)));
}

function fmtSec(sec) {
    return sec == null || !Number.isFinite(sec) ? '\u2014' : fmtNum(sec, 2) + ' s';
}

function sameCycle(a, b) {
    return Math.abs(a.cycle - b.cycle) <= 1e-6;
}

const WEAVE_TIER = {
    exact: ['Exact', 'Every number follows from the ODF (damageValue, shotDelay, salvo, ammoCost, shotSpeed x lifeSpan)'],
    estimated: ['Estimated', 'Damage values come from the ODF; the flight time of lobbed or homing rounds is estimated'],
};

function planInputs(descs) {
    return {
        weapons: descs,
        switchSec,
        // Weapon reach is muzzle to hull, so the planner runs on the gap.
        distance: hullGap(startDistance),
        closing: closingGapSpec(),
        ammo: ammoState(),
        target: {
            maxHealth: snapshot ? snapshot.targetHp : 0,
            building: !!snapshot && snapshot.targetKind === 'building',
            mdmRule: snapshot && snapshot.targetMdm != null ? snapshot.targetMdm : -1,
            radius: targetRadius,
        },
    };
}

/* `single` is the firing weapon's description when the switch is off. */
function noKillText(plan, base, single) {
    const tg = snapshot && snapshot.targetName ? snapshot.targetName : 'the target';
    if (plan.reason === 'notarget') return 'Pick a target above for a kill time.';
    if (plan.reason === 'nodamage') return (single ? single.name + ' deals' : 'These weapons deal') + ' no damage to ' + tg + '.';
    if (plan.reason === 'range') {
        return (single
            ? single.name + ' reaches ' + fmtNum(single.reach, 0) + ' m, short of ' + fmtNum(base.distance, 0) + ' m.'
            : 'Nothing ticked reaches ' + fmtNum(base.distance, 0) + ' m.') + ' Turn on Closing or move the Distance slider.';
    }
    if (plan.reason === 'ammo') return 'The tank runs dry before ' + tg + ' goes down.';
    if (plan.reason === 'capped') {
        return single
            ? 'MDM shells stay armed against ' + tg + ' until you fire again or press Detonate.'
            : 'Every MDM shell stays armed against ' + tg + ', and nothing else can fire.';
    }
    return 'No kill within ' + fmtNum(PLAN_HORIZON_MIN, 0) + ' minutes.';
}

function orderHtml(entries) {
    const order = priorityOrder(entries.map((e) => e.desc));
    const items = order.map((idx, r) => {
        const e = entries[idx];
        const d = e.desc;
        const prev = r > 0 ? entries[order[r - 1]] : null;
        const next = r < order.length - 1 ? entries[order[r + 1]] : null;
        const tiePrev = !!prev && sameCycle(prev.desc, d);
        const tieNext = !!next && sameCycle(next.desc, d);
        const role = r === 0 ? 'Leads: fires whenever it is ready'
            : (tiePrev ? 'Same cycle: right after ' + prev.desc.name : 'Fills the gaps');
        const rounds = d.salvoCount * d.barrels;
        const meta = 'every ' + fmtNum(d.cycle) + ' s · reach ' + fmtNum(d.reach, 0) + ' m · '
            + fmtNum(d.perHit) + ' per hit' + (rounds > 1 ? ' \u00d7 ' + rounds : '');
        const tie = tiePrev || tieNext;
        const move = (dir, enabled) => '<button type="button" class="btn btn-outline-secondary vt-wpn-range-weave-move" data-weave-move="' + dir + '"'
            + ' data-key="' + esc(e.slot.key) + '"' + (enabled ? '' : ' disabled')
            + ' aria-label="' + (dir === 'up' ? 'Fire ' + esc(d.name) + ' earlier' : 'Fire ' + esc(d.name) + ' later') + '">'
            + '<i class="bi bi-arrow-' + dir + '" aria-hidden="true"></i></button>';
        return '<li class="list-group-item vt-wpn-range-weave-item is-c' + e.color + '" data-weave-key="' + esc(e.slot.key) + '"'
            + (tie ? ' draggable="true" data-tie="' + d.cycle.toFixed(4) + '" title="Same cycle: drag to swap the order"' : '') + '>'
            + '<span class="vt-wpn-range-weave-swatch" aria-hidden="true"></span>'
            + '<span class="vt-wpn-range-weave-name">' + esc(d.name)
            + (d.g > 1 ? ' <span class="vt-mono vt-wpn-range-slot-mult">&times;' + d.g + '</span>' : '') + '</span>'
            + '<span class="vt-wpn-range-weave-meta vt-mono">' + esc(meta) + '</span>'
            + '<span class="vt-wpn-range-weave-role">' + esc(role) + '</span>'
            + (tie ? '<span class="btn-group btn-group-sm vt-wpn-range-weave-moves" role="group">' + move('up', tiePrev) + move('down', tieNext) + '</span>' : '')
            + '</li>';
    });
    return '<div class="vt-wpn-range-weave-section"><h3 class="vt-wpn-range-weave-title">Priority</h3>'
        + '<ol class="list-group vt-wpn-range-weave-order" data-range-weave-order>' + items.join('') + '</ol></div>';
}

function ribbonHtml(entries, plan, base) {
    const runs = [];
    const seen = new Set();
    for (let k = 0; k < plan.pulls.length; k++) {
        const p = plan.pulls[k];
        if (Number.isFinite(plan.ttk) && p.t > plan.ttk + 1e-9) break;
        const last = runs[runs.length - 1];
        if (last && last.index === p.index) {
            last.count += 1;
            continue;
        }
        runs.push({ index: p.index, count: 1, t: p.t, d: p.d, first: !seen.has(p.index) });
        seen.add(p.index);
    }
    if (!runs.length) return '';
    const chips = runs.slice(0, RIBBON_RUNS).map((run, k) => {
        const e = entries[run.index];
        const mark = base.closing && run.first && k > 0 && run.d < base.distance - 0.5
            ? '<span class="vt-wpn-range-weave-mark">' + esc(e.desc.name) + ' in range at ' + fmtNum(run.d, 0) + ' m</span>' : '';
        return mark + '<span class="vt-wpn-range-weave-run is-c' + e.color + '" title="' + esc('From ' + fmtSec(run.t) + ' at ' + fmtNum(run.d, 0) + ' m') + '">'
            + esc(e.desc.name) + (run.count > 1 ? ' <span class="vt-mono">&times;' + run.count + '</span>' : '') + '</span>';
    });
    const more = runs.length > RIBBON_RUNS ? '&hellip; ' : '';
    const end = Number.isFinite(plan.ttk)
        ? '<span class="vt-wpn-range-weave-end">' + more + 'kill at ' + esc(fmtSec(plan.ttk)) + '</span>'
        : (more ? '<span class="vt-wpn-range-weave-end">&hellip;</span>' : '');
    return '<div class="vt-wpn-range-weave-section"><h3 class="vt-wpn-range-weave-title">Switch order with Fire held</h3>'
        + '<div class="vt-wpn-range-weave-ribbon">'
        + chips.join('<i class="bi bi-chevron-right vt-wpn-range-weave-sep" aria-hidden="true"></i>') + end
        + '</div></div>';
}

/* opts.single: the firing weapon's description with the switch off;
 * opts.extra: HTML placed after the result (the switching comparison). */
function resultHtml(entries, plan, base, solos, wait, opts) {
    const single = opts && opts.single;
    const tier = entries.some((e) => e.desc.tier === 'estimated') ? 'estimated' : 'exact';
    const tierTip = WEAVE_TIER[tier][1] + (tier === 'exact' && !single ? ' and the switch time you set.' : '.');
    const head = Number.isFinite(plan.ttk)
        ? '<strong class="vt-wpn-range-weave-ttk-value vt-mono">' + esc(fmtSec(plan.ttk)) + '</strong>'
        : '<strong class="vt-wpn-range-weave-ttk-none">' + esc(noKillText(plan, base, single)) + '</strong>';
    const ammo = base.ammo.max > 0 ? ' · ' + fmtNum(plan.ammoUsed, 0) + ' ammo spent (tank ' + fmtNum(base.ammo.max, 0) + ')' : '';
    const from = 'From Fire at ' + fmtNum(base.distance, 0) + ' m'
        + (base.closing ? ', closing at ' + fmtNum(base.closing.speed, 1) + ' m/s' : ', holding distance')
        + (plan.firstShotAt > 0 ? ' · first shot at ' + fmtSec(plan.firstShotAt) : '') + ammo;
    const total = plan.weapons.reduce((n, w) => n + w.damage, 0);
    const rows = entries.map((e, i) => {
        const w = plan.weapons[i];
        const solo = solos[i];
        const share = total > 0 ? Math.round(w.damage / total * 100) + '%' : '\u2014';
        return '<li class="is-c' + e.color + '"><span class="vt-wpn-range-weave-swatch" aria-hidden="true"></span>'
            + '<span class="vt-wpn-range-weave-name">' + esc(e.desc.name) + '</span>'
            + '<span class="vt-mono" title="Damage landed before the kill">' + esc(fmtNum(w.damage, 0)) + ' (' + share + ')</span>'
            + '<span class="vt-wpn-range-weave-meta">' + w.pulls + (w.pulls === 1 ? ' pull' : ' pulls')
            + (entries.length > 1 ? ' · alone ' + (solo && Number.isFinite(solo.ttk) ? esc(fmtSec(solo.ttk)) : '\u2014') : '') + '</span></li>';
    }).join('');
    let compare = '';
    if (wait && Number.isFinite(wait.ttk) && Number.isFinite(plan.ttk) && wait.ttk > plan.ttk + 1e-6) {
        compare = '<p class="vt-wpn-range-weave-compare">Holding fire until every ticked weapon is in range: '
            + '<span class="vt-mono">' + esc(fmtSec(wait.ttk)) + '</span> (' + esc(fmtNum(wait.ttk - plan.ttk, 2)) + ' s slower).</p>';
    }
    return '<div class="vt-wpn-range-weave-section vt-wpn-range-weave-result">'
        + '<div class="vt-wpn-range-weave-ttk"><span class="vt-wpn-range-bar-label">Time to kill</span>' + head
        + '<span class="badge rounded-pill ' + (tier === 'exact' ? 'text-bg-success-muted' : 'text-bg-warning-muted')
        + ' vt-wpn-tier" data-tier="' + tier + '" title="' + esc(tierTip) + '">' + WEAVE_TIER[tier][0] + '</span></div>'
        + '<p class="vt-wpn-range-weave-from">' + esc(from) + '</p>'
        + (Number.isFinite(plan.ttk) || plan.reason === 'timeout' ? '<ul class="vt-wpn-range-weave-split">' + rows + '</ul>' : '')
        + compare
        + ((opts && opts.extra) || '')
        + '<p class="vt-wpn-range-weave-live" data-range-weave-live></p>'
        + '</div>';
}

/* `single`: the notes for one weapon with the switch off. */
function weaveNotes(entries, plan, base, single) {
    const notes = [];
    const warn = (text) => notes.push({ text, warn: true });
    const note = (text) => notes.push({ text, warn: false });
    const tg = snapshot && snapshot.targetName ? snapshot.targetName : 'the target';
    const descs = entries.map((e) => e.desc);
    const nearest = base.closing
        ? Math.max(CLOSE_STOP_M, base.distance - base.closing.speed * (Number.isFinite(plan.ttk) ? plan.ttk : Infinity))
        : base.distance;
    descs.forEach((d, i) => {
        (d.warnings || []).forEach(warn);
        if (plan.weapons[i] && plan.weapons[i].pulls === 0 && Number.isFinite(plan.ttk)) {
            if (d.reach + 1e-6 < nearest) warn(d.name + ' never fires: its reach is ' + fmtNum(d.reach, 0) + ' m and the target stays beyond it.');
            else note(d.name + ' never fires: the kill comes before its turn.');
        } else if (!single && plan.weapons[i] && plan.weapons[i].pulls === 0 && plan.reason === 'range') {
            warn(d.name + ' reaches ' + fmtNum(d.reach, 0) + ' m.');
        }
    });
    if (!single) {
        note('Each pull goes to the longest-cycle weapon that is ready and in range. A faster one fires only when its shot leaves the slower ones on time; equal cycles follow your order (drag them, or use the arrows).');
        note('A weapon change takes ' + fmtNum(switchSec) + ' s. One game turn (BZCC runs 20 turns a second) is the shortest it can be; raise it to match your own switching. Fire stays held, and a switch waits for a salvo to finish.');
    }
    const lobbed = descs.filter((d) => d.lob);
    note('Reach is shotSpeed \u00d7 lifeSpan from the ODF' + (lobbed.length ? ' (lobbed rounds use aiRange)' : '') + ': '
        + descs.map((d) => d.name + ' ' + fmtNum(d.reach, 0) + ' m').join(', ') + '. Reach is measured to the hull; the Distance slider is centre to centre.');
    if (descs.some((d) => !d.hitscan)) {
        const parts = ['travel time is distance / shotSpeed', 'beams land at once'];
        if (lobbed.length) parts.push('lobbed shells fly a ballistic arc at the range gravity of ' + fmtNum(SIM_GRAVITY, 1) + ' m/s\u00b2');
        if (descs.some((d) => d.homing)) parts.push('homing missiles count as flying straight');
        note('Damage counts when a round lands: ' + parts.join(', ') + '.');
    }
    const spread = descs.filter((d) => d.shotVariance > 0);
    if (spread.length) {
        note('Every round counts as a hit. ' + spread.map((d) => d.name + ' (shotVariance ' + fmtNum(d.shotVariance, 3) + ')').join(', ')
            + (spread.length === 1 ? ' spreads' : ' spread') + ' in the live range, so fewer rounds land at long range.');
    }
    if (base.ammo.max > 0) {
        note((single ? 'Tank: ' : 'One shared tank: ') + fmtNum(base.ammo.max, 0) + ' ammo, +' + fmtNum(base.ammo.regen) + ' per second, starting full.');
    }
    if (base.closing) {
        const ship = shipSpeed();
        const src = closeSpeed == null && ship
            ? ' (' + (snapshot.shooterName || 'the ship') + ' ' + ship.source + ', its top speed with no acceleration)' : ' (your value)';
        note('Closing at ' + fmtNum(base.closing.speed, 1) + ' m/s' + src + ' until ' + CLOSE_STOP_M + ' m while Fire is held; the target holds still. The Distance slider sets the start.'
            + (single ? ' The weapon holds fire until the target is within its reach.' : ''));
    }
    const mdm = descs.filter((d) => d.cap > 0);
    if (mdm.length) {
        const b = mdm[0].burst;
        const blast = b && b.radius > 0 ? ' (its ground explosion: ' + fmtNum(b.value, 0) + ' within ' + fmtNum(b.radius, 0) + ' m)' : '';
        note(mdm.map((d) => d.name).join(', ') + ': up to ' + mdm[0].cap + ' shells armed at once (maxCount). A shell bursts on contact with a ship or turret and bounces off buildings (allowMDMCollisionDetonation default). '
            + (single ? 'Fire again, press Detonate or change weapon to burst the rest.' : 'Changing weapon bursts every armed shell where it is' + blast + '.'));
        if (single && base.target.building) {
            warn('MDM shells bounce off ' + tg + ' and do no damage until they burst; the kill time leaves them out.');
        }
        if (!single) {
            descs.forEach((d, i) => {
                const pw = plan.weapons[i];
                if (!d.cap || !pw || !pw.bursts) return;
                warn(d.name + ': ' + pw.bursts + (pw.bursts === 1 ? ' shell bursts' : ' shells burst') + ' on a switch, '
                    + (pw.burstDealt > 0 ? 'dealing ' + fmtNum(pw.burstDealt, 0) + ' in all.' : 'and none of them hurt ' + tg + '.'));
            });
        }
    }
    const pulse = descs.filter((d) => d.pulse);
    if (pulse.length) note('Pulses from ' + pulse.map((d) => d.name).join(', ') + ' are not added (potential only).');
    descs.forEach((d) => {
        if (d.tag) {
            const after = d.tag.retag === 'salvo'
                ? 'once its missile salvo ends'
                : 'once the stuck tag drops (leader stickTime ' + fmtNum(d.tag.stickTime, 1) + ' s)';
            note(d.name + ': one pull fires only the tag; on a hit ' + d.salvoCount + ' missiles per hardpoint follow on their own timer, each paying its ammo from the shared tank. '
                + 'It tags again ' + after + ', and after a miss at shotDelay ' + fmtNum(d.shotDelay, 2) + ' s.');
            return;
        }
        if (d.calcInterval != null && Math.abs(d.cycle - d.calcInterval) > 1e-6) {
            note(d.name + ': the next pull comes ' + fmtNum(d.cycle, 3) + ' s later (shotDelay, or the salvo\'s last round); the Numbers card counts ' + fmtNum(d.calcInterval, 3) + ' s.');
        }
    });
    if (snapshot && snapshot.targetRegen > 0) warn(tg + ' repairs ' + fmtNum(snapshot.targetRegen) + ' health per second; the kill time ignores it.');
    return notes;
}

function notesHtml(notes) {
    return '<div class="d-flex flex-column gap-1 mt-2">' + notes.map((n) => '<div class="alert ' + (n.warn ? 'alert-warning' : 'alert-secondary')
        + ' py-1 px-2 mb-0 small">'
        + (n.warn ? '<i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>' : '') + esc(n.text) + '</div>').join('') + '</div>';
}

/* With the switch off, one line on how the ticked weapons would do switched. */
function switchCompareHtml(single) {
    const entries = weaveEntries();
    if (entries.length < 2) return '';
    const both = planWeave(planInputs(entries.map((e) => e.desc)));
    if (!Number.isFinite(both.ttk)) return '';
    const names = entries.map((e) => e.desc.name).join(' + ');
    let text;
    if (Number.isFinite(single.ttk) && both.ttk < single.ttk - 1e-6) {
        text = 'Weapon switch (' + names + '): ' + fmtSec(both.ttk) + ', ' + fmtNum(single.ttk - both.ttk, 2) + ' s faster. Turn on Weapon switch to try it.';
    } else if (Number.isFinite(single.ttk)) {
        text = 'Weapon switch (' + names + ') is no faster here (' + fmtSec(both.ttk) + ').';
    } else {
        text = 'Weapon switch (' + names + '): ' + fmtSec(both.ttk) + '.';
    }
    return '<p class="vt-wpn-range-weave-compare">' + esc(text) + '</p>';
}

/* The firing slot's own kill time with the switch off. */
function singleHtml() {
    const slot = slots[activeSlot];
    weavePlan = null;
    if (!slot || !slot.weapon) return '<p class="vt-wpn-range-empty">Mount a weapon with a swap button in the weapon panel in the view to time a kill.</p>';
    const desc = weaveDescs[activeSlot];
    if (!desc || desc.excluded) {
        const why = desc ? desc.excluded : 'Not in the ODF database.';
        return '<div class="vt-wpn-range-weave-section vt-wpn-range-weave-result">'
            + '<p class="vt-wpn-range-empty">' + esc('No planned kill time for ' + (desc ? desc.name : slot.weapon) + '. ' + why) + '</p>'
            + '<p class="vt-wpn-range-weave-live" data-range-weave-live></p></div>';
    }
    const entry = { slot, desc, color: activeSlot % 5 };
    const base = planInputs([desc]);
    const plan = planWeave(base);
    weavePlan = plan;
    return resultHtml([entry], plan, base, [plan], null, { single: desc, extra: switchCompareHtml(plan) })
        + notesHtml(weaveNotes([entry], plan, base, true));
}

function renderWeave() {
    const panel = rootEl && rootEl.querySelector('[data-range-weave-panel]');
    if (!panel) return;
    panel.hidden = false;
    syncWeaveControls();
    planWeavePanel(panel.querySelector('[data-range-weave-body]'));
    renderReadout();
}

function planWeavePanel(body) {
    lastWeaveKey = undefined;
    if (!weaveOn) {
        body.innerHTML = singleHtml();
        paintLive();
        return;
    }
    const entries = weaveEntries();
    if (!entries.length) {
        weavePlan = null;
        body.innerHTML = '<p class="vt-wpn-range-empty">Tick the weapons to switch between in the weapon panel in the view.</p>';
        return;
    }
    const descs = entries.map((e) => e.desc);
    const base = planInputs(descs);
    const plan = planWeave(base);
    const solos = descs.map((d) => planWeave(Object.assign({}, base, { weapons: [d] })));
    let wait = null;
    if (base.closing && descs.length > 1) {
        const all = allInRangeAt(descs, base.distance, base.closing);
        if (all > 0 && Number.isFinite(all)) wait = planWeave(Object.assign({}, base, { notBefore: all }));
    }
    weavePlan = plan;
    body.innerHTML = orderHtml(entries)
        + ribbonHtml(entries, plan, base)
        + resultHtml(entries, plan, base, solos, wait)
        + notesHtml(weaveNotes(entries, plan, base));
    paintLive();
}

function paintLive() {
    const el = rootEl && rootEl.querySelector('[data-range-weave-live]');
    if (!el) return;
    el.textContent = lastKill
        ? 'Live range: last kill ' + fmtSec(lastKill.sec) + ' after Fire from ' + fmtNum(lastKill.from, 0) + ' m (rounds spread and lobs land as simulated).'
        : 'Live range: hold Fire from a full hull to time a kill.';
}

function syncWeaveControls() {
    if (!rootEl) return;
    const toggle = rootEl.querySelector('[data-range-weave]');
    if (toggle) toggle.checked = weaveOn;
    const sw = rootEl.querySelector('[data-range-switch]');
    if (sw && document.activeElement !== sw) sw.value = String(Number(switchSec.toFixed(3)));
    const swGroup = sw && sw.closest('.input-group');
    if (swGroup) swGroup.hidden = !weaveOn;
    const cl = rootEl.querySelector('[data-range-closing]');
    const anchored = !!(snapshot && snapshot.shooterAlwaysDeployed);
    if (cl) {
        cl.checked = closing && !anchored;
        cl.disabled = anchored;
    }
    const sp = rootEl.querySelector('[data-range-speed]');
    const ship = shipSpeed();
    if (sp && document.activeElement !== sp) sp.value = String(closeSpeedNow() || '');
    if (sp) sp.disabled = !closing || anchored;
    const hint = rootEl.querySelector('[data-range-speed-hint]');
    if (hint) {
        hint.textContent = anchored
            ? (snapshot.shooterName || 'This turret') + ' fires only deployed, and a deployed turret cannot move.'
            : ship
                ? (snapshot.shooterName || 'Ship') + ' top speed ' + fmtNum(ship.speed, 1) + ' m/s (' + ship.source + ')'
                : 'No movement speed in this ship\'s ODF; type one.';
    }
}

const _corner = new THREE.Vector3();

/* How far `box` (local), placed by `matrix`, reaches from `origin` along `dir`. */
function boxExtent(box, matrix, origin, dir) {
    let best = -Infinity;
    for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
            .applyMatrix4(matrix);
        best = Math.max(best, _corner.sub(origin).dot(dir));
    }
    return Number.isFinite(best) ? Math.max(0, best) : 0;
}

function approachFlat() {
    return rangeAxis.clone();
}

/* A ship with hull-fixed guns turns its whole hull toward the target at
 * its ODF omegaTurn, and tilts its nose at the same rate when no joint can
 * raise the gun (a lock cone of 0.05 rad misses a hover target a few metres
 * up otherwise); a turret (or walker head) aims itself. */
function trackHull(dt) {
    if (!viewer || !viewer.setRangeShipAim) return;
    const turnYaw = !viewer.canAimTurret();
    const turnPitch = !viewer.canPitchAim();
    if (!turnYaw && !turnPitch) return;
    if (!target || hp <= 0) return;
    const origin = viewer.worldPointOf(null, new THREE.Vector3());
    if (!origin) return;
    const aim = targetCenter(new THREE.Vector3());
    const step = hullTurnRate * dt;
    if (turnYaw) {
        const to = aim.clone().sub(origin);
        to.y = 0;
        if (to.lengthSq() > 1e-6) {
            const a = rangeAxis;
            const want = Math.atan2(a.z * to.x - a.x * to.z, a.x * to.x + a.z * to.z);
            hullYaw += Math.max(-step, Math.min(step, want - hullYaw));
        }
    }
    if (turnPitch) {
        // Servo the firing muzzle's own forward onto the target: the sim
        // measures the lock cone from that muzzle along that direction.
        const m = muzzles()[0];
        const to = aim.sub(m.position);
        const elev = (v) => Math.atan2(v.y, Math.max(1e-3, Math.hypot(v.x, v.z)));
        const want = Math.max(HULL_PITCH_MIN, Math.min(HULL_PITCH_MAX, hullPitch + elev(to) - elev(m.forward)));
        hullPitch += Math.max(-step, Math.min(step, want - hullPitch));
    }
    viewer.setRangeShipAim(hullYaw, hullPitch);
}

/* The hull box face along the approach, or a muzzle that sits ahead of it. */
function shipFront() {
    if (!viewer) return 0;
    const flat = approachFlat();
    const origin = viewer.worldPointOf(null) || new THREE.Vector3();
    let front = viewer._radius || 0;
    if (viewer._model && viewer._hullLocalBox) {
        viewer._model.updateWorldMatrix(true, false);
        front = boxExtent(viewer._hullLocalBox, viewer._model.matrixWorld, origin, flat);
    }
    muzzles().forEach((m) => { front = Math.max(front, _v.copy(m.position).sub(origin).dot(flat)); });
    return Math.max(0, front);
}

/* The target's near face: its box turned the way placeTarget turns it,
 * measured back toward the ship. Cached per target load. */
function measureTargetNear() {
    if (!target || !targetLocalBox || !viewer) {
        targetNear = targetRadius;
        return;
    }
    const flat = approachFlat();
    const saved = { pos: target.position.clone(), quat: target.quaternion.clone() };
    target.position.set(0, targetLift, 0);
    target.lookAt(flat.x, targetLift, flat.z);
    target.updateMatrixWorld(true);
    targetNear = boxExtent(targetLocalBox, target.matrixWorld, target.position, flat.clone().negate());
    target.position.copy(saved.pos);
    target.quaternion.copy(saved.quat);
    target.updateMatrixWorld(true);
}

/* Centre-to-centre distance at which the hull boxes clear by SURFACE_MARGIN_M. */
function separationFloor() {
    const near = target ? targetNear : targetRadius;
    return Math.max(1, shipFront() + near + SURFACE_MARGIN_M);
}

/* Clear air between the nose (or muzzle) and the target's near face. */
function hullGap(centre) {
    return Math.max(0, centre - shipFront() - (target ? targetNear : targetRadius));
}

function minDistance() {
    return Math.ceil(separationFloor());
}

function applyDistanceFloor() {
    measureTargetNear();
    const floor = minDistance();
    const slider = rootEl && rootEl.querySelector('[data-range-dist]');
    if (slider) {
        slider.min = String(floor);
        slider.max = String(Math.max(OPENING_MAX_M, floor));
    }
    if (startDistance < floor) {
        startDistance = floor;
        distance = floor;
        if (slider) slider.value = String(floor);
    }
    paintDistance();
}

function paintDistance() {
    if (!hudEls.distText) return;
    hudEls.distText.textContent = Math.round(distance) + ' m (' + Math.round(hullGap(distance)) + ' m to hull)';
}

function moveInOrder(key, toKey, after) {
    const from = weaveOrder.indexOf(key);
    if (from < 0 || key === toKey) return;
    weaveOrder.splice(from, 1);
    let to = weaveOrder.indexOf(toKey);
    if (to < 0) return;
    if (after) to += 1;
    weaveOrder.splice(to, 0, key);
}

function setWeaveMode(on) {
    weaveOn = !!on;
    fight = null;
    distance = startDistance;
    paintDistance();
    applyWeapons(true);
}

function pressFire() {
    if (audio) audio.unlock();
    if (!fight && target && maxHp > 0 && hp >= maxHp - 1e-6) fight = { elapsed: 0, from: distance };
    sim.pointerDown();
}

function releaseFire() {
    sim.pointerUp();
    if (fight && hp > 0) fight = null;
}

/* ---- target ------------------------------------------------------------ */

function targetCenter(out) {
    if (target && targetLocalBox) {
        target.updateMatrixWorld(true);
        return targetLocalBox.getCenter(out).applyMatrix4(target.matrixWorld);
    }
    out.copy(target ? target.position : new THREE.Vector3());
    out.y += targetRadius * 0.6;
    return out;
}

function targetState() {
    if (!target) return null;
    const vel = moving ? Math.cos(clock * 0.7) * 9.8 : 0;
    return {
        position: targetCenter(new THREE.Vector3()),
        velocity: new THREE.Vector3(vel, 0, 0),
        radius: targetRadius,
        // Direct hits test this box (the sim falls back to the sphere without it).
        box: target && targetLocalBox ? { min: targetLocalBox.min, max: targetLocalBox.max, matrix: target.matrixWorld } : null,
        signatures: snapshot && snapshot.signatures ? snapshot.signatures : null,
        kind: targetKind === 'building' ? 'building' : 'vehicle',
        letter: targetLetter,
        mdmRule: snapshot && snapshot.targetMdm != null ? snapshot.targetMdm : -1,
        alive: hp > 0,
    };
}

/* Closing carries the ship toward a target that stays put on the ground:
 * the ship sits (startDistance - distance) ahead of its home pivot, so
 * placeTarget's origin + forward x distance is a fixed world point. */
function moveShip() {
    if (!viewer || !viewer.setRangeShipOffset) return;
    const travel = Math.max(0, startDistance - distance);
    if (Math.abs(travel - shipTravel) < 1e-6) return;
    shipTravel = travel;
    viewer.setRangeShipOffset(rangeAxis.x * travel, rangeAxis.z * travel);
}

function placeTarget() {
    if (!viewer || !target) return;
    const origin = viewer.worldPointOf(null) || new THREE.Vector3();
    target.position.set(origin.x, 0, origin.z).addScaledVector(rangeAxis, distance);
    target.position.y = targetLift;
    if (moving) target.position.x += Math.sin(clock * 0.7) * 14;
    target.lookAt(2 * target.position.x - origin.x, targetLift, 2 * target.position.z - origin.z);
    target.visible = hp > 0;
    // Sized from the start, so an approach never rebuilds the floor.
    const want = Math.ceil(Math.max(120, Math.max(distance, startDistance) * 2.6) / 40) * 40;
    if (want !== floorSize) {
        floorSize = want;
        viewer.setRangeFloor(floorSize, 60);
    }
}

function onHit(hit) {
    if (hp <= 0) return;
    hp = Math.max(0, hp - hit.damage);
    floatDamage(hit.damage, hit.position);
    if (shieldDef && targetLetter !== 'N' && target) fx.shieldPulse(shieldDef, targetCenter(new THREE.Vector3()), targetRadius * 1.25);
    if (hp <= 0) {
        deadFor = RESPAWN_SEC;
        if (fight) {
            lastKill = { sec: fight.elapsed, from: fight.from };
            fight = null;
            paintLive();
        }
        const ex = explosionEntry(db, deathXpl);
        const at = targetCenter(new THREE.Vector3());
        if (ex) {
            fx.explosionAt(ex.map, ex.headKey, at, null);
            const head = ex.map.get(ex.headKey);
            if (head && head.explsound) audio.play(stemOf(head.explsound), { loop: false, at });
        }
    }
}

/* Reset button: full ammo and hull, nothing left in flight. The ship, target,
 * equipped weapons, active slot, distance, view and cockpit stay as they are. */
function resetEngagement() {
    if (sim) sim.resetEngagement();
    clearRave();
    spaceDown = false;
    hp = maxHp;
    deadFor = 0;
    lastFloat = null;
    distance = startDistance;
    fight = null;
    lastKill = null;
    paintDistance();
    paintLive();
    if (rootEl) rootEl.querySelectorAll('.vt-wpn-range-float').forEach((el) => el.remove());
}

/* ---- cameras ----------------------------------------------------------- */

function placeCamera(dt) {
    if (!viewer) return;
    viewer.controls.enabled = false;
    viewer.setModelVisible(cameraMode !== 'fp');
    const origin = viewer.worldPointOf(null) || new THREE.Vector3();
    const hull = rangeAxis.clone();
    const side = new THREE.Vector3().crossVectors(hull, new THREE.Vector3(0, 1, 0)).normalize();
    const aimPoint = target ? targetCenter(new THREE.Vector3()) : origin.clone().addScaledVector(hull, distance);
    const shipR = Math.max(3, viewer._radius || 4);
    if (cockpit) cockpit.visible = cameraMode === 'fp' && showCockpit;

    if (cameraMode === 'orbit') {
        orbitAngle += ORBIT_RATE * dt;
        const r = shipR * 4.2;
        viewer.camera.position.set(
            origin.x + Math.cos(orbitAngle) * r,
            origin.y + r * 0.42,
            origin.z + Math.sin(orbitAngle) * r,
        );
        viewer.camera.up.set(0, 1, 0);
        viewer.camera.lookAt(origin.x, origin.y + shipR * 0.2, origin.z);
        return;
    }
    if (cameraMode === 'chase') {
        const back = Math.max(shipR * 4, 14);
        viewer.camera.position.copy(origin)
            .addScaledVector(hull, -back)
            .addScaledVector(side, back * 0.32)
            .add(new THREE.Vector3(0, back * 0.55, 0));
        viewer.camera.up.set(0, 1, 0);
        const look = origin.clone().lerp(aimPoint, 0.35);
        look.y = Math.max(look.y, origin.y);
        viewer.camera.lookAt(look);
        return;
    }
    const eye = viewer.eyepointWorld(_v) || origin.clone().add(new THREE.Vector3(0, shipR * 0.6, 0));
    viewer.camera.position.copy(eye);
    viewer.camera.up.set(0, 1, 0);
    // The turret tracks the target, so the pilot's view (and the reticle) sits
    // on it; with no target the eye looks down the hull.
    if (target && hp > 0) viewer.camera.lookAt(aimPoint);
    else viewer.camera.lookAt(eye.clone().add(hullForward(new THREE.Vector3())));
}

async function loadCockpit(shooterStem) {
    if (cockpit) {
        viewer.camera.remove(cockpit);
        cockpit = null;
    }
    const info = cockpitIndex && cockpitIndex.models && cockpitIndex.models[shooterStem];
    if (!info) return;
    try {
        const gltf = await _gltf.loadAsync(COCKPIT + info.file);
        const root = gltf.scene;
        const mats = [];
        root.traverse((o) => {
            if (!o.isMesh || !o.material) return;
            o.castShadow = false;
            o.receiveShadow = false;
            o.frustumCulled = false;
            mats.push(o.material);
        });
        await Promise.all(mats.map(async (mat) => {
            if (!mat.name) return;
            const tex = await viewer._loadTexture('perf', mat.name);
            if (tex) {
                mat.map = tex;
                mat.color = new THREE.Color(0xffffff);
                mat.needsUpdate = true;
            }
        }));
        // The cockpit mesh is authored around the pilot's eye (the ivtank
        // glass sits ~1.1 m ahead of its origin), so it parents to the camera
        // at the origin; only cockpitScale applies.
        root.scale.setScalar(info.scale || 1);
        root.visible = showCockpit && cameraMode === 'fp';
        cockpit = root;
        viewer.camera.add(cockpit);
        if (!viewer.camera.parent) viewer.scene.add(viewer.camera);
    } catch (err) {
        cockpit = null;
    }
}

/* ---- HUD --------------------------------------------------------------- */

/* Damage numbers at the projected hit point. Hits closer together than
 * FLOAT_MERGE_SEC (arc streams, pulses, machine guns) merge into one figure. */
const FLOAT_MERGE_SEC = 0.3;
let lastFloat = null;

function floatDamage(amount, position) {
    if (!rootEl || !viewer || !position) return;
    const now = performance.now() / 1000;
    if (lastFloat && lastFloat.el.isConnected && now - lastFloat.t < FLOAT_MERGE_SEC) {
        lastFloat.total += amount;
        lastFloat.el.textContent = '-' + (lastFloat.total >= 10 ? Math.round(lastFloat.total) : lastFloat.total.toFixed(1));
        return;
    }
    const stage = rootEl.querySelector('.vt-wpn-range-stage');
    const rect = stage.getBoundingClientRect();
    const p = position.clone().project(viewer.camera);
    if (p.z > 1) return;
    const el = document.createElement('span');
    el.className = 'vt-mono vt-wpn-range-float';
    el.textContent = '-' + (amount >= 10 ? Math.round(amount) : amount.toFixed(1));
    el.style.left = ((p.x + 1) / 2 * rect.width) + 'px';
    el.style.top = ((1 - (p.y + 1) / 2) * rect.height - 10) + 'px';
    stage.appendChild(el);
    lastFloat = { el, t: now, total: amount };
    window.setTimeout(() => el.remove(), 950);
}

/* One circle per lock, centred on the projected target. Radii are the
 * engine's screen pixels (128 shrinking to 16, plus 3 px per stacked
 * multi-lock). */
function paintLockCircles(state) {
    const box = hudEls.locks;
    if (!box) return;
    const markers = (state && state.markers) || [];
    const stage = rootEl.querySelector('.vt-wpn-range-stage');
    if (!markers.length || !target || !viewer || !stage) {
        box.replaceChildren();
        return;
    }
    const rect = stage.getBoundingClientRect();
    // The engine centres the ring on the target's hp_com hardpoint (005661EC),
    // and on the object's own transform when that node is absent.
    const anchor = targetCom
        ? targetCom.getWorldPosition(_v)
        : _v.copy(target.position);
    const p = anchor.project(viewer.camera);
    if (p.z > 1) {
        box.replaceChildren();
        return;
    }
    const x = (p.x + 1) / 2 * rect.width;
    const y = (1 - (p.y + 1) / 2) * rect.height;
    while (box.children.length < markers.length) {
        const el = document.createElement('div');
        el.className = 'vt-wpn-range-lock-ring';
        box.appendChild(el);
    }
    while (box.children.length > markers.length) box.lastChild.remove();
    markers.forEach((m, i) => {
        const el = box.children[i];
        const d = Math.max(2, m.radius * 2);
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.width = d + 'px';
        el.style.height = d + 'px';
        el.style.borderColor = m.color;
    });
}

function paintHud(state) {
    if (!rootEl || !state) return;
    const img = hudEls.reticle;
    if (img) {
        const file = cameraMode === 'fp'
            ? (reticleFile(state.reticleFrame) || reticleFile(state.reticle))
            : '';
        if (file !== lastReticle) {
            lastReticle = file;
            if (file) { img.hidden = false; img.src = file; } else img.hidden = true;
        }
    }
    paintReadout(state);
    paintHint(state);
    paintGauge(state);
    paintPills(state);
    if (hudEls.hpFill) {
        const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
        hudEls.hpFill.style.width = (frac * 100).toFixed(1) + '%';
        hudEls.hpFill.classList.toggle('is-low', frac < 0.3);
        hudEls.hpText.textContent = target
            ? (hp > 0 ? Math.ceil(hp) + ' / ' + Math.round(maxHp) : 'Destroyed — respawning')
            : 'No target';
        hudEls.hpName.textContent = targetName || 'Target';
    }
    if (hudEls.detonate) {
        const show = hasDetonator || state.armed > 0;
        if (hudEls.detonate.hidden === show) hudEls.detonate.hidden = !show;
        hudEls.detonate.disabled = !(state.armed > 0);
    }
    const firing = state.weave ? state.weave.current : null;
    if (firing !== lastWeaveKey) {
        lastWeaveKey = firing;
        rootEl.querySelectorAll('[data-slot-key], [data-weave-key]').forEach((el) => {
            el.classList.toggle('is-firing', !!firing && (el.dataset.slotKey === firing || el.dataset.weaveKey === firing));
        });
    }
    paintLockCircles(state);
    if (hudEls.lock) {
        const show = (state.archetype === 'launcher' || state.archetype === 'multilock') && state.active;
        if (hudEls.lock.hidden === show) hudEls.lock.hidden = !show;
        if (show && hudEls.lockFill) {
            const multi = state.archetype === 'multilock';
            const frac = Math.max(0, Math.min(1, multi
                ? (state.locks + Math.min(1, state.lock)) / Math.max(1, state.lockCount || 1)
                : Math.min(1, state.lock)));
            const locked = multi ? state.locks > 0 : state.lock >= 1;
            hudEls.lockFill.style.width = (frac * 100).toFixed(0) + '%';
            hudEls.lockFill.classList.toggle('is-locked', locked);
            const text = multi
                ? state.locks + ' / ' + Math.max(1, state.lockCount || 1)
                : (locked ? 'Locked' : Math.round(frac * 100) + '%');
            if (hudEls.lockText && text !== hudText.lock) {
                hudText.lock = text;
                hudEls.lockText.textContent = text;
            }
        }
    }
}

/* ---- load / sync ------------------------------------------------------- */

async function loadModels(snap) {
    const shooterUrl = snap.shooterThumb ? GEOM + snap.shooterThumb + '.glb' : '';
    if (shooterUrl) {
        const entry = await modelEntry(snap.shooterThumb);
        const drive = (entry && entry.drive) || null;
        // Joints come only from the index's parts block, as on /models: an
        // undeclared turret_y (the ISDF Tank's) stays fixed to the hull.
        const hints = (entry && entry.parts) || NO_PARTS;
        await viewer.load(shooterUrl, hints, { hoverAltitude: hoverAltitude(entry, snap.shooterAlwaysDeployed) });
        // A turret fires only deployed; a deployed morph tank wears its
        // deployed shape. Both hold the deploy clip's last frame.
        if (snap.shooterDeployed) viewer.setDeployPose(true);
        shipTravel = 0;
        hullYaw = 0;
        hullPitch = 0;
        hullTurnRate = drive && drive.omegaTurn > 0 ? drive.omegaTurn : HULL_TURN_FALLBACK;
        hullForward(rangeAxis);
        rangeAxis.y = 0;
        if (rangeAxis.lengthSq() < 1e-6) rangeAxis.set(0, 0, -1);
        rangeAxis.normalize();
    }
    await loadTarget(snap);
    await loadCockpit(snap.shooterThumb);
    orbitAngle = Math.PI * 0.75;
}

async function modelEntry(stem) {
    const byStem = modelsByStem ? await modelsByStem : null;
    return (stem && byStem && byStem.get(stem)) || null;
}

/* A hover craft floats at its ODF setAltitude; a turret fires only deployed,
 * at its heightDeploy, which is at or below the ground. */
function hoverAltitude(entry, anchored) {
    const drive = entry && entry.drive;
    if (anchored || !drive || (drive.archetype !== 'hover' && drive.archetype !== 'morph')) return 0;
    return Math.max(0, Number(drive.setAltitude) || 0);
}

function findHpCom(root) {
    let found = null;
    root.traverse((o) => {
        if (!found && o.name && o.name.toLowerCase() === 'hp_com') found = o;
    });
    return found;
}

async function loadTarget(snap) {
    viewer.clearProp();
    target = null;
    targetCom = null;
    const url = snap.targetThumb ? GEOM + snap.targetThumb + '.glb' : '';
    if (url) {
        target = await viewer.loadProp(url);
        if (target) {
            // Measure the box in the prop's own frame (identity transform),
            // centre offset included: the .msh header bakes this box around
            // the visible geometry.
            target.position.set(0, 0, 0);
            target.quaternion.identity();
            target.updateMatrixWorld(true);
            targetLocalBox = new THREE.Box3().setFromObject(target);
            const size = new THREE.Vector3();
            targetLocalBox.getSize(size);
            // The sphere remains for splash, the shield bubble and the fallback hit.
            targetRadius = Math.max(1, size.length() * 0.5);
            targetLift = -targetLocalBox.min.y
                + hoverAltitude(await modelEntry(snap.targetThumb), snap.targetAlwaysDeployed);
            targetCom = findHpCom(target);
        }
    }
    if (!target) targetLocalBox = null;
    targetKind = snap.targetKind || 'ship';
    targetName = snap.targetName || '';
    maxHp = snap.targetHp > 0 ? snap.targetHp : 0;
    hpRegen = snap.targetRegen || 0;
    hp = maxHp;
    deadFor = 0;
    deathXpl = snap.targetDeathXpl || '';
    if (deathXpl) fx.preload(profileAssets(null, db, [deathXpl]));
    floorSize = 0;
}

export async function mount(container, shared) {
    rootEl = container;
    rootEl.innerHTML = ''
        + '<div class="vt-wpn-range-stage">'
        + '<div class="vt-wpn-range-view" data-range-view></div>'
        + '<div class="vt-wpn-range-rave" data-range-rave hidden aria-hidden="true"></div>'
        + '<div class="vt-wpn-range-hud vt-xp-hud">'
        + '<div class="vt-wpn-range-loading" data-range-loading hidden aria-live="polite">'
        + '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>'
        + 'Loading visuals</div>'
        + '<img data-range-reticle alt="" class="vt-wpn-range-reticle" hidden>'
        + '<div data-range-locks class="vt-wpn-range-locks"></div>'
        + '<div class="vt-mono vt-wpn-range-readout" data-range-readout>'
        + '<div class="vt-wpn-range-ro-head" data-range-ro-head></div>'
        + '<div data-range-ro-body></div></div>'
        + '<div class="card vt-wpn-range-card vt-wpn-range-card-target"><div class="card-body">'
        + '<div class="vt-wpn-range-target-name" data-range-hp-name></div>'
        + '<div class="vt-wpn-range-bar-row"><span class="vt-wpn-range-bar-label">Hull</span>'
        + '<div class="progress vt-wpn-range-meter" role="progressbar" aria-label="Target hull">'
        + '<div class="progress-bar vt-wpn-range-meter-fill is-hp" data-range-hp-fill></div></div>'
        + '<span class="vt-mono" data-range-hp-text></span></div>'
        + '<div class="vt-wpn-range-bar-row vt-wpn-range-lock-row" data-range-lock hidden>'
        + '<span class="vt-wpn-range-bar-label">Lock</span>'
        + '<div class="progress vt-wpn-range-meter" role="progressbar" aria-label="Lock">'
        + '<div class="progress-bar vt-wpn-range-lock-fill"></div></div>'
        + '<span class="vt-mono vt-wpn-range-lock-text" data-range-lock-text></span></div>'
        + '</div></div>'
        + '<div class="vt-wpn-range-status">'
        + '<p class="vt-wpn-range-hint" data-range-hint hidden></p>'
        + '<div class="vt-wpn-range-status-row" data-range-status-row>'
        + '<div class="vt-xp-weapons vt-wpn-range-pills" data-range-pills></div>'
        + '</div></div>'
        + '</div></div>'
        + '<div class="vt-wpn-range-bar">'
        + '<button type="button" class="btn btn-primary btn-sm" data-range-fire><i class="bi bi-crosshair me-1"></i>Fire</button>'
        + '<div class="form-check form-switch mb-0" title="Share the trigger between the ticked weapons, slowest cooldown first">'
        + '<input class="form-check-input" type="checkbox" role="switch" id="vt-range-weave" data-range-weave>'
        + '<label class="form-check-label" for="vt-range-weave">Weapon switch</label></div>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-detonate hidden disabled title="Burst every armed MDM shell where it is">'
        + '<i class="bi bi-lightning-charge me-1"></i>Detonate</button>'
        + '<label class="vt-wpn-range-label">Distance <input type="range" class="form-range vt-wpn-range-slider" min="20" max="400" value="80" data-range-dist>'
        + '<span class="vt-mono" data-range-dist-text>80 m</span></label>'
        + '<div class="form-check form-switch mb-0">'
        + '<input class="form-check-input" type="checkbox" role="switch" id="vt-range-move" data-range-move>'
        + '<label class="form-check-label" for="vt-range-move">Moving target</label></div>'
        + '<label class="vt-wpn-range-label">View '
        + '<select data-range-cam class="form-select form-select-sm">'
        + '<option value="chase" selected>Chase</option><option value="orbit">Orbit</option><option value="fp">First person</option>'
        + '</select></label>'
        + '<div class="form-check form-switch mb-0" data-range-cockpit-label>'
        + '<input class="form-check-input" type="checkbox" role="switch" id="vt-range-cockpit" data-range-cockpit>'
        + '<label class="form-check-label" for="vt-range-cockpit">Cockpit</label></div>'
        + '<div class="dropdown vt-wpn-range-volume">'
        + '<button type="button" class="btn btn-outline-secondary btn-sm dropdown-toggle" data-bs-toggle="dropdown" data-bs-auto-close="outside"'
        + ' aria-expanded="false" title="Sound volume">'
        + '<i class="bi bi-volume-up" data-range-volume-icon aria-hidden="true"></i>'
        + '<span class="visually-hidden">Sound volume</span>'
        + '<span class="vt-mono" data-range-volume-text>100%</span></button>'
        + '<div class="dropdown-menu vt-wpn-range-volume-menu">'
        + '<label class="vt-wpn-range-volume-row" for="vt-range-vol-master"><span>Master</span>'
        + '<span class="vt-mono" data-range-volume-out="master">100%</span></label>'
        + '<input type="range" class="form-range" id="vt-range-vol-master" min="0" max="100" step="1" value="100" data-range-volume="master">'
        + '<label class="vt-wpn-range-volume-row" for="vt-range-vol-lock"><span>Lock-on tones</span>'
        + '<span class="vt-mono" data-range-volume-out="lock">50%</span></label>'
        + '<input type="range" class="form-range" id="vt-range-vol-lock" min="0" max="100" step="1" value="50" data-range-volume="lock">'
        + '<p class="vt-wpn-range-volume-note">Lock tones play at master &times; this level.</p>'
        + '</div></div>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-refill>Refill ammo</button>'
        + '<button type="button" class="btn btn-outline-secondary btn-sm" data-range-reset title="Full ammo and hull, clear everything in flight; ships and weapons stay">'
        + '<i class="bi bi-arrow-counterclockwise me-1"></i>Reset</button>'
        + '</div>'
        + '<section class="card vt-wpn-range-weave" data-range-weave-panel hidden aria-label="Time to kill"><div class="card-body">'
        + '<div class="vt-wpn-range-weave-controls">'
        + '<div class="input-group input-group-sm vt-wpn-range-group">'
        + '<span class="input-group-text">Switch time</span>'
        + '<input type="number" class="form-control vt-wpn-range-num" aria-label="Switch time in seconds"'
        + ' min="' + TURN_SEC + '" max="' + SWITCH_MAX_SEC + '" step="0.05" value="' + TURN_SEC + '" data-range-switch>'
        + '<span class="input-group-text">s</span></div>'
        + '<div class="form-check form-switch mb-0">'
        + '<input class="form-check-input" type="checkbox" role="switch" id="vt-range-closing" data-range-closing>'
        + '<label class="form-check-label" for="vt-range-closing">Closing</label></div>'
        + '<div class="input-group input-group-sm vt-wpn-range-group">'
        + '<span class="input-group-text">at</span>'
        + '<input type="number" class="form-control vt-wpn-range-num" aria-label="Closing speed in metres per second"'
        + ' min="0.5" max="200" step="0.5" data-range-speed disabled>'
        + '<span class="input-group-text">m/s</span></div>'
        + '<span class="vt-wpn-range-weave-hint" data-range-speed-hint></span>'
        + '</div>'
        + '<div data-range-weave-body></div>'
        + '</div></section>'
        + '<p class="vt-wpn-range-note">Hold Fire or Space. Keys 1–5, or a click on a pill in the weapon panel in the view, pick the firing slot; '
        + 'its <i class="bi bi-arrow-left-right" aria-hidden="true"></i><span class="visually-hidden">swap</span> button changes that hardpoint group\'s weapon. Same-type hardpoints share a slot and fire together. Lock-on weapons lock while held and fire on release. '
        + 'Weapon switch shares one held trigger between the ticked slots: the slowest cooldown fires whenever it is ready and the faster weapons fill the time between. '
        + 'Renders, sounds and impact effects are the weapon\'s own ODF effect definitions; damage per hit is the ODF value for this target\'s class.</p>';

    const [odf, fxIdx, ret, pits] = await Promise.all([
        (shared && shared.db) ? Promise.resolve(shared.db) : fetch('../data/odf.min.json').then((r) => r.json()),
        fetch('../data/fx/index.json').then((r) => r.json()).catch(() => null),
        fetch(RETICLE + 'index.json').then((r) => r.json()).catch(() => null),
        fetch(COCKPIT + 'index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    modelsByStem = modelsByStem || fetch(MODELS_INDEX)
        .then((r) => (r.ok ? r.json() : null))
        .then((idx) => new Map(((idx && idx.models) || []).map((m) => [m.stem, m])))
        .catch(() => null);
    db = odf;
    fxIndex = mergeFxIndex(fxIdx, shared && shared.fxIndexes);
    reticleIndex = ret;
    cockpitIndex = pits;
    onPickSlot = (shared && shared.onPickSlot) || null;

    hudEls = {
        reticle: rootEl.querySelector('[data-range-reticle]'),
        locks: rootEl.querySelector('[data-range-locks]'),
        roHead: rootEl.querySelector('[data-range-ro-head]'),
        readoutBody: rootEl.querySelector('[data-range-ro-body]'),
        roGap: null,
        roKill: null,
        hint: rootEl.querySelector('[data-range-hint]'),
        pills: rootEl.querySelector('[data-range-pills]'),
        hpFill: rootEl.querySelector('[data-range-hp-fill]'),
        hpText: rootEl.querySelector('[data-range-hp-text]'),
        hpName: rootEl.querySelector('[data-range-hp-name]'),
        lock: rootEl.querySelector('[data-range-lock]'),
        lockFill: rootEl.querySelector('[data-range-lock] .vt-wpn-range-lock-fill'),
        lockText: rootEl.querySelector('[data-range-lock-text]'),
        distText: rootEl.querySelector('[data-range-dist-text]'),
        detonate: rootEl.querySelector('[data-range-detonate]'),
    };
    hudText = {};
    gauge = createStatusGauge();
    rootEl.querySelector('[data-range-status-row]').prepend(gauge.el);
    applyGamePalette(rootEl.querySelector('.vt-wpn-range-hud'));

    raveEl = rootEl.querySelector('[data-range-rave]');
    const view = rootEl.querySelector('[data-range-view]');
    viewer = new ObjectViewer(view, { quality: 'perf' });
    viewer.controls.enabled = false;
    viewer.setAxesVisible(false);
    fx = createFxRuntime(viewer.scene, Object.assign(assetMaps(), {
        loadModelTexture: (name) => viewer._loadTexture('perf', name),
        getCamera: () => viewer.camera,
    }));
    audio = createAudio({ urls: contribSoundUrls() });
    sim = createRangeSim({
        fx, audio,
        getMuzzles: muzzles,
        getTarget: targetState,
        getDistance: () => hullGap(distance),
        getShipPosition: () => viewer.worldPointOf(null, new THREE.Vector3()),
        onRecoil: () => { if (viewer.fireRecoil) viewer.fireRecoil(); },
        onHit,
        onRaveFlash,
    });
    viewer.setExternalTick((dt) => {
        if (!loop) return;
        viewer.resize();
        clock += dt;
        if (hp <= 0 && target) {
            deadFor -= dt;
            if (deadFor <= 0) {
                hp = maxHp;
                // A new approach for the next kill.
                if (closing) {
                    distance = startDistance;
                    paintDistance();
                }
            }
        } else if (hp > 0 && hpRegen > 0) hp = Math.min(maxHp, hp + hpRegen * dt);
        // Simulated seconds: the sim caps every step at 0.05 s, so a slow frame
        // rate runs the range (and this clock) in slow motion, not skipping.
        const step = Math.min(0.05, dt);
        if (fight) fight.elapsed += step;
        const cs = closingSpec();
        if (cs && sim.holding && hp > 0 && distance > cs.stop) {
            distance = Math.max(cs.stop, distance - cs.speed * step);
            paintDistance();
        }
        moveShip();
        placeTarget();
        trackHull(step);
        if (target && hp > 0) viewer.aimAtWorldPoint(targetCenter(new THREE.Vector3()));
        placeCamera(dt);
        audio.setListener(viewer.camera);
        const state = sim.update(dt);
        fx.update(dt);
        paintRave(dt);
        paintHud(state);
    });

    const fire = rootEl.querySelector('[data-range-fire]');
    fire.addEventListener('pointerdown', (e) => { e.preventDefault(); pressFire(); });
    fire.addEventListener('pointerup', releaseFire);
    fire.addEventListener('pointerleave', releaseFire);
    fire.addEventListener('pointercancel', releaseFire);
    rootEl.querySelector('[data-range-weave]').addEventListener('change', (e) => setWeaveMode(e.target.checked));
    rootEl.querySelector('[data-range-detonate]').addEventListener('click', () => { audio.unlock(); sim.detonate(); });
    rootEl.querySelector('[data-range-switch]').addEventListener('change', (e) => {
        const v = Number(e.target.value);
        switchSec = Number.isFinite(v) ? Math.min(SWITCH_MAX_SEC, Math.max(TURN_SEC, Math.round(v * 1000) / 1000)) : TURN_SEC;
        e.target.value = String(switchSec);
        applyWeapons(true);
    });
    rootEl.querySelector('[data-range-closing]').addEventListener('change', (e) => {
        closing = e.target.checked;
        distance = startDistance;
        paintDistance();
        applyWeapons(true);
    });
    rootEl.querySelector('[data-range-speed]').addEventListener('change', (e) => {
        const raw = String(e.target.value).trim();
        const v = Number(raw);
        closeSpeed = raw && Number.isFinite(v) && v > 0 ? Math.min(200, v) : null;
        applyWeapons(true);
    });
    const weavePanel = rootEl.querySelector('[data-range-weave-panel]');
    weavePanel.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-weave-move]');
        if (!btn || btn.disabled) return;
        const key = btn.dataset.key;
        const li = btn.closest('li[data-weave-key]');
        const sib = btn.dataset.weaveMove === 'up' ? li && li.previousElementSibling : li && li.nextElementSibling;
        if (!sib || sib.dataset.tie !== li.dataset.tie) return;
        moveInOrder(key, sib.dataset.weaveKey, btn.dataset.weaveMove === 'down');
        applyWeapons(true);
    });
    weavePanel.addEventListener('dragstart', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        if (!li) return;
        dragKey = li.dataset.weaveKey;
        li.classList.add('is-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragKey);
        }
    });
    weavePanel.addEventListener('dragover', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        const from = dragKey && weavePanel.querySelector('li[data-weave-key="' + dragKey + '"]');
        if (!li || !from || li === from || li.dataset.tie !== from.dataset.tie) return;
        e.preventDefault();
        weavePanel.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
        li.classList.add('is-drop');
    });
    weavePanel.addEventListener('drop', (e) => {
        const li = e.target.closest('li[data-weave-key][data-tie]');
        const from = dragKey && weavePanel.querySelector('li[data-weave-key="' + dragKey + '"]');
        if (!li || !from || li === from || li.dataset.tie !== from.dataset.tie) return;
        e.preventDefault();
        const box = li.getBoundingClientRect();
        moveInOrder(dragKey, li.dataset.weaveKey, e.clientY > box.top + box.height / 2);
        dragKey = null;
        applyWeapons(true);
    });
    weavePanel.addEventListener('dragend', () => {
        dragKey = null;
        weavePanel.querySelectorAll('.is-dragging, .is-drop').forEach((el) => el.classList.remove('is-dragging', 'is-drop'));
    });
    rootEl.querySelector('[data-range-refill]').addEventListener('click', () => { audio.unlock(); sim.refillAmmo(); });
    rootEl.querySelector('[data-range-reset]').addEventListener('click', () => {
        audio.unlock();
        resetEngagement();
    });
    rootEl.querySelectorAll('[data-range-volume]').forEach((input) => {
        const channel = input.dataset.rangeVolume;
        const start = loadVolume(channel);
        input.value = String(start);
        applyVolume(channel, start);
        input.addEventListener('input', (e) => {
            const pct = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0)));
            applyVolume(channel, pct);
            saveVolume(channel, pct);
        });
    });
    const dist = rootEl.querySelector('[data-range-dist]');
    dist.addEventListener('input', (e) => {
        startDistance = Number(e.target.value) || 80;
        distance = startDistance;
        paintDistance();
    });
    // The time to kill replans once the slider settles.
    dist.addEventListener('change', () => renderWeave());
    rootEl.querySelector('[data-range-move]').addEventListener('change', (e) => { moving = e.target.checked; });
    rootEl.querySelector('[data-range-cam]').addEventListener('change', (e) => {
        cameraMode = e.target.value;
        lastReticle = null;
    });
    rootEl.querySelector('[data-range-cockpit]').addEventListener('change', (e) => { showCockpit = e.target.checked; });
    const pillsBox = hudEls.pills;
    // A slot's weapon is chosen in the page's weapon drawer, which writes
    // the loadout and syncs back.
    pillsBox.addEventListener('click', (e) => {
        const open = e.target.closest('[data-range-slot-open]');
        if (!open) return;
        e.preventDefault();
        const slot = slots[Number(open.dataset.rangeSlotOpen)];
        if (slot && onPickSlot) onPickSlot(slot.key);
    });
    pillsBox.addEventListener('change', (e) => {
        const pick = e.target.closest('input[data-range-weave-slot]');
        if (pick) {
            const slot = slots[Number(pick.dataset.rangeWeaveSlot)];
            if (slot) weavePicks.set(slot.key, pick.checked);
            applyWeapons(true);
            return;
        }
        const radio = e.target.closest('input[name="vt-range-slot"]');
        if (radio) {
            activeSlot = Number(radio.value);
            applyWeapons(true);
        }
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);

    const credits = (fxIndex && fxIndex.credits) || [];
    const note = rootEl.querySelector('.vt-wpn-range-note');
    if (credits.length && note) {
        note.insertAdjacentHTML('beforeend', ' Effect art also from '
            + credits.map((c) => '<a href="' + esc(c.url) + '">' + esc(c.name) + '</a>').join(', ') + '.');
    }
    const people = (shared && shared.contributors) || [];
    if (people.length && note) {
        note.insertAdjacentHTML('beforeend', ' Community weapons by '
            + people.map((p) => (p.url
                ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>'
                : esc(p.name))).join(', ') + '.');
    }
    window.VTWeaponsRange = {
        sync, destroy,
        _debug: () => ({
            viewer, fx, sim, audio, target, cockpit, slots, activeSlot, hp, maxHp,
            weave: { on: weaveOn, descs: weaveDescs, entries: weaveEntries(), plan: weavePlan, distance, startDistance, switchSec, closing, lastKill },
        }),
    };
}

let spaceDown = false;
function onKey(e) {
    if (!sim || !rootEl || rootEl.closest('.tab-pane') && !rootEl.closest('.tab-pane').classList.contains('active')) return;
    // A picker drawer is open: its search box and list own the keyboard.
    if (document.querySelector('.offcanvas.show, .offcanvas.showing')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') {
        if (spaceDown) return;
        spaceDown = true;
        e.preventDefault();
        pressFire();
        return;
    }
    // The weapon switch picks the slot for every pull.
    if (weaveOn) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 5 && slots[n - 1] && slots[n - 1].weapon && n - 1 !== activeSlot) {
        activeSlot = n - 1;
        applyWeapons(true);
    }
}
function onKeyUp(e) {
    if (e.code !== 'Space' || !sim) return;
    spaceDown = false;
    releaseFire();
}

let syncChain = Promise.resolve();
let warmEpoch = 0;
let warmJobs = 0;
const warmedKeys = new Set();
const warmingKeys = new Set();

function paintLoadingChip() {
    const el = rootEl && rootEl.querySelector('[data-range-loading]');
    if (el) el.hidden = warmJobs <= 0;
}

/* A newer sync drops in-flight jobs from the previous one so the chip
 * cannot stay up after the viewer has moved on. */
function startWarmEpoch() {
    warmEpoch += 1;
    warmJobs = 0;
    warmingKeys.clear();
    paintLoadingChip();
    return warmEpoch;
}

function retainWarm(epoch) {
    if (epoch !== warmEpoch) return () => {};
    warmJobs += 1;
    paintLoadingChip();
    let closed = false;
    return () => {
        if (closed || epoch !== warmEpoch) return;
        closed = true;
        warmJobs -= 1;
        paintLoadingChip();
    };
}

/* File fetch, then GPU upload and program compile. Sounds are fetched here
 * and decoded on the next unlock. `key` skips a list this page already warmed. */
function scheduleWarm(list, epoch, key) {
    if (!list || epoch !== warmEpoch || !fx || !viewer) return;
    if (key && warmedKeys.has(key)) return;
    const token = key ? key + '@' + epoch : '';
    if (token && warmingKeys.has(token)) return;
    if (token) warmingKeys.add(token);
    const release = retainWarm(epoch);
    const fxJob = fx.preload(list).then(() => {
        if (epoch !== warmEpoch || !viewer) return false;
        return fx.warm(viewer.renderer, viewer.camera).then(() => true);
    });
    const sndJob = audio ? audio.preload(list.sounds) : Promise.resolve();
    let ok = false;
    Promise.all([fxJob, sndJob]).then((results) => { ok = results[0] === true; }).catch(() => { ok = false; }).finally(() => {
        if (token) warmingKeys.delete(token);
        if (ok && epoch === warmEpoch && key) warmedKeys.add(key);
        release();
    });
}

function warmOtherSlots(epoch, activeStem) {
    const seen = new Set();
    if (activeStem) seen.add(activeStem);
    slots.forEach((s) => {
        if (!s.weapon || seen.has(s.weapon)) return;
        seen.add(s.weapon);
        const entry = db && db.Weapon && db.Weapon[s.weapon + '.odf'];
        if (!entry) return;
        scheduleWarm(profileAssets(entry, db), epoch, 'wpn:' + s.weapon);
    });
}

/* Scenario changes arrive from several callers; run them one at a time so
 * two model loads never race each other. */
export function sync(snap) {
    syncChain = syncChain.then(() => doSync(snap)).catch((err) => console.error('Shooting range sync failed:', err));
    return syncChain;
}

async function doSync(snap) {
    if (!viewer || !snap || !db) return;
    const epoch = startWarmEpoch();
    const releaseSync = retainWarm(epoch);
    try {
        snapshot = snap;
        const nextShooter = [snap.shooterStem, snap.shooterThumb, snap.shooterDeployed ? 'deployed' : '',
            (snap.hardpoints || []).map((h) => h.node + ':' + h.mounted).join(',')].join('|');
        const shooterChanged = nextShooter !== shooterKey;
        const targetChanged = (!target && !!snap.targetThumb) || (snap.targetThumb || null) !== doSync.targetThumb
            || (snap.targetStem || null) !== doSync.targetStem;
        const scenarioChanged = (snap.weaponStem || null) !== doSync.weaponStem;
        const nextLoadout = Object.keys(snap.loadout || {}).sort()
            .map((k) => k + '=' + (snap.loadout[k] || '-')).join(',');
        const loadoutChanged = nextLoadout !== doSync.loadoutKey;
        doSync.targetThumb = snap.targetThumb || null;
        doSync.targetStem = snap.targetStem || null;
        doSync.weaponStem = snap.weaponStem || null;
        doSync.loadoutKey = nextLoadout;
        targetLetter = snap.letter || 'N';
        shieldDef = shieldEffectFor(db, targetLetter);
        if (shieldDef && shieldDef.texture) fx.preload({ textures: [shieldDef.texture] });

        // A weapon swap keeps rounds in flight; a new ship or target does not.
        if ((shooterChanged || targetChanged) && sim) sim.resetEngagement();
        if (shooterChanged) {
            shooterKey = nextShooter;
            // Slot keys belong to the old ship.
            weavePicks.clear();
            weaveOrder = [];
            closeSpeed = null;
            // A new ship (or a deploy) starts a new approach from home.
            distance = startDistance;
            fight = null;
            lastKill = null;
            paintDistance();
            buildSlots(snap, false);
            await loadModels(snap);
        } else {
            // A new Scenario weapon takes the trigger; a change to some other
            // group leaves the firing slot where the user put it.
            if (scenarioChanged || loadoutChanged) buildSlots(snap, !scenarioChanged);
            if (targetChanged) await loadTarget(snap);
            else {
                maxHp = snap.targetHp > 0 ? snap.targetHp : maxHp;
                hpRegen = snap.targetRegen || 0;
                if (hp > maxHp) hp = maxHp;
            }
        }
        if (epoch !== warmEpoch || !viewer) return;
        if (shooterChanged || targetChanged) {
            try { await viewer.warmGpu(); } catch (err) { console.error('Shooting range GPU warm failed:', err); }
        }
        if (epoch !== warmEpoch || !viewer) return;
        if (shooterChanged || targetChanged) applyDistanceFloor();
        if (shooterChanged || targetChanged || scenarioChanged) {
            // The opening distance follows the live profile's engagement reach
            // and the hull floor for this pair of models.
            const profile = profileFor(snap.weaponStem || activeWeapon());
            const opened = openingCentre(profile ? engagementReach(profile, SIM_GRAVITY) : null, minDistance());
            if (opened != null && opened > 5) {
                startDistance = opened;
                distance = startDistance;
                const slider = rootEl.querySelector('[data-range-dist]');
                if (slider) slider.value = String(Math.round(startDistance));
                paintDistance();
            }
        }
        const cockpitLabel = rootEl.querySelector('[data-range-cockpit-label]');
        if (cockpitLabel) cockpitLabel.hidden = !(cockpitIndex && cockpitIndex.models && cockpitIndex.models[snap.shooterThumb]);
        if (deathXpl) scheduleWarm(profileAssets(null, db, [deathXpl]), epoch, 'death:' + deathXpl);
        if (shieldDef && shieldDef.texture) scheduleWarm({ textures: [shieldDef.texture] }, epoch, 'shield:' + shieldDef.texture);
        applyWeapons(!shooterChanged);
    } finally {
        releaseSync();
    }
}

export function destroy() {
    loop = false;
    onPickSlot = null;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    clearRave();
    raveEl = null;
    raveColors = [];
    if (sim) sim.dispose();
    if (fx) fx.dispose();
    if (viewer) viewer.dispose();
    viewer = null;
    window.VTWeaponsRange = null;
}
