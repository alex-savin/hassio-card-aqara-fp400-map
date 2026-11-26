/**
 * fp400-map-card — a Lovelace card that draws one Aqara FP400 presence sensor (Zigbee2MQTT) on a room map:
 * the room, the sensor's monitored area, its entry/exit and interference cells, its native zones, and the
 * people it tracks.
 *
 * Data sources
 * - Admin users: the card listens to the device's Zigbee2MQTT topic through Home Assistant's websocket
 *   (`mqtt/subscribe`, admin-only in Home Assistant). Every message is the device's full state, so the card
 *   gets every target (id, x, y, zone), the masks and the zones. Positions reach the browser only: they are
 *   never Home Assistant states, so they never reach the recorder.
 * - Everyone else (or when `topic` is not set, or the subscription fails): the reduced view, read from the
 *   device's Home Assistant entities: `targets` (or `targets_xy` from older converters), the three mask text
 *   entities, presence, counts and zone occupancy. Zone outlines are not available there.
 *
 * Frame: the sensor's own, in cm — x across (column 0 of the grid is x = +350..+400), y = distance out from the
 * sensor. `room.outline_mm` / `room.features` are in the same frame, in mm.
 * `mirror` flips x and `rotation` (degrees, clockwise) turns the whole map; labels stay upright. Both are the card's own
 * settings, not the device's. Wheel or pinch zooms, dragging pans.
 *
 * Admins in the live view also get: the area and zone editor (native zones, software zones, the three areas), a popover
 * on each dot (forget the target, ignore the spot), and a settings panel for the device's options.
 *
 * This file shares no code or state with any other card.
 */

export const VERSION = "0.6.0";
const TAG = "fp400-map-card";

/** The sensor holds up to 8 zones, each carried by one of endpoints 3-10 (`zone_id_N` tells which). */
export const MAX_ZONES = 8;
export const ZONE_ENDPOINTS = [3, 4, 5, 6, 7, 8, 9, 10];

/* ── The sensor's grid ─────────────────────────────────────────────────────────────────────────────────────
 * 20 rows of 16 cells, 50 cm square. Row 0 is nearest the sensor; column 0 is x = +350..+400 cm, so x = 0 falls
 * between columns 7 and 8. One bit per cell, bit = row * 16 + column, most significant bit of each byte first
 * (the layout the zigbee-herdsman-converters FP400 code publishes as *_mask_hex). */
export const ROWS = 20;
export const COLS = 16;
export const CELL = 50;
export const CELLS = ROWS * COLS;
const MASK_HEX_LENGTH = (CELLS / 8) * 2;

/** Cell bits (1 = set) from an 80-character mask, or null when the value is not a mask. */
export function maskBits(hex) {
    if (typeof hex !== "string") return null;
    const s = hex.trim().toLowerCase();
    if (s.length !== MASK_HEX_LENGTH || !/^[0-9a-f]+$/.test(s)) return null;
    const bits = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
        const byte = Number.parseInt(s.substr((i >> 3) * 2, 2), 16);
        bits[i] = (byte >> (7 - (i & 7))) & 1;
    }
    return bits;
}

/** The cell's rectangle in the sensor frame (cm). */
export function cellBox(index) {
    const r = Math.floor(index / COLS);
    const c = index % COLS;
    const x1 = 400 - CELL * c;
    return {r, c, x0: x1 - CELL, x1, y0: r * CELL, y1: (r + 1) * CELL};
}

/** Horizontal runs of set cells, one rectangle per run (fewer shapes than one per cell). */
export function cellRuns(bits) {
    const runs = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!bits[r * COLS + c]) continue;
            let e = c;
            while (e + 1 < COLS && bits[r * COLS + e + 1]) e++;
            runs.push({x0: 400 - CELL * (e + 1), x1: 400 - CELL * c, y0: r * CELL, y1: (r + 1) * CELL});
            c = e;
        }
    }
    return runs;
}

/** The outline of a set of cells: every cell edge whose neighbour across it is not in the set. */
export function outlineSegments(bits) {
    const on = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS && bits[r * COLS + c] === 1;
    const segments = [];
    for (let i = 0; i < CELLS; i++) {
        if (!bits[i]) continue;
        const {r, c, x0, x1, y0, y1} = cellBox(i);
        if (!on(r - 1, c)) segments.push([x0, y0, x1, y0]);
        if (!on(r + 1, c)) segments.push([x0, y1, x1, y1]);
        if (!on(r, c + 1)) segments.push([x0, y0, x0, y1]); // column c + 1 is the next one towards -x
        if (!on(r, c - 1)) segments.push([x1, y0, x1, y1]);
    }
    return segments;
}

/** Display transform: mirror x, then turn clockwise by `rotation` degrees (SVG y points down). */
export function viewTransform(rotation, mirror) {
    const a = ((Number(rotation) || 0) * Math.PI) / 180;
    const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
    const cos = snap(Math.cos(a));
    const sin = snap(Math.sin(a));
    return (x, y) => {
        const mx = mirror ? -x : x;
        return [mx * cos - y * sin + 0, mx * sin + y * cos + 0]; // + 0 turns -0 into 0
    };
}

/** The inverse of viewTransform: display coordinates back to the sensor frame (cm). */
export function inverseTransform(rotation, mirror) {
    const a = ((Number(rotation) || 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return (X, Y) => {
        const mx = X * cos + Y * sin;
        const y = -X * sin + Y * cos;
        return [mirror ? -mx : mx, y];
    };
}

/** The grid cell holding a point of the sensor frame (cm), or -1 outside the grid. */
export function cellAt(x, y) {
    const c = Math.floor((400 - x) / CELL);
    const r = Math.floor(y / CELL);
    return r >= 0 && r < ROWS && c >= 0 && c < COLS ? r * COLS + c : -1;
}

/** Every cell of the rectangle spanned by two cells. */
export function rectCells(a, b) {
    const out = [];
    const [r0, r1] = [Math.floor(a / COLS), Math.floor(b / COLS)].sort((p, q) => p - q);
    const [c0, c1] = [a % COLS, b % COLS].sort((p, q) => p - q);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * COLS + c);
    return out;
}

/** Cell bits back to the 80-character mask the converter takes (`native_zone.mask_hex`). */
export function bitsToHex(bits) {
    const bytes = new Uint8Array(CELLS / 8);
    for (let i = 0; i < CELLS; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What to warn about before saving a zone. The sensor accepts both (tested on firmware 63):
 * cells shared with another zone, and cells outside the monitored area, where it ignores movement.
 */
export function zoneCheck(bits, zones, id, edgeBits) {
    const overlaps = (zones || []).filter((z) => z.id !== id && z.bits.some((b, i) => b && bits[i])).map((z) => z.id);
    let outside = 0;
    if (edgeBits) for (let i = 0; i < CELLS; i++) if (bits[i] && edgeBits[i]) outside++;
    return {cells: bits.reduce((n, b) => n + b, 0), overlaps, outside};
}

/** Every cell turned to its opposite: the sensor stores the monitored area as the cells it ignores. */
export function invertBits(bits) {
    return bits.map((b) => 1 - b);
}

function insidePolygon(polygon, x, y) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
    return inside;
}

/**
 * The cells at least half inside a room outline (cm, sampled 10 x 10 per cell): the monitored area that fits the room.
 */
export function roomCells(outline) {
    const bits = new Uint8Array(CELLS);
    if (!outline) return bits;
    for (let i = 0; i < CELLS; i++) {
        const box = cellBox(i);
        let n = 0;
        for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) if (insidePolygon(outline, box.x0 + (a + 0.5) * 5, box.y0 + (b + 0.5) * 5)) n++;
        if (n >= 50) bits[i] = 1;
    }
    return bits;
}

/* ── Software zones (computed by the converter from positions) ─────────────────────────────────────────── */

export const SOFTWARE_ZONES = 8;

/**
 * A software zone's configuration, as `software_zone_N_config` carries it: a JSON object {name, x_min, x_max, y_min,
 * y_max, absence_timeout, rotation?} in the sensor's centimetres, or "clear". Returns the zone, null for "clear" (or an
 * empty value), and undefined for anything that is not a valid zone.
 */
export function parseSoftwareZone(value) {
    if (value == null) return null;
    let z = value;
    if (typeof value === "string") {
        const s = value.trim();
        if (s === "" || s === "clear") return null;
        try {
            z = JSON.parse(s);
        } catch {
            return undefined;
        }
    }
    if (!z || typeof z !== "object" || Array.isArray(z)) return undefined;
    // The same rules as the converter's (fp400ParseSoftwareZone): numbers only, name 1-32 characters.
    const name = z.name ?? "Zone";
    if (typeof name !== "string" || !name.trim() || name.length > 32) return undefined;
    const zone = {name, x_min: z.x_min, x_max: z.x_max, y_min: z.y_min, y_max: z.y_max, absence_timeout: z.absence_timeout ?? 3};
    for (const k of ["x_min", "x_max", "y_min", "y_max"]) if (typeof zone[k] !== "number" || !Number.isFinite(zone[k]) || Math.abs(zone[k]) > 2000) return undefined;
    if (zone.x_min >= zone.x_max || zone.y_min >= zone.y_max) return undefined;
    if (!Number.isInteger(zone.absence_timeout) || zone.absence_timeout < 0 || zone.absence_timeout > 300) return undefined;
    const rotation = z.rotation ?? 0;
    if (typeof rotation !== "number" || !Number.isFinite(rotation) || Math.abs(rotation) > 180) return undefined;
    if (rotation) zone.rotation = rotation;
    return zone;
}

/** Whether a target (cm, sensor frame) is in a software zone: a turned zone looks at it from its own frame. */
export function inSoftwareZone(t, z) {
    let {x, y} = t;
    if (z.rotation) {
        const a = (-z.rotation * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        [x, y] = [x * c - y * s, x * s + y * c];
    }
    return x >= z.x_min && x < z.x_max && y >= z.y_min && y < z.y_max;
}

/** The zone's four corners in the sensor frame (cm): its rectangle turned back by its rotation. */
export function softwareZoneCorners(z) {
    const a = ((z.rotation || 0) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        [z.x_min, z.y_min],
        [z.x_max, z.y_min],
        [z.x_max, z.y_max],
        [z.x_min, z.y_max],
    ].map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

/** Two zone configurations are the same zone (as sent and as published back). */
export function sameSoftwareZone(a, b) {
    if (!a || !b) return a === b;
    const key = (z) => JSON.stringify([z.name, z.x_min, z.x_max, z.y_min, z.y_max, z.absence_timeout, z.rotation || 0]);
    return key(a) === key(b);
}

/** Software zones from a Zigbee2MQTT message; null when the device has none (its `software_zones` option is off). */
function softwareZonesFromPayload(p) {
    const out = [];
    for (let n = 1; n <= SOFTWARE_ZONES; n++) {
        const key = `software_zone_${n}_config`;
        if (!(key in p)) continue;
        out.push({
            id: n,
            config: parseSoftwareZone(p[key]),
            occupied: boolOrNull(p[`software_zone_${n}_occupancy`]),
            count: numberOrNull(p[`software_zone_${n}_count`]),
            activity: typeof p[`software_zone_${n}_activity`] === "string" ? p[`software_zone_${n}_activity`] : null,
            available: p[`software_zone_${n}_available`] === true,
        });
    }
    return out.length ? out : null;
}

/** A value rounded to a grid step (cm). */
export function snapTo(value, step) {
    return Math.round(value / step) * step + 0;
}

/**
 * The 2 x 2 grid cells around a point (cm): the 1 x 1 m block centred on the grid lines nearest to it, for an
 * "ignore this spot" around a dot. Cells off the grid are left out.
 */
export function cellsAround(x, y) {
    const gx = Math.round(x / CELL) * CELL;
    const gy = Math.round(y / CELL) * CELL;
    const out = [];
    for (const yy of [gy - CELL / 2, gy + CELL / 2]) {
        for (const xx of [gx - CELL / 2, gx + CELL / 2]) {
            const i = cellAt(xx, yy);
            if (i >= 0) out.push(i);
        }
    }
    return out.sort((a, b) => a - b);
}

/* ── Device settings (the settings panel) ──────────────────────────────────────────────────────────────── */

/** The settings the panel can change, by section; each is shown only when its key is in the device's state. */
export const SETTINGS = [
    {section: "Detection", key: "presence_sensitivity", label: "Sensitivity", type: "enum", values: ["low", "medium", "high"]},
    {section: "Detection", key: "absence_timeout", label: "Empty after", type: "number", min: 0, max: 300, unit: "s"},
    {section: "Detection", key: "proximity_distance", label: "Approach distance", type: "enum", values: ["far", "medium", "near"]},
    {section: "Detection", key: "detection_direction", label: "Movement events", type: "enum", values: ["omnidirectional", "left_right"]},
    {section: "Detection", key: "coordinate_reverse", label: "Coordinate reverse", type: "enum", values: ["disabled", "enabled", "auto"]},
    {section: "Detection", key: "human_count_enabled", label: "People counting", type: "switch"},
    {section: "AI", key: "ai_high_precision", label: "High precision", type: "switch"},
    {section: "AI", key: "ai_adaptive_sensitivity", label: "Adaptive sensitivity", type: "switch"},
    {section: "AI", key: "ai_entry_exit_recognition", label: "Entrance recognition", type: "switch"},
    {section: "AI", key: "ai_interference_recognition", label: "Interference recognition", type: "switch"},
    {section: "Mounting", key: "installation_mode", label: "Mounted on", type: "enum", values: ["wall", "ceiling"]},
    {section: "Mounting", key: "side_installation", label: "Wall position", type: "enum", values: ["wall", "left_corner", "right_corner"]},
    {section: "Mounting", key: "installation_height", label: "Height", type: "number", min: 0, max: 65535, unit: "mm"},
    {section: "Map", key: "forget_still_targets", label: "Forget still dots after", type: "number", min: 0, max: 240, unit: "min"},
];
const SETTING_KEYS = SETTINGS.map((s) => s.key);

/** Whether a setting's published value equals the one written (numbers compare as numbers). */
export function sameSetting(published, sent) {
    if (typeof sent === "number") return Number(published) === sent;
    return published === sent;
}

/* ── Parsing the device state ──────────────────────────────────────────────────────────────────────────── */

const numberOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const boolOrNull = (v) => (typeof v === "boolean" ? v : null);

/** Targets from the payload's `targets` list (cm). Null when the key is absent (tracking never on). */
export function parseTargets(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const t of list) {
        if (!t || typeof t !== "object") continue;
        const x = Number(t.x);
        const y = Number(t.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const target = {id: Number.isInteger(t.id) ? t.id : out.length, x, y};
        if (Number.isInteger(t.zone)) target.zone = t.zone;
        if (typeof t.speed === "number" && Number.isFinite(t.speed)) target.speed = t.speed;
        if (typeof t.leaving === "boolean") target.leaving = t.leaving;
        out.push(target);
    }
    return out;
}

/** Targets from the `targets_xy` text ("id:x:y;id:x:y", "none" when empty). Null when unknown or malformed. */
export function parseTargetsXy(state) {
    if (state == null) return null;
    const s = String(state).trim();
    if (s === "none") return [];
    if (s === "" || s === "unknown" || s === "unavailable") return null;
    const out = [];
    for (const part of s.split(";")) {
        const m = /^\s*(-?\d+):(-?\d+):(-?\d+)\s*$/.exec(part);
        if (!m) return null; // one bad token: trust none of them rather than misplace one
        out.push({id: Number(m[1]), x: Number(m[2]), y: Number(m[3])});
    }
    return out;
}

/**
 * Targets from the `targets` entity. Home Assistant shows the list as Python text (`[{'id': 0, 'x': 34, ...}]`) cut at
 * 255 characters, so each complete `{...}` is read and one cut off at the end is left out. Null when unknown.
 */
export function parseTargetsText(state) {
    if (state == null) return null;
    const s = String(state).trim();
    if (!s.startsWith("[")) return null;
    const list = [];
    for (const [, body] of s.matchAll(/\{([^{}]*)\}/g)) {
        const target = {};
        for (const [, key, value] of body.matchAll(/['"]?(\w+)['"]?\s*:\s*(-?\d+(?:\.\d+)?|True|False|true|false)/g)) {
            target[key] = /^(True|true)$/.test(value) ? true : /^(False|false)$/.test(value) ? false : Number(value);
        }
        list.push(target);
    }
    return parseTargets(list);
}

/** Whether the `targets` entity's text was cut short, so that targets may be missing. */
export function targetsTextCut(state) {
    return typeof state === "string" && state.trim().startsWith("[") && !state.trim().endsWith("]");
}

/** Zones from the payload's `native_zones`, the sensor's zone list. */
export function parseZones(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const z of list) {
        if (!z || typeof z !== "object" || !Number.isInteger(z.zone_id)) continue;
        const bits = maskBits(z.mask_hex);
        if (!bits) continue;
        out.push({id: z.zone_id, enabled: z.enabled !== false, bits, hex: z.mask_hex});
    }
    return out.sort((a, b) => a.id - b.id);
}

/** The zone an endpoint carries (its `zone_id_N`), or null. */
const zoneOfEndpoint = (v) => (Number.isInteger(v) && v >= 1 && v <= MAX_ZONES ? v : null);

/**
 * One snapshot of everything the card draws, from a Zigbee2MQTT device message. Zone state and settings are published
 * per endpoint (`occupancy_N`, `human_count_N`, `presence_sensitivity_N`, `absence_timeout_N`, N = 3..10) and keyed
 * here by the zone the endpoint carries. Endpoints without a zone answer too (firmware 63), so only the zone list tells
 * which zones exist.
 */
export function snapshotFromPayload(p) {
    const zoneState = {};
    const zoneSettings = {};
    const zoneEndpoints = {};
    for (const n of ZONE_ENDPOINTS) {
        const zone = zoneOfEndpoint(p[`zone_id_${n}`]);
        if (zone === null) continue;
        zoneEndpoints[zone] = n;
        zoneState[zone] = {occupied: boolOrNull(p[`occupancy_${n}`]), count: numberOrNull(p[`human_count_${n}`])};
        const sensitivity = p[`presence_sensitivity_${n}`];
        zoneSettings[zone] = {sensitivity: typeof sensitivity === "string" ? sensitivity : null, timeout: numberOrNull(p[`absence_timeout_${n}`])};
    }
    const masks = {edge: p.edge_mask_hex, entry: p.entry_exit_mask_hex, interference: p.interference_mask_hex};
    return {
        source: "mqtt",
        presence: boolOrNull(p.occupancy_1 ?? p.occupancy ?? p.presence),
        humanCount: numberOrNull(p.human_count),
        targetCount: numberOrNull(p.target_count),
        tracking: typeof p.tracking_status === "string" ? p.tracking_status : null,
        targets: parseTargets(p.targets),
        masks,
        zones: parseZones(p.native_zones),
        zoneState,
        zoneSettings,
        zoneEndpoints,
        softwareZones: softwareZonesFromPayload(p),
        settings: Object.fromEntries(SETTING_KEYS.filter((k) => k in p).map((k) => [k, p[k]])),
        restore: "restore_status" in p ? {status: p.restore_status ?? null, error: p.restore_error ?? ""} : null,
    };
}

/** Entity ids for the reduced view, from the Zigbee2MQTT entity prefix (the device's friendly name). */
export function entityIds(prefix, overrides = {}) {
    const p = prefix;
    const ids = {
        presence: `binary_sensor.${p}_occupancy_1`,
        human_count: `sensor.${p}_human_count`,
        target_count: `sensor.${p}_target_count`,
        tracking_status: `sensor.${p}_tracking_status`,
        targets: `sensor.${p}_targets`,
        targets_xy: `sensor.${p}_targets_xy`,
        edge_mask: `text.${p}_edge_mask_hex`,
        entry_exit_mask: `text.${p}_entry_exit_mask_hex`,
        interference_mask: `text.${p}_interference_mask_hex`,
        installation_mode: `select.${p}_installation_mode`,
        // Per zone endpoint, N = 3..10.
        zone_id: (n) => `sensor.${p}_zone_id_${n}`,
        zone_occupancy: (n) => `binary_sensor.${p}_occupancy_${n}`,
        zone_count: (n) => `sensor.${p}_human_count_${n}`,
        software_config: (n) => `text.${p}_software_zone_${n}_config`,
        software_occupancy: (n) => `binary_sensor.${p}_software_zone_${n}_occupancy`,
        software_count: (n) => `sensor.${p}_software_zone_${n}_count`,
        software_activity: (n) => `sensor.${p}_software_zone_${n}_activity`,
    };
    for (const [k, v] of Object.entries(overrides || {})) if (typeof v === "string" && typeof ids[k] === "string") ids[k] = v;
    return ids;
}

/** The same snapshot, from Home Assistant entity states (the reduced view). */
export function snapshotFromStates(states, ids) {
    const value = (id) => {
        const s = id && states[id];
        return s && s.state !== "unknown" && s.state !== "unavailable" ? s.state : null;
    };
    const num = (id) => {
        const v = value(id);
        return v === null || !Number.isFinite(Number(v)) ? null : Number(v);
    };
    const onOff = (id) => {
        const v = value(id);
        return v === "on" ? true : v === "off" ? false : null;
    };
    // Keyed by the zone each endpoint carries. Home Assistant has no zone list, so zones that do not exist are here too.
    const zoneState = {};
    for (const n of ZONE_ENDPOINTS) {
        const zone = zoneOfEndpoint(num(ids.zone_id(n)));
        const occupied = onOff(ids.zone_occupancy(n));
        if (zone === null || occupied === null) continue;
        zoneState[zone] = {occupied, count: num(ids.zone_count(n))};
    }
    // The targets list (cut at 255 characters), or targets_xy from older converters.
    const listEntity = states[ids.targets];
    const listTargets = listEntity ? parseTargetsText(listEntity.state) : null;
    const xyEntity = states[ids.targets_xy];
    const targets = listTargets ?? (xyEntity ? parseTargetsXy(xyEntity.state) : null);
    const cut = listTargets !== null && targetsTextCut(listEntity.state);
    // Software zones whose configuration entity exists (the device's software_zones option is on).
    const softwareZones = [];
    for (let n = 1; n <= SOFTWARE_ZONES; n++) {
        const config = states[ids.software_config(n)];
        if (!config) continue;
        const activity = value(ids.software_activity(n));
        softwareZones.push({
            id: n,
            config: parseSoftwareZone(config.state === "unknown" || config.state === "unavailable" ? null : config.state),
            occupied: onOff(ids.software_occupancy(n)),
            count: num(ids.software_count(n)),
            activity: activity === "moving" || activity === "still" ? activity : null,
            available: onOff(ids.software_occupancy(n)) !== null,
        });
    }
    const settings = {};
    if (value(ids.installation_mode) !== null) settings.installation_mode = value(ids.installation_mode);
    return {
        source: "entities",
        presence: onOff(ids.presence),
        humanCount: num(ids.human_count),
        targetCount: num(ids.target_count),
        tracking: cut ? "partial" : value(ids.tracking_status),
        targets,
        masks: {edge: value(ids.edge_mask), entry: value(ids.entry_exit_mask), interference: value(ids.interference_mask)},
        // The zone list (native_zones) has no Home Assistant entity, so the reduced view draws no zone outlines.
        zones: null,
        zoneState,
        softwareZones: softwareZones.length ? softwareZones : null,
        settings,
        restore: null,
    };
}

/* ── Configuration ─────────────────────────────────────────────────────────────────────────────────────── */

const FEATURE_TYPES = ["door", "opening", "window", "glass", "wall", "furniture", "fixture"];

function points(raw, min, what) {
    if (!Array.isArray(raw) || raw.length < min) throw new Error(`${TAG}: ${what} needs at least ${min} [x, y] points (mm)`);
    return raw.map((p, i) => {
        if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) {
            throw new Error(`${TAG}: ${what}[${i}] is not an [x, y] pair of numbers (mm)`);
        }
        return [Number(p[0]) / 10, Number(p[1]) / 10]; // mm → cm, the sensor's unit
    });
}

/** Validated configuration with defaults. Throws a readable error for Home Assistant's error card. */
export function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") throw new Error(`${TAG}: missing configuration`);
    const topic = raw.topic == null ? null : String(raw.topic).trim();
    if (topic !== null && (topic === "" || /[#+]/.test(topic))) {
        throw new Error(`${TAG}: topic must be the device's own Zigbee2MQTT topic, without wildcards`);
    }
    const prefix = raw.entity_prefix == null ? (topic ? topic.split("/").pop() : null) : String(raw.entity_prefix).trim();
    if (!topic && !prefix) throw new Error(`${TAG}: set topic (live data) and/or entity_prefix (reduced view)`);
    const room = raw.room || {};
    const outline = room.outline_mm == null ? null : points(room.outline_mm, 3, "room.outline_mm");
    if (room.features != null && !Array.isArray(room.features)) throw new Error(`${TAG}: room.features must be a list`);
    const features = (room.features || []).map((f, i) => {
        const type = String(f?.type || "furniture").toLowerCase();
        if (!FEATURE_TYPES.includes(type)) throw new Error(`${TAG}: room.features[${i}].type must be one of ${FEATURE_TYPES.join(", ")}`);
        const closed = f.closed == null ? type === "furniture" || type === "fixture" : Boolean(f.closed);
        const name = f.name == null ? "" : String(f.name);
        return {type, name, closed, label: f.label !== false && name !== "", pts: points(f.points_mm, closed ? 3 : 2, `room.features[${i}].points_mm`)};
    });
    const zones = {};
    for (const [k, v] of Object.entries(raw.zones || {})) if (/^\d+$/.test(k)) zones[k] = String(v);
    const seconds = (v, d, max) => (v == null ? d : Math.min(max, Math.max(0, Number(v) || 0)));
    // Zigbee2MQTT's base topic (for bridge/logging) and the device's friendly name, which may itself contain slashes.
    const base = raw.base_topic == null ? (topic ? topic.split("/")[0] : null) : String(raw.base_topic).replace(/\/+$/, "");
    if (topic && base && !topic.startsWith(`${base}/`)) throw new Error(`${TAG}: topic must start with base_topic (${base}/)`);
    return {
        title: raw.title == null ? "" : String(raw.title),
        topic,
        base_topic: base,
        device: topic && base ? topic.slice(base.length + 1) : null,
        zone_editor: raw.zone_editor !== false,
        prefix,
        entities: raw.entities || {},
        rotation: Number(raw.rotation) || 0,
        mirror: Boolean(raw.mirror),
        zones,
        room: {outline, features},
        trail_seconds: seconds(raw.trail_seconds, 15, 120),
        stale_seconds: seconds(raw.stale_seconds, 30, 3600),
        refresh_on_open: raw.refresh_on_open !== false,
    };
}

/* ── The card ──────────────────────────────────────────────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch]);
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const PAD = 25; // cm of margin around the drawing
const SERIES = 8; // categorical slots for target ids 0-7; other ids are drawn neutral, always with their label
const lastRefresh = new Map(); // topic → time of the last `/get` this page sent
// The sensor's three areas: editor layer → name, Zigbee2MQTT key, snapshot mask. The monitored area is stored as the
// cells the sensor ignores; the editor draws and edits the cells it watches.
const AREAS = {
    edge: {name: "Monitored area", key: "edge_mask_hex", mask: "edge"},
    entry: {name: "Entrances", key: "entry_exit_mask_hex", mask: "entry"},
    interference: {name: "Interference", key: "interference_mask_hex", mask: "interference"},
};
const MAX_ZOOM = 8;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pretty = (v) => String(v).replace(/_/g, " ");
const AREA_HINTS = {
    edge: "The sensor ignores everything outside it, for example people behind a wall or a window.",
    entry: "Doorways: the sensor picks up and drops people faster in these cells.",
    interference: "Things that move by themselves, like a fan or a curtain: the sensor ignores movement in these cells.",
};

const STYLE = `
:host { display: block;
  --fp-ink: var(--primary-text-color, #1b1b1b); --fp-ink2: var(--secondary-text-color, #5f6368);
  --fp-surface: var(--ha-card-background, var(--card-background-color, #fff)); --fp-grid: var(--divider-color, rgba(0,0,0,.12));
  --fp-window: #6da7ec;
  --s0: #2a78d6; --s1: #eb6834; --s2: #1baf7a; --s3: #eda100; --s4: #e87ba4; --s5: #008300; --s6: #6250d6; --s7: #e34948; --s-other: #8a8984; }
:host([dark]) { --fp-window: #5598e7;
  --s0: #3987e5; --s1: #d95926; --s2: #199e70; --s3: #c98500; --s4: #d55181; --s5: #008300; --s6: #9085e9; --s7: #e66767; --s-other: #8a8984; }
ha-card { overflow: hidden; }
.body { padding: 0 16px 16px; }
.header { padding: 16px 16px 8px; font-size: 20px; line-height: 28px; color: var(--fp-ink); }
svg { display: block; width: 100%; height: auto; max-height: 72vh; }
svg text { font-family: inherit; fill: var(--fp-ink); paint-order: stroke; stroke: var(--fp-surface); stroke-width: 3px; stroke-linejoin: round; }
svg text.muted { fill: var(--fp-ink2); }
.nsl { vector-effect: non-scaling-stroke; }
.mon { fill: var(--fp-ink); fill-opacity: .045; stroke: var(--fp-grid); stroke-width: 1px; }
.entry { fill: var(--fp-ink2); fill-opacity: .10; stroke: var(--fp-ink2); stroke-width: 1px; stroke-dasharray: 3 3; }
.intf { fill: var(--fp-ink2); fill-opacity: .10; stroke: var(--fp-ink2); stroke-width: 1px; stroke-dasharray: 1 3; }
.hatch { stroke: var(--fp-ink2); stroke-width: 1.2px; stroke-opacity: .55; }
.wall { fill: none; stroke: var(--fp-ink); stroke-opacity: .75; stroke-width: 3px; stroke-linejoin: round; }
.furn { fill: var(--fp-ink); fill-opacity: .07; stroke: var(--fp-ink2); stroke-opacity: .6; stroke-width: 1px; }
.fixt { fill: var(--fp-ink); fill-opacity: .13; stroke: var(--fp-ink2); stroke-opacity: .7; stroke-width: 1px; }
.gap { fill: none; stroke: var(--fp-surface); stroke-width: 5px; }
.door { fill: none; stroke: var(--fp-ink2); stroke-width: 2px; }
.opening { fill: none; stroke: var(--fp-ink2); stroke-width: 1px; stroke-dasharray: 2 3; }
.window { fill: none; stroke: var(--fp-window); stroke-width: 3px; }
.glass { fill: none; stroke: var(--fp-window); stroke-width: 2px; stroke-dasharray: 6 3; }
.wallf { fill: none; stroke: var(--fp-ink); stroke-opacity: .75; stroke-width: 3px; }
.zone .zf { fill: var(--fp-ink); fill-opacity: 0; }
.zone .zo { fill: none; stroke: var(--fp-ink); stroke-opacity: .55; stroke-width: 1.5px; stroke-dasharray: 5 3; }
.zone.occ .zf { fill-opacity: .16; }
.zone.occ .zo { stroke-opacity: .9; stroke-width: 2px; stroke-dasharray: none; }
.zone.off .zo { stroke-opacity: .3; }
.sensor { fill: var(--fp-ink2); }
.trail { fill: none; stroke-width: 2px; stroke-linecap: round; }
.dot { stroke: var(--fp-surface); stroke-width: 2px; }
.dot.stale { fill-opacity: 0; stroke-width: 2px; stroke-dasharray: 3 2; }
.leaving { opacity: .45; }
.leaving .dot { stroke-dasharray: 2 2; }
svg.editing-edge .mon, svg.editing-entry .entry, svg.editing-entry .entry-h, svg.editing-interference .intf, svg.editing-interference .intf-h { display: none; }
.info { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.chip { font-size: 12px; line-height: 20px; padding: 0 8px; border-radius: 10px; color: var(--fp-ink); background: color-mix(in srgb, var(--fp-ink) 7%, transparent); }
.chip.on { font-weight: 600; background: color-mix(in srgb, var(--fp-ink) 14%, transparent); }
.chip.warn { outline: 1px dashed var(--fp-ink2); }
.rows { margin-top: 10px; font-size: 13px; line-height: 20px; color: var(--fp-ink); }
.rows .label { color: var(--fp-ink2); margin-right: 6px; }
.rows .item { margin-right: 12px; white-space: nowrap; }
.rows .item.on { font-weight: 600; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
.legend { margin-top: 8px; font-size: 12px; color: var(--fp-ink2); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
.legend svg { display: inline-block; width: 16px; height: 12px; vertical-align: -2px; margin-right: 4px; }
.note { margin-top: 8px; font-size: 12px; line-height: 16px; color: var(--fp-ink2); }
svg.editing { touch-action: none; cursor: crosshair; user-select: none; -webkit-user-select: none; }
.gridc { fill: transparent; stroke: var(--fp-grid); stroke-width: 1px; }
.draft { fill: var(--primary-color, #03a9f4); fill-opacity: .32; }
.drafto { fill: none; stroke: var(--primary-color, #03a9f4); stroke-width: 2.5px; }
.prev-add { fill: var(--primary-color, #03a9f4); fill-opacity: .18; stroke: var(--primary-color, #03a9f4); stroke-width: 1.5px; stroke-dasharray: 4 3; }
.prev-del { fill: var(--fp-surface); fill-opacity: .6; stroke: var(--fp-ink); stroke-width: 1.5px; stroke-dasharray: 2 3; }
svg.editing .zone { opacity: .55; }
.actions { margin-top: 10px; display: flex; justify-content: flex-end; }
.actions:empty { display: none; }
.editor { margin-top: 10px; font-size: 13px; color: var(--fp-ink); }
.editor:empty { display: none; }
.editor .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.editor .bar + .bar, .editor .msg, .editor .warn, .editor .hint { margin-top: 8px; }
.btn { font: inherit; font-size: 13px; line-height: 18px; padding: 4px 12px; border-radius: 16px; border: 1px solid var(--fp-grid); background: transparent; color: var(--fp-ink); cursor: pointer; }
.btn.sel { border-color: var(--primary-color, #03a9f4); box-shadow: inset 0 0 0 1px var(--primary-color, #03a9f4); font-weight: 600; }
.btn.primary { background: var(--primary-color, #03a9f4); border-color: transparent; color: var(--text-primary-color, #fff); }
.btn.danger { color: var(--error-color, #db4437); border-color: currentColor; }
.btn:disabled { opacity: .45; cursor: default; }
.editor label { color: var(--fp-ink2); display: inline-flex; gap: 6px; align-items: center; margin-right: 12px; }
.editor select, .editor input { font: inherit; font-size: 13px; color: var(--fp-ink); background: transparent; border: 1px solid var(--fp-grid); border-radius: 6px; padding: 2px 6px; }
.editor input { width: 64px; }
.editor .hint { color: var(--fp-ink2); font-size: 12px; line-height: 16px; }
.editor .warn { font-size: 12px; line-height: 16px; padding-left: 8px; border-left: 3px solid var(--warning-color, #ffa600); }
.editor .msg { font-size: 12px; line-height: 16px; }
.editor .msg.error { color: var(--error-color, #db4437); }
.editor .msg.ok { color: var(--success-color, #43a047); }
.map { position: relative; }
svg { touch-action: pan-x pan-y; }
svg.zoomed { touch-action: none; }
svg.zoomed:not(.editing) { cursor: grab; }
svg.panning:not(.editing) { cursor: grabbing; }
.zoomctl { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; }
.zoomctl:empty { display: none; }
.zoomctl .btn { font-size: 12px; line-height: 16px; padding: 2px 10px; background: var(--fp-surface); }
.sz .sf { fill: var(--fp-ink); fill-opacity: 0; }
.sz .so { fill: none; stroke: var(--fp-ink); stroke-opacity: .85; stroke-width: 1.25px; }
.sz.occ .sf { fill-opacity: .12; }
.sz.occ .so { stroke-opacity: 1; stroke-width: 1.5px; }
.sz .tag { fill: var(--fp-surface); stroke: var(--fp-ink); stroke-opacity: .55; stroke-width: 1px; }
.sz.occ .tag { fill: var(--fp-ink); stroke-opacity: 1; }
svg text.tagt { stroke: none; fill: var(--fp-ink); }
.sz.occ text.tagt { fill: var(--fp-surface); }
svg.editing .sz { opacity: .55; }
.pop { position: absolute; z-index: 2; width: max-content; max-width: min(300px, calc(100% - 8px)); box-sizing: border-box; padding: 10px 12px; border-radius: 10px; background: var(--fp-surface); color: var(--fp-ink); border: 1px solid var(--fp-grid); box-shadow: 0 2px 12px rgba(0,0,0,.22); font-size: 13px; line-height: 18px; }
.pop .t { font-weight: 600; }
.pop .sub, .pop .hint { color: var(--fp-ink2); font-size: 12px; line-height: 16px; }
.pop .bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 6px; }
.pop .btn { padding: 4px 10px; }
.pop .msg { font-size: 12px; line-height: 16px; margin-top: 6px; }
.pop .msg.error { color: var(--error-color, #db4437); }
.pop .msg.ok { color: var(--success-color, #43a047); }
.actions { gap: 6px; flex-wrap: wrap; }
.editor input.name { width: 150px; }
.editor input[type="checkbox"] { width: auto; margin: 0; }
.form { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; align-items: center; margin-top: 4px; }
.form .k { color: var(--fp-ink2); }
.form .v { color: var(--fp-ink); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-height: 26px; }
.form .sh { grid-column: 1 / -1; font-size: 12px; font-weight: 600; color: var(--fp-ink); margin-top: 8px; }
.form .sh:first-child { margin-top: 4px; }
.form .wide { grid-column: 1 / -1; }
.editor .form .hint, .editor .bar .hint { margin-top: 0; }
.panel > .bar { margin-top: 12px; }
`;

const Base = typeof HTMLElement === "undefined" ? class {} : HTMLElement;

export class Fp400MapCard extends Base {
    static getStubConfig() {
        return {topic: "zigbee2mqtt/<device friendly name>", rotation: 0, mirror: false};
    }

    constructor() {
        super();
        this._uid = `fp${Math.random().toString(36).slice(2, 8)}`;
        this._trails = new Map();
        this._mqtt = null; // latest snapshot from MQTT
        this._mqttAt = 0; // when it arrived
        this._mode = "starting"; // starting | mqtt | entities
        this._why = "";
        this._unsub = null;
        this._subscribing = false;
        this._edit = null; // the zone editor's state while it is open
        this._panel = null; // the settings panel's state while it is open
        this._pop = null; // the popover of a clicked dot
        this._busy = null; // whichever of those three is waiting for the sensor to confirm a write (one at a time)
        this._view = null; // zoom and pan: {k, x0, y0} in display coordinates, null for the whole map
        this._pointers = new Map(); // pointers down on the map, for pinch zoom
        this._gesture = null;
        this._dotAt = new Map(); // target id → where its dot is drawn, for clicks
        // A press anywhere but the map (the map handles its own: elsewhere on it closes the popover too).
        this._onOutside = (ev) => {
            if (!ev.composedPath().includes(this._el?.map)) this._closePop();
        };
        this._onKey = (ev) => {
            if (ev.key === "Escape") this._closePop();
        };
    }

    setConfig(config) {
        this._config = normalizeConfig(config);
        this._ids = this._config.prefix ? entityIds(this._config.prefix, this._config.entities) : null;
        this._setRotation(this._config.rotation);
        this._staticKey = null;
        this._cancelPending();
        this._closeEditor();
        this._panel = null;
        this._trails.clear();
        if (this._unsub) this._unsubscribe();
        this._mqtt = null;
        this._mode = "starting";
        if (this.shadowRoot) this._update(true);
        if (this._hass) this._subscribe();
    }

    set hass(hass) {
        const first = !this._hass;
        this._hass = hass;
        const dark = Boolean(hass.themes?.darkMode);
        if (dark !== this.hasAttribute("dark")) this.toggleAttribute("dark", dark);
        if (first) this._subscribe();
        if (this._mode !== "mqtt" || !this._mqtt) {
            // Reduced view, or live view before its first message: follow the entities, but only redraw when one of ours changed.
            const refs = this._entityRefs();
            if (first || refs.some((s, i) => s !== this._refs?.[i])) {
                this._refs = refs;
                this._update();
            }
        }
    }

    getCardSize() {
        return 9;
    }

    getGridOptions() {
        return {columns: 12, min_columns: 6, rows: "auto"};
    }

    connectedCallback() {
        if (!this.shadowRoot) this._build();
        this._timer = setInterval(() => this._tick(), 1000);
        if (this._hass) this._subscribe();
        this._update(true);
    }

    disconnectedCallback() {
        clearInterval(this._timer);
        this._unsubscribe();
        if (this._edit) this._edit.drag = null;
        this._closePop();
        this._stopErrorWatch();
    }

    /* ── Data ── */

    _entityRefs() {
        if (!this._hass || !this._ids) return [];
        const ids = this._ids;
        const list = [ids.presence, ids.human_count, ids.target_count, ids.tracking_status, ids.targets, ids.targets_xy, ids.edge_mask, ids.entry_exit_mask, ids.interference_mask, ids.installation_mode];
        for (const n of ZONE_ENDPOINTS) list.push(ids.zone_id(n), ids.zone_occupancy(n), ids.zone_count(n));
        for (let n = 1; n <= SOFTWARE_ZONES; n++) list.push(ids.software_config(n), ids.software_occupancy(n), ids.software_count(n), ids.software_activity(n));
        return list.map((id) => this._hass.states[id]);
    }

    async _subscribe() {
        const c = this._config;
        if (!c || !this._hass || !this.isConnected || this._unsub || this._subscribing) return;
        if (!c.topic) return this._fallback("no topic configured");
        if (this._hass.user && !this._hass.user.is_admin) return this._fallback("admin");
        this._subscribing = true;
        try {
            const unsub = await this._hass.connection.subscribeMessage((m) => this._onMessage(m), {type: "mqtt/subscribe", topic: c.topic});
            if (!this.isConnected) {
                unsub();
                return;
            }
            this._unsub = unsub;
            this._mode = "mqtt";
            this._why = "";
            this._zonesAsked = false;
            if (c.refresh_on_open) setTimeout(() => this._requestRefresh(), 4000);
        } catch (err) {
            this._fallback(err?.message || err?.code || String(err));
        } finally {
            this._subscribing = false;
            this._update();
        }
    }

    _unsubscribe() {
        const unsub = this._unsub;
        this._unsub = null;
        if (unsub) Promise.resolve(unsub()).catch(() => {});
    }

    _fallback(why) {
        this._mode = "entities";
        this._why = why;
        this._update();
    }

    /** No message yet a few seconds after subscribing (an empty room is quiet): ask Zigbee2MQTT for a fresh state. */
    _requestRefresh() {
        const c = this._config;
        if (this._mode !== "mqtt" || this._mqtt || !this._hass || !c.topic) return;
        const now = Date.now();
        if (now - (lastRefresh.get(c.topic) || 0) < 60000) return;
        lastRefresh.set(c.topic, now);
        // Reading the monitoring mask makes the sensor answer, and Zigbee2MQTT then publishes the whole state.
        this._hass.callService("mqtt", "publish", {topic: `${c.topic}/get`, payload: JSON.stringify({edge_mask_hex: ""})}).catch(() => {});
    }

    /**
     * The editor needs the sensor's zone list: without it, "New zone" could overwrite a zone it does not know about.
     * Zigbee2MQTT reads the list on its first poll and after each change; when a message comes without it, read it once
     * (one Zigbee read). A sensor without zones answers with `[]`. On an Ember coordinator a list of two zones or more
     * never arrives (it takes more than one frame), so the zone layer stays closed there.
     */
    _requestZones() {
        const c = this._config;
        if (!c.zone_editor || this._zonesAsked || !this._hass || !c.topic) return;
        this._zonesAsked = true;
        const key = `${c.topic}#zones`;
        const now = Date.now();
        if (now - (lastRefresh.get(key) || 0) < 60000) return;
        lastRefresh.set(key, now);
        this._hass.callService("mqtt", "publish", {topic: `${c.topic}/get`, payload: JSON.stringify({native_zones: ""})}).catch(() => {});
    }

    _onMessage(message) {
        let payload;
        try {
            payload = JSON.parse(message.payload);
        } catch {
            return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
        this._mqtt = snapshotFromPayload(payload);
        this._mqttAt = Date.now();
        if (this._mqtt.zones === null) this._requestZones();
        this._checkPending();
        this._update();
    }

    _snapshot() {
        if (this._mode === "mqtt" && this._mqtt) return this._mqtt;
        if (!this._hass || !this._ids) return null;
        return snapshotFromStates(this._hass.states, this._ids);
    }

    /** The Home Assistant entity the reduced view takes positions from: targets, or targets_xy from older converters. */
    _positionEntityId() {
        if (!this._ids) return undefined;
        return this._hass?.states[this._ids.targets] ? this._ids.targets : this._ids.targets_xy;
    }

    /** When the positions were last refreshed: the last MQTT message, or the targets entity's last report. */
    _updatedAt(snap) {
        if (snap?.source === "mqtt") return this._mqttAt;
        const s = this._hass?.states[this._positionEntityId()];
        return s ? Date.parse(s.last_reported || s.last_updated) || 0 : 0;
    }

    _isStale(snap) {
        if (!snap?.targets?.length) return false;
        const at = this._updatedAt(snap);
        return at > 0 && Date.now() - at > this._config.stale_seconds * 1000;
    }

    /* ── Drawing ── */

    _build() {
        this.attachShadow({mode: "open"});
        this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div class="header"></div><div class="body">
<div class="map"><svg xmlns="http://www.w3.org/2000/svg" role="img"><defs>
<pattern id="${this._uid}-h45" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="12"/></pattern>
<pattern id="${this._uid}-h135" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(135)"><line class="hatch" x1="0" y1="0" x2="0" y2="12"/></pattern>
</defs><g class="base"></g><g class="zones"></g><g class="soft"></g><g class="edit"></g><g class="labels"></g><g class="trails"></g><g class="targets"></g></svg>
<div class="zoomctl"></div><div class="pop" hidden></div></div>
<div class="editor"></div><div class="info"></div><div class="rows"></div><div class="legend"></div><div class="note"></div><div class="actions"></div></div></ha-card>`;
        const $ = (s) => this.shadowRoot.querySelector(s);
        this._el = {header: $(".header"), map: $(".map"), svg: $("svg"), base: $(".base"), zones: $(".zones"), soft: $(".soft"), edit: $(".edit"), labels: $(".labels"), trails: $(".trails"), targets: $(".targets"), zoomctl: $(".zoomctl"), pop: $(".pop"), editor: $(".editor"), info: $(".info"), rows: $(".rows"), legend: $(".legend"), note: $(".note"), actions: $(".actions")};
        this._el.actions.addEventListener("click", (ev) => this._onEditorClick(ev));
        const svg = this._el.svg;
        svg.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
        svg.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
        svg.addEventListener("pointerup", (ev) => this._onPointerUp(ev));
        svg.addEventListener("pointercancel", (ev) => this._onPointerCancel(ev));
        svg.addEventListener("wheel", (ev) => this._onWheel(ev), {passive: false});
        svg.addEventListener("dblclick", () => {
            if (!this._edit) this._setView(null);
        });
        this._el.zoomctl.addEventListener("click", (ev) => {
            if (ev.target.closest?.('[data-action="fit-view"]')) this._setView(null);
        });
        this._el.pop.addEventListener("click", (ev) => this._onPopClick(ev));
        this._el.editor.addEventListener("click", (ev) => this._onEditorClick(ev));
        this._el.editor.addEventListener("change", (ev) => this._onEditorChange(ev));
        this._el.editor.addEventListener("input", (ev) => this._onEditorInput(ev));
    }

    _update(force = false) {
        if (!this.shadowRoot || !this._config) return;
        const snap = this._snapshot();
        this._snap = snap;
        const masks = snap?.masks || {};
        const key = JSON.stringify([
            masks.edge,
            masks.entry,
            masks.interference,
            snap?.zones?.map((z) => [z.id, z.enabled, z.hex]) ?? null,
            snap?.softwareZones?.map((z) => [z.id, z.config]) ?? null,
            this._ceiling(snap),
        ]);
        if (force || key !== this._staticKey) {
            this._staticKey = key;
            this._drawStatic(snap);
        }
        this._trackTrails(snap);
        if (this._edit && !this._editorAvailable()) this._closeEditor();
        if (this._panel && !this._writesAllowed()) this._panel = null;
        if (this._pop && !this._popAllowed()) this._closePop();
        this._drawDynamic(snap);
        this._drawInfo(snap);
        this._drawEditor();
        this._drawPopover();
    }

    _setRotation(rotation) {
        this._rotation = rotation;
        this._T = viewTransform(rotation, this._config.mirror);
        this._Tinv = inverseTransform(rotation, this._config.mirror);
        this._view = null;
        if (this._edit) this._edit.drag = null;
        this._closePop();
    }

    /** A ceiling sensor without a room outline: frame 6 m all around it (it sees behind itself too). */
    _ceiling(snap) {
        return !this._config.room.outline && snap?.settings?.installation_mode === "ceiling";
    }

    _tick() {
        if (!this._snap) return;
        const stale = this._isStale(this._snap);
        if (stale !== this._wasStale) this._drawDynamic(this._snap);
        this._drawInfo(this._snap);
    }

    _drawStatic(snap) {
        const c = this._config;
        const T = this._T;
        const el = this._el;
        const xs = [];
        const ys = [];
        const at = (x, y) => {
            const p = T(x, y);
            xs.push(p[0]);
            ys.push(p[1]);
            return p;
        };
        const poly = (pts) =>
            pts
                .map(([x, y]) => {
                    const p = at(x, y);
                    return `${f1(p[0])},${f1(p[1])}`;
                })
                .join(" ");
        const rect = (r) => poly([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]);
        const base = [];
        const labels = [];

        // The sensor's monitored area (cells the edge mask leaves in), as a faint 50 cm grid. With a room outline the frame
        // follows the room, not the monitored area: a new sensor monitors its whole 8 x 10 m grid, which would shrink the
        // room to a corner. Cells beyond the frame are clipped, and so are people seen through a wall (pinned, hollow).
        const edge = maskBits(snap?.masks?.edge);
        const ceiling = this._ceiling(snap);
        this._legend = {};
        if (edge) {
            const frameCells = !c.room.outline && !ceiling;
            for (let i = 0; i < CELLS; i++) {
                if (edge[i]) continue;
                const b = cellBox(i);
                const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
                const pts = frameCells ? rect(b) : corners.map(([x, y]) => T(x, y).map(f1).join(",")).join(" ");
                base.push(`<polygon class="mon nsl" points="${pts}"/>`);
            }
            this._legend.mon = true;
        }
        const hatched = (bits, cls, pattern, title) => {
            if (!bits) return false;
            const runs = cellRuns(bits);
            for (const r of runs) {
                const pts = rect(r);
                base.push(`<polygon class="${cls} nsl" points="${pts}"><title>${title}</title></polygon><polygon class="${cls}-h" points="${pts}" fill="url(#${this._uid}-${pattern})"/>`);
            }
            return runs.length > 0;
        };
        this._legend.entry = hatched(maskBits(snap?.masks?.entry), "entry", "h45", "Entrance / exit cells");
        this._legend.intf = hatched(maskBits(snap?.masks?.interference), "intf", "h135", "Interference cells (ignored)");

        // The room: furniture first, then the wall line, then doors, windows and openings cut into it.
        const room = c.room;
        const centre = room.outline ? room.outline.reduce((a, p) => [a[0] + p[0] / room.outline.length, a[1] + p[1] / room.outline.length], [0, 0]) : [0, 250];
        for (const f of room.features) {
            if (f.type !== "furniture" && f.type !== "fixture") continue;
            base.push(`<polygon class="${f.type === "fixture" ? "fixt" : "furn"} nsl" points="${poly(f.pts)}"><title>${esc(f.name)}</title></polygon>`);
        }
        if (room.outline) base.push(`<polygon class="wall nsl" points="${poly(room.outline)}"/>`);
        for (const f of room.features) {
            if (f.type === "furniture" || f.type === "fixture") continue;
            const shape = f.closed ? "polygon" : "polyline";
            const pts = poly(f.pts);
            if (f.type !== "wall") base.push(`<${shape} class="gap nsl" points="${pts}"/>`);
            const cls = f.type === "wall" ? "wallf" : f.type;
            base.push(`<${shape} class="${cls} nsl" points="${pts}"><title>${esc(f.name || f.type)}</title></${shape}>`);
        }

        // Zones: geometry now, occupancy in _drawDynamic.
        this._zoneGeo = (snap?.zones || []).map((z) => {
            const fill = cellRuns(z.bits).map((r) => `M${rect(r).replace(/ /g, "L")}Z`).join("");
            const outline = outlineSegments(z.bits)
                .map(([x0, y0, x1, y1]) => {
                    const a = at(x0, y0);
                    const b = at(x1, y1);
                    return `M${f1(a[0])},${f1(a[1])}L${f1(b[0])},${f1(b[1])}`;
                })
                .join("");
            const corners = [];
            for (let i = 0; i < CELLS; i++) {
                if (!z.bits[i]) continue;
                const b = cellBox(i);
                corners.push(T(b.x0, b.y0), T(b.x1, b.y0), T(b.x0, b.y1), T(b.x1, b.y1));
            }
            const minX = Math.min(...corners.map((p) => p[0]));
            const minY = Math.min(...corners.map((p) => p[1]));
            return {id: z.id, enabled: z.enabled, fill, outline, lx: minX, ly: minY};
        });

        // Software zones (rectangles in cm, maybe turned): geometry now, occupancy in _drawDynamic. They do not move the frame.
        this._softGeo = (snap?.softwareZones || [])
            .filter((z) => z.config)
            .map((z) => {
                const pts = softwareZoneCorners(z.config).map(([x, y]) => T(x, y));
                const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
                const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
                return {id: z.id, name: z.config.name, pts: pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(" "), cx, cy, by: Math.max(...pts.map((p) => p[1]))};
            });

        // A ceiling sensor without a room outline: 6 m all around it.
        if (ceiling) for (const [x, y] of [[-600, -600], [600, -600], [600, 600], [-600, 600]]) at(x, y);

        // Sensor. Text and dots keep their size on screen when zoomed in.
        const s = at(0, 0);
        const span = () => Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 200);
        const fs = Math.min(36, Math.max(10, span() / 34)) / (this._view?.k || 1);
        this._fs = fs;
        labels.push(`<circle class="sensor" cx="${f1(s[0])}" cy="${f1(s[1])}" r="${f1(fs * 0.45)}"><title>FP400</title></circle>`);

        // Names: furniture at its centre, doors and windows just inside the wall. A piece of furniture named like a drawn
        // zone ("Table") is left to the zone's own label.
        const zoneNames = new Set([...this._zoneGeo.map((z) => this._zoneName(z.id).toLowerCase()), ...this._softGeo.map((z) => z.name.toLowerCase())]);
        for (const f of room.features) {
            if (!f.label || (f.closed && zoneNames.has(f.name.toLowerCase()))) continue;
            let x;
            let y;
            if (f.closed) {
                x = f.pts.reduce((a, p) => a + p[0], 0) / f.pts.length;
                y = f.pts.reduce((a, p) => a + p[1], 0) / f.pts.length;
            } else {
                const a = f.pts[0];
                const b = f.pts[f.pts.length - 1];
                x = (a[0] + b[0]) / 2;
                y = (a[1] + b[1]) / 2;
                const d = Math.hypot(centre[0] - x, centre[1] - y) || 1;
                x += ((centre[0] - x) / d) * fs * 1.1;
                y += ((centre[1] - y) / d) * fs * 1.1;
            }
            const p = T(x, y);
            labels.push(`<text class="muted" x="${f1(p[0])}" y="${f1(p[1])}" font-size="${f1(fs * 0.8)}" text-anchor="middle" dominant-baseline="middle">${esc(f.name)}</text>`);
        }

        // Frame: everything drawn so far (at least the sensor), plus a margin. Targets outside it are pinned to the edge.
        const x0 = Math.min(...xs) - PAD;
        const y0 = Math.min(...ys) - PAD;
        const w = Math.max(...xs) + PAD - x0;
        const h = Math.max(...ys) + PAD - y0;
        this._frame = {x0, y0, x1: x0 + w, y1: y0 + h};
        this._applyView();
        el.svg.setAttribute("aria-label", `${c.title || "FP400"} room map`);
        el.base.innerHTML = base.join("");
        el.labels.innerHTML = labels.join("");

        // Cells the editor can draw on: every grid cell inside the frame.
        this._visible = new Map();
        for (let i = 0; i < CELLS; i++) {
            const b = cellBox(i);
            const corners = [T(b.x0, b.y0), T(b.x1, b.y0), T(b.x1, b.y1), T(b.x0, b.y1)];
            const cx = corners.reduce((a, p) => a + p[0], 0) / 4;
            const cy = corners.reduce((a, p) => a + p[1], 0) / 4;
            if (cx < this._frame.x0 || cx > this._frame.x1 || cy < this._frame.y0 || cy > this._frame.y1) continue;
            this._visible.set(i, corners.map((p) => `${f1(p[0])},${f1(p[1])}`).join(" "));
        }
        this._drawEdit();
    }

    _zoneName(id) {
        return this._config.zones[String(id)] || `Zone ${id}`;
    }

    _color(id) {
        return Number.isInteger(id) && id >= 0 && id < SERIES ? `var(--s${id})` : "var(--s-other)";
    }

    _trackTrails(snap) {
        const keep = this._config.trail_seconds * 1000;
        const targets = snap?.targets || [];
        if (!keep) return this._trails.clear();
        const now = Date.now();
        const ids = new Set(targets.map((t) => t.id));
        for (const id of [...this._trails.keys()]) if (!ids.has(id)) this._trails.delete(id);
        for (const t of targets) {
            let trail = this._trails.get(t.id) || [];
            const last = trail[trail.length - 1];
            if (last && Math.hypot(last.x - t.x, last.y - t.y) > 150) trail = []; // an id handed to someone else
            if (!last || last.x !== t.x || last.y !== t.y) trail.push({x: t.x, y: t.y, t: now});
            while (trail.length && now - trail[0].t > keep) trail.shift();
            this._trails.set(t.id, trail);
        }
    }

    _drawDynamic(snap) {
        const el = this._el;
        const T = this._T;
        const fs = this._fs || 14;
        const fr = this._frame;

        el.zones.innerHTML = (this._zoneGeo || [])
            .filter((z) => z.id !== this._edit?.id) // the zone being edited is drawn as the draft instead
            .map((z) => {
                const st = snap?.zoneState?.[z.id] || {};
                const name = this._zoneName(z.id);
                const count = st.count ?? null;
                const occ = st.occupied === true;
                const text = occ && count ? `${name} · ${count}` : name;
                const title = `${name}: ${st.occupied == null ? "unknown" : occ ? "occupied" : "empty"}${count == null ? "" : `, ${count} counted`}${z.enabled ? "" : " (disabled)"}`;
                return `<g class="zone${occ ? " occ" : ""}${z.enabled ? "" : " off"}"><title>${esc(title)}</title><path class="zf" d="${z.fill}"/><path class="zo nsl" d="${z.outline}"/><text x="${f1(z.lx + fs * 0.3)}" y="${f1(z.ly + fs * 1.05)}" font-size="${f1(fs * 0.85)}" font-weight="${occ ? 600 : 400}">${esc(text)}</text></g>`;
            })
            .join("");

        // Software zones: a thin solid outline with a rounded name tag, filled (and the tag inverted) while occupied.
        const softState = new Map((snap?.softwareZones || []).map((z) => [z.id, z]));
        el.soft.innerHTML = (this._softGeo || [])
            .filter((z) => !(this._edit?.layer === "software" && z.id === this._edit.id))
            .map((z) => {
                const st = softState.get(z.id) || {};
                const occ = st.occupied === true;
                const text = occ && st.count ? `${z.name} · ${st.count}` : z.name;
                const tfs = fs * 0.72;
                const tw = (text.length * 0.56 + 1.2) * tfs;
                const th = tfs * 1.6;
                const ty = Math.max(z.cy, z.by - th / 2 - fs * 0.3);
                const state = st.occupied == null ? "unknown" : occ ? "occupied" : "empty";
                const title = `${z.name} (software zone): ${state}${st.count == null ? "" : `, ${st.count} counted`}${occ && st.activity ? `, ${st.activity}` : ""}`;
                return (
                    `<g class="sz${occ ? " occ" : ""}"><title>${esc(title)}</title><polygon class="sf" points="${z.pts}"/><polygon class="so nsl" points="${z.pts}"/>` +
                    `<rect class="tag nsl" x="${f1(z.cx - tw / 2)}" y="${f1(ty - th / 2)}" width="${f1(tw)}" height="${f1(th)}" rx="${f1(th / 2)}"/>` +
                    `<text class="tagt" x="${f1(z.cx)}" y="${f1(ty)}" font-size="${f1(tfs)}" font-weight="${occ ? 600 : 500}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text></g>`
                );
            })
            .join("");

        const stale = this._isStale(snap);
        this._wasStale = stale;
        this._dotAt.clear();
        const trails = [];
        const dots = [];
        const clamp = (p) => (fr ? [Math.min(fr.x1 - fs * 0.6, Math.max(fr.x0 + fs * 0.6, p[0])), Math.min(fr.y1 - fs * 0.6, Math.max(fr.y0 + fs * 0.6, p[1]))] : p);
        for (const t of snap?.targets || []) {
            const color = this._color(t.id);
            const trail = this._trails.get(t.id) || [];
            for (let i = 1; i < trail.length; i++) {
                const a = T(trail[i - 1].x, trail[i - 1].y);
                const b = T(trail[i].x, trail[i].y);
                const o = 0.15 + (0.55 * i) / trail.length;
                trails.push(`<line class="trail nsl" stroke="${color}" stroke-opacity="${o.toFixed(2)}" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/>`);
            }
            const raw = T(t.x, t.y);
            const p = clamp(raw);
            const outside = p[0] !== raw[0] || p[1] !== raw[1];
            const zone = t.zone ? this._zoneName(t.zone) : t.zone === 0 ? "no zone" : "";
            const leaving = t.leaving === true; // the sensor is dropping it (published by newer converters, firmware 60 and later)
            const title = [`Target ${t.id}`, `x ${t.x} cm, y ${t.y} cm`, zone, t.speed == null ? "" : `${t.speed} cm/s`, leaving ? "leaving" : "", outside ? "outside the map" : "", stale ? "not updated recently" : ""].filter(Boolean).join(" · ");
            const r = fs * 0.62;
            const hollow = stale || outside;
            this._dotAt.set(t.id, {X: p[0], Y: p[1], r});
            dots.push(
                // A hollow dot's ring takes its colour inline: the .dot rule's surface-coloured stroke would hide it.
                `<g data-tid="${t.id}"${leaving ? ` class="leaving"` : ""}><title>${esc(title)}</title><circle class="dot nsl${hollow ? " stale" : ""}" cx="${f1(p[0])}" cy="${f1(p[1])}" r="${f1(r)}" fill="${color}" ${hollow ? `style="stroke:${color}"` : ""}/>` +
                    `<text x="${f1(p[0] + r + fs * 0.2)}" y="${f1(p[1])}" font-size="${f1(fs * 0.85)}" font-weight="600" dominant-baseline="middle">${t.id}</text></g>`,
            );
        }
        el.trails.innerHTML = trails.join("");
        el.targets.innerHTML = dots.join("");
    }

    _drawInfo(snap) {
        const c = this._config;
        const el = this._el;
        el.header.textContent = c.title;
        el.header.style.display = c.title ? "" : "none";
        if (!snap) {
            el.info.innerHTML = "";
            el.rows.innerHTML = "";
            el.legend.innerHTML = "";
            el.note.textContent = "Waiting for Home Assistant…";
            return;
        }
        const chips = [];
        if (snap.presence != null) chips.push(`<span class="chip${snap.presence ? " on" : ""}">${snap.presence ? "Occupied" : "Empty"}</span>`);
        if (snap.humanCount != null) chips.push(`<span class="chip">${snap.humanCount} ${snap.humanCount === 1 ? "person" : "people"}</span>`);
        if (snap.targets) chips.push(`<span class="chip">${snap.targets.length} tracked</span>`);
        if (snap.tracking === "partial") chips.push(`<span class="chip warn" title="The last position report, or its Home Assistant state, was cut short; some targets may be missing">partial report</span>`);
        const at = this._updatedAt(snap);
        if (at && snap.targets) {
            const s = Math.max(0, Math.round((Date.now() - at) / 1000));
            const ago = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
            chips.push(`<span class="chip${this._isStale(snap) ? " warn" : ""}" title="Time since the last position update">updated ${ago} ago</span>`);
        }
        this._set(el.info, chips.join(""));

        const rows = [];
        // The sensor's zone list when it is known (the live view). Without it, only the zones named in the card: every zone
        // endpoint answers, also those without a zone.
        const named = Object.keys(c.zones);
        const zoneIds = snap.zones
            ? snap.zones.map((z) => z.id)
            : Object.keys(snap.zoneState)
                  .filter((id) => named.includes(id))
                  .map(Number)
                  .sort((a, b) => a - b);
        if (zoneIds.length) {
            const items = zoneIds.map((id) => {
                const st = snap.zoneState[id] || {};
                const occ = st.occupied === true;
                const mark = st.occupied == null ? "?" : occ ? "●" : "○";
                const state = st.occupied == null ? "unknown" : occ ? "occupied" : "empty";
                const count = st.count == null ? "" : ` ${st.count}`;
                const title = `${state}${st.count == null ? "" : `, ${st.count} counted`}`;
                return `<span class="item${occ ? " on" : ""}" title="${title}">${mark} ${esc(this._zoneName(id))}${count}</span>`;
            });
            rows.push(`<div><span class="label">Zones</span>${items.join("")}</div>`);
        }
        const soft = (snap.softwareZones || []).filter((z) => z.config);
        if (soft.length) {
            const items = soft.map((z) => {
                const occ = z.occupied === true;
                const mark = z.occupied == null ? "?" : occ ? "●" : "○";
                const state = z.occupied == null ? "unknown" : occ ? "occupied" : "empty";
                const parts = [esc(z.config.name)];
                if (z.count != null) parts.push(String(z.count));
                if (occ && z.activity) parts.push(z.activity);
                const title = `${state}${z.count == null ? "" : `, ${z.count} counted`}; empty after ${z.config.absence_timeout} s`;
                return `<span class="item${occ ? " on" : ""}" title="${title}">${mark} ${parts.join(" · ")}</span>`;
            });
            rows.push(`<div><span class="label">Software zones</span>${items.join("")}</div>`);
        }
        if (snap.targets?.length) {
            const items = snap.targets.map((t) => {
                const parts = [`${t.id}`];
                if (t.zone) parts.push(esc(this._zoneName(t.zone)));
                if (t.speed) parts.push(`${t.speed} cm/s`);
                if (t.leaving) parts.push("leaving");
                return `<span class="item" title="x ${t.x} cm, y ${t.y} cm"><span class="sw" style="background:${this._color(t.id)}"></span>${parts.join(" · ")}</span>`;
            });
            rows.push(`<div><span class="label">Targets</span>${items.join("")}</div>`);
        }
        this._set(el.rows, rows.join(""));

        const lg = this._legend || {};
        const sw = (body) => `<svg viewBox="0 0 16 12">${body}</svg>`;
        const legend = [];
        if (lg.mon) legend.push(`<span>${sw('<rect class="mon" x="1" y="1" width="14" height="10"/>')}monitored area</span>`);
        if (lg.entry) legend.push(`<span>${sw(`<rect class="entry" x="1" y="1" width="14" height="10"/><rect x="1" y="1" width="14" height="10" fill="url(#${this._uid}-h45)"/>`)}entrance / exit</span>`);
        if (lg.intf) legend.push(`<span>${sw(`<rect class="intf" x="1" y="1" width="14" height="10"/><rect x="1" y="1" width="14" height="10" fill="url(#${this._uid}-h135)"/>`)}interference (ignored)</span>`);
        if (this._zoneGeo?.length) legend.push(`<span>${sw('<rect x="1" y="1" width="14" height="10" fill="none" stroke="currentColor" stroke-dasharray="3 2"/>')}zone</span>`);
        if (this._softGeo?.length) legend.push(`<span>${sw('<rect x="1" y="1" width="14" height="10" fill="none" stroke="currentColor"/><rect x="3" y="4" width="10" height="4" rx="2" fill="currentColor"/>')}software zone</span>`);
        this._set(el.legend, legend.join(""));

        el.note.textContent = `${this._noteText(snap)} Card ${VERSION}.`;
    }

    /** Replace an element's markup only when it changed (the info runs every second; keeps hover tooltips steady). */
    _set(element, html) {
        if (element._fpHtml === html) return;
        element._fpHtml = html;
        // A field being typed in keeps its focus, text and caret (a message may redraw the panel meanwhile).
        const active = this.shadowRoot?.activeElement;
        let focus = null;
        if (active?.dataset?.focus && element.contains(active)) {
            focus = {key: active.dataset.focus, value: active.value, sel: null};
            try {
                if (active.selectionStart != null) focus.sel = [active.selectionStart, active.selectionEnd];
            } catch {
                // Number fields have no caret position.
            }
        }
        element.innerHTML = html;
        if (!focus) return;
        const field = element.querySelector(`[data-focus="${focus.key}"]`);
        if (!field || field.disabled) return;
        field.value = focus.value;
        field.focus();
        try {
            if (focus.sel) field.setSelectionRange(...focus.sel);
        } catch {
            // As above.
        }
    }

    /* ── Zoom and pan ─────────────────────────────────────────────────────────────────────────────────────
     * Ctrl or ⌘ with the wheel, or a pinch, zooms (1x to 8x, about the pointer); a plain wheel scrolls the page past the
     * whole map and zooms once it is zoomed in. Dragging pans while zoomed in, except in the editor, where dragging draws
     * (a pinch still zooms there). A double-click or the Fit button shows the whole map again. */

    _zoom() {
        return this._view?.k || 1;
    }

    /** What the map shows: the whole frame, or the zoomed part of it (display coordinates). */
    _viewBox() {
        const fr = this._frame;
        if (!fr) return null;
        const W = fr.x1 - fr.x0;
        const H = fr.y1 - fr.y0;
        const v = this._view;
        if (!v) return {x0: fr.x0, y0: fr.y0, w: W, h: H};
        const w = W / v.k;
        const h = H / v.k;
        return {x0: clamp(v.x0, fr.x0, fr.x1 - w), y0: clamp(v.y0, fr.y0, fr.y1 - h), w, h};
    }

    _applyView() {
        const el = this._el;
        const vb = this._viewBox();
        if (!el || !vb) return;
        el.svg.setAttribute("viewBox", `${f1(vb.x0)} ${f1(vb.y0)} ${f1(vb.w)} ${f1(vb.h)}`);
        const zoomed = this._zoom() > 1;
        el.svg.classList.toggle("zoomed", zoomed);
        this._set(el.zoomctl, zoomed ? `<button class="btn" data-action="fit-view" title="Show the whole map (or double-click it)">Fit</button>` : "");
    }

    /** Zoom to `k` (clamped) with `view` as the new corner, or null for the whole map. Text keeps its size on screen. */
    _setView(view) {
        const before = this._zoom();
        if (view) {
            const k = clamp(view.k, 1, MAX_ZOOM);
            this._view = k <= 1.001 ? null : {k, x0: view.x0, y0: view.y0};
            if (this._view) {
                const vb = this._viewBox();
                this._view.x0 = vb.x0;
                this._view.y0 = vb.y0;
            }
        } else this._view = null;
        this._closePop();
        if (Math.abs(this._zoom() - before) > 1e-9 && this._snap !== undefined) {
            this._drawStatic(this._snap);
            this._drawDynamic(this._snap);
        } else this._applyView();
    }

    _clientToUser(cx, cy) {
        const ctm = this._el.svg.getScreenCTM();
        return ctm ? new DOMPoint(cx, cy).matrixTransform(ctm.inverse()) : null;
    }

    /**
     * Zoom to `k` keeping the map point `P` under the screen point (cx, cy). `ctm` and `vb` are the screen matrix and the
     * view when the gesture started: the svg element itself does not move or resize while zooming.
     */
    _zoomAround(ctm, vb, kFrom, P, cx, cy, k) {
        k = clamp(k, 1, MAX_ZOOM);
        const ox = ctm.e + ctm.a * vb.x0; // the screen position of the view's corner
        const oy = ctm.f + ctm.d * vb.y0;
        const a = (ctm.a * k) / kFrom;
        const d = (ctm.d * k) / kFrom;
        this._setView({k, x0: P.x - (cx - ox) / a, y0: P.y - (cy - oy) / d});
    }

    _onWheel(ev) {
        // Not a trap for page scrolling: a dashboard scrolls past the map until someone zooms on purpose.
        if (!ev.ctrlKey && !ev.metaKey && this._zoom() <= 1) return;
        const ctm = this._el.svg.getScreenCTM();
        const vb = this._viewBox();
        if (!ctm || !vb) return;
        ev.preventDefault();
        const step = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
        const k = this._zoom() * Math.exp(-ev.deltaY * step * (ev.ctrlKey ? 0.01 : 0.0015)); // ctrlKey: a trackpad pinch
        const P = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
        this._zoomAround(ctm, vb, this._zoom(), P, ev.clientX, ev.clientY, k);
    }

    _pinch() {
        const [a, b] = [...this._pointers.values()];
        return {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2};
    }

    _capture(ev) {
        try {
            this._el.svg.setPointerCapture(ev.pointerId);
        } catch {
            // Synthetic events have no active pointer to capture.
        }
    }

    /* ── Zone editor (admins, live view) ──────────────────────────────────────────────────────────────────
     * Writes go to `<topic>/set` through mqtt.publish: `native_zone` {zone_id, mask_hex} creates or changes a zone,
     * `native_zone_remove` deletes one, `presence_sensitivity_N` / `absence_timeout_N` set its options on the endpoint N
     * that carries it. A write counts as done only when the sensor's own zone list (or the setting) comes back with the
     * new value; an error Zigbee2MQTT logs for this device in the meantime (`<base>/bridge/logging`) is shown instead. */

    /** Whether this card may write to the device: an admin in the live view, with the editor not turned off. */
    _writesAllowed() {
        const c = this._config;
        return Boolean(c.zone_editor && c.topic && this._mode === "mqtt" && this._mqtt);
    }

    _editorAvailable() {
        if (!this._writesAllowed()) return false;
        return Boolean(this._mqtt.zones) || Boolean(this._mqtt.softwareZones) || Object.values(AREAS).some((a) => maskBits(this._mqtt.masks[a.mask]));
    }

    /** The layers the editor can open: zones once the zone list is known, software zones once the device publishes them
     * (its software_zones option is on), each area once its cells are known. */
    _layerAvailable(layer) {
        if (layer === "zone") return Boolean(this._mqtt?.zones);
        if (layer === "software") return Boolean(this._mqtt?.softwareZones);
        return Boolean(maskBits(this._mqtt?.masks?.[AREAS[layer].mask]));
    }

    _zones() {
        return this._mqtt?.zones || [];
    }

    _editDirty() {
        const e = this._edit;
        if (!e) return false;
        if (e.layer === "software") return this._softForm(e) !== e.saved;
        return bitsToHex(e.draft) !== e.saved;
    }

    /* ── Software zones in the editor ── */

    _softZones() {
        return this._mqtt?.softwareZones || [];
    }

    _softForm(e) {
        return JSON.stringify([e.name, e.timeout, e.sz]);
    }

    /** The lowest software zone slot without a zone, or null when all eight are taken. */
    _newSoftId() {
        return this._softZones().find((z) => !z.config)?.id ?? null;
    }

    _firstSoftId() {
        return this._softZones().find((z) => z.config)?.id ?? this._newSoftId();
    }

    /** Opens software zone `id` (an existing one, or a new one without a rectangle yet). */
    _openSoftware(id, message = null) {
        if (id == null) return;
        const config = this._softZones().find((z) => z.id === id)?.config;
        const sz = config ? {x_min: config.x_min, x_max: config.x_max, y_min: config.y_min, y_max: config.y_max} : null;
        if (sz && config.rotation) sz.rotation = config.rotation;
        const e = {layer: "software", id, isNew: !config, sz, name: config ? config.name : `Zone ${id}`, timeout: String(config ? config.absence_timeout : 3), drag: null, pending: null, message};
        e.saved = this._softForm(e);
        this._edit = e;
        this._setEditClass();
        this._redrawEdit();
    }

    /** The zone the form describes, as the converter takes it, or the reasons it cannot be saved yet. */
    _softDraft(e) {
        const problems = [];
        const name = e.name.trim();
        if (!name || name.length > 32) problems.push("The name must be 1 to 32 characters.");
        const timeout = Number(e.timeout);
        if (e.timeout.trim() === "" || !Number.isInteger(timeout) || timeout < 0 || timeout > 300) problems.push("Empty after must be a whole number of seconds, 0 to 300.");
        if (!e.sz) problems.push("Drag a rectangle on the map to place the zone.");
        if (problems.length) return {problems};
        const zone = {name, x_min: e.sz.x_min, x_max: e.sz.x_max, y_min: e.sz.y_min, y_max: e.sz.y_max, absence_timeout: timeout};
        if (e.sz.rotation) zone.rotation = e.sz.rotation;
        return {zone, problems};
    }

    _newZoneId() {
        const used = new Set(this._zones().map((z) => z.id));
        for (let id = 1; id <= MAX_ZONES; id++) if (!used.has(id)) return id;
        return null;
    }

    /** Opens zone `id` (an existing one, or a new empty one) in the editor. */
    _openEditor(id, message = null) {
        if (id == null) return;
        const zone = this._zones().find((z) => z.id === id);
        const draft = zone ? zone.bits.slice() : new Uint8Array(CELLS);
        this._edit = {layer: "zone", id, isNew: !zone, draft, saved: bitsToHex(draft), drag: null, pending: null, message};
        this._setEditClass();
        this._redrawEdit();
    }

    /** Opens one of the sensor's areas: "edge" (the monitored area), "entry" or "interference". */
    _openLayer(layer, message = null) {
        const stored = maskBits(this._mqtt?.masks?.[AREAS[layer].mask]);
        if (!stored) return;
        const draft = layer === "edge" ? invertBits(stored) : stored.slice();
        this._edit = {layer, id: null, isNew: false, draft, saved: bitsToHex(draft), drag: null, pending: null, message};
        this._setEditClass();
        this._redrawEdit();
    }

    /** Opens the editor on the first zone, a new one, or, without a zone list, software zones or the first area reported. */
    _openFirst(message = null) {
        this._panel = null;
        this._closePop();
        if (this._layerAvailable("zone")) {
            const zones = this._zones();
            return this._openEditor(zones.length ? zones[0].id : this._newZoneId(), message);
        }
        if (this._layerAvailable("software")) return this._openSoftware(this._firstSoftId(), message);
        const layer = Object.keys(AREAS).find((l) => this._layerAvailable(l));
        if (layer) this._openLayer(layer, message);
    }

    /** While an area is edited, its own drawing is hidden: the draft takes its place. */
    _setEditClass() {
        const svg = this._el?.svg;
        if (!svg) return;
        svg.classList.toggle("editing", Boolean(this._edit));
        for (const layer of Object.keys(AREAS)) svg.classList.toggle(`editing-${layer}`, this._edit?.layer === layer);
    }

    _closeEditor() {
        if (this._busy && this._busy === this._edit) this._cancelPending();
        this._edit = null;
        this._setEditClass();
    }

    _redrawEdit() {
        this._drawEdit();
        if (this._snap) this._drawDynamic(this._snap);
        this._drawEditor();
    }

    /** Everything a write's progress shows in: the editor, the settings panel, a dot's popover. */
    _redrawUi() {
        this._redrawEdit();
        this._drawPopover();
    }

    /** The editor's map layer: the grid, the draft, and the rectangle being dragged. */
    _drawEdit() {
        const el = this._el;
        if (!el) return;
        const e = this._edit;
        if (!e || !this._visible) {
            el.edit.innerHTML = "";
            return;
        }
        const out = [];
        for (const pts of this._visible.values()) out.push(`<polygon class="gridc nsl" points="${pts}"/>`);
        const T = this._T;
        if (e.layer === "software") {
            // The zone's rectangle (turned, if it is), and the one being dragged; the grid is only a guide here.
            const shape = (z) => softwareZoneCorners(z).map(([x, y]) => T(x, y).map(f1).join(",")).join(" ");
            if (e.sz) out.push(`<polygon class="draft" points="${shape(e.sz)}"/><polygon class="drafto nsl" points="${shape(e.sz)}"/>`);
            if (e.drag) {
                const [x0, x1] = [e.drag.a[0], e.drag.b[0]].sort((p, q) => p - q);
                const [y0, y1] = [e.drag.a[1], e.drag.b[1]].sort((p, q) => p - q);
                out.push(`<polygon class="prev-add nsl" points="${shape({x_min: x0, x_max: x1, y_min: y0, y_max: y1})}"/>`);
            }
            el.edit.innerHTML = out.join("");
            return;
        }
        for (const [i, pts] of this._visible) if (e.draft[i]) out.push(`<polygon class="draft" points="${pts}"/>`);
        const outline = outlineSegments(e.draft)
            .map(([x0, y0, x1, y1]) => {
                const a = T(x0, y0);
                const b = T(x1, y1);
                return `M${f1(a[0])},${f1(a[1])}L${f1(b[0])},${f1(b[1])}`;
            })
            .join("");
        if (outline) out.push(`<path class="drafto nsl" d="${outline}"/>`);
        if (e.drag) {
            const cls = e.drag.add ? "prev-add" : "prev-del";
            for (const i of rectCells(e.drag.start, e.drag.cur)) if (this._visible.has(i)) out.push(`<polygon class="${cls} nsl" points="${this._visible.get(i)}"/>`);
        }
        el.edit.innerHTML = out.join("");
    }

    _cellFromEvent(ev) {
        const ctm = this._el.svg.getScreenCTM();
        if (!ctm) return -1;
        const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
        const i = cellAt(...this._Tinv(p.x, p.y));
        return this._visible?.has(i) ? i : -1;
    }

    /** A point of the sensor frame (cm) under the pointer, snapped to 10 cm, for drawing software zones. */
    _softPoint(ev) {
        const p = this._clientToUser(ev.clientX, ev.clientY);
        if (!p) return null;
        const [x, y] = this._Tinv(p.x, p.y);
        return [clamp(snapTo(x, 10), -2000, 2000), clamp(snapTo(y, 10), -2000, 2000)];
    }

    /** The dot under the pointer (with some slack for fingers), when its popover may open. */
    _dotFromEvent(ev) {
        if (!this._popAllowed()) return null;
        const p = this._clientToUser(ev.clientX, ev.clientY);
        if (!p) return null;
        let best = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (const [id, d] of this._dotAt) {
            const dist = Math.hypot(d.X - p.x, d.Y - p.y);
            if (dist <= d.r * 2 && dist < bestD) {
                best = id;
                bestD = dist;
            }
        }
        return best;
    }

    _onPointerDown(ev) {
        if (ev.button > 1) return;
        if (ev.isPrimary) this._pointers.clear();
        this._pointers.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
        if (this._pointers.size === 2) {
            // A second finger: pinch to zoom; whatever the first one was drawing is dropped.
            if (this._edit?.drag) {
                this._edit.drag = null;
                this._drawEdit();
            }
            const ctm = this._el.svg.getScreenCTM();
            const vb = this._viewBox();
            if (!ctm || !vb) return;
            const start = this._pinch();
            this._gesture = {type: "pinch", ctm, vb, k: this._zoom(), start, P: new DOMPoint(start.mx, start.my).matrixTransform(ctm.inverse())};
            this._capture(ev);
            return;
        }
        if (this._pointers.size > 2) return;
        const e = this._edit;
        if (e && ev.button === 0) {
            this._gesture = null;
            if (this._busy) return;
            if (e.layer === "software") {
                const pt = this._softPoint(ev);
                if (!pt) return;
                ev.preventDefault();
                this._capture(ev);
                e.drag = {a: pt, b: pt};
                return this._drawEdit();
            }
            const i = this._cellFromEvent(ev);
            if (i < 0) return;
            ev.preventDefault();
            this._capture(ev);
            e.drag = {start: i, cur: i, add: !e.draft[i]}; // starting on a drawn cell clears, on an empty one fills
            return this._drawEdit();
        }
        // Not drawing: a press on a dot opens its popover when released in place; a drag pans (the middle button always).
        const vb = this._viewBox();
        const ctm = this._el.svg.getScreenCTM();
        if (!vb || !ctm) return;
        this._gesture = {type: "press", x: ev.clientX, y: ev.clientY, vb, ctm, moved: false, dot: ev.button === 0 && !e ? this._dotFromEvent(ev) : null};
        if (this._zoom() > 1 || ev.button === 1) {
            ev.preventDefault();
            this._capture(ev);
        }
    }

    _onPointerMove(ev) {
        if (this._pointers.has(ev.pointerId)) this._pointers.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
        const g = this._gesture;
        if (g?.type === "pinch") {
            if (this._pointers.size < 2) return;
            const now = this._pinch();
            return this._zoomAround(g.ctm, g.vb, g.k, g.P, now.mx, now.my, (g.k * now.d) / g.start.d);
        }
        const d = this._edit?.drag;
        if (d) {
            if (this._edit.layer === "software") {
                const pt = this._softPoint(ev);
                if (!pt || (pt[0] === d.b[0] && pt[1] === d.b[1])) return;
                d.b = pt;
                return this._drawEdit();
            }
            const i = this._cellFromEvent(ev);
            if (i < 0 || i === d.cur) return;
            d.cur = i;
            return this._drawEdit();
        }
        if (g?.type !== "press") return;
        const dx = ev.clientX - g.x;
        const dy = ev.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 5) return;
        g.moved = true;
        if (this._zoom() <= 1) return;
        this._el.svg.classList.add("panning");
        this._setView({k: this._zoom(), x0: g.vb.x0 - dx / g.ctm.a, y0: g.vb.y0 - dy / g.ctm.d});
    }

    _onPointerUp(ev) {
        this._pointers.delete(ev.pointerId);
        const g = this._gesture;
        this._el.svg.classList.remove("panning");
        if (g?.type === "pinch") {
            if (this._pointers.size === 0) this._gesture = null;
            return;
        }
        this._gesture = null;
        const e = this._edit;
        if (e?.drag) {
            if (e.layer === "software") {
                const {a, b} = e.drag;
                const [x0, x1] = [a[0], b[0]].sort((p, q) => p - q);
                const [y0, y1] = [a[1], b[1]].sort((p, q) => p - q);
                e.drag = null;
                if (x1 - x0 >= 10 && y1 - y0 >= 10) {
                    e.sz = {x_min: x0, x_max: x1, y_min: y0, y_max: y1}; // a drawn rectangle is not turned
                    e.message = null;
                }
            } else {
                for (const i of rectCells(e.drag.start, e.drag.cur)) if (this._visible.has(i)) e.draft[i] = e.drag.add ? 1 : 0;
                e.drag = null;
                e.message = null;
            }
            this._drawEdit();
            this._drawEditor();
            return;
        }
        if (!g || g.type !== "press" || g.moved) return;
        if (g.dot != null) this._openPop(g.dot);
        else this._closePop();
    }

    _onPointerCancel(ev) {
        if (ev) this._pointers.delete(ev.pointerId);
        this._gesture = null;
        this._el.svg.classList.remove("panning");
        if (!this._edit?.drag) return;
        this._edit.drag = null;
        this._drawEdit();
    }

    _drawEditor() {
        const el = this._el;
        if (!el) return;
        const e = this._edit;
        const available = this._editorAvailable();
        const writes = this._writesAllowed();
        const buttons = [];
        if (!e && !this._panel) {
            if (writes) buttons.push(`<button class="btn" data-action="settings">Settings</button>`);
            if (available) buttons.push(`<button class="btn" data-action="open">Edit zones and areas</button>`);
        }
        this._set(el.actions, buttons.join(""));
        if (this._panel && writes && !e) return this._set(el.editor, this._panelHtml());
        if (!available || !e) return this._set(el.editor, "");
        const busy = Boolean(this._busy);
        const dis = busy ? " disabled" : "";
        const list = [["zone", "Zones"]];
        if (this._layerAvailable("software")) list.push(["software", "Software zones"]);
        list.push(...Object.entries(AREAS).map(([layer, area]) => [layer, area.name]));
        // Without the zone list the zones cannot be edited (a new zone could overwrite an unknown one).
        const noList = "The sensor's zone list has not arrived. Zigbee2MQTT on an Ember coordinator cannot read it once the sensor has two zones or more.";
        const layers = list.map(([layer, label]) => {
            const open = this._layerAvailable(layer);
            const title = layer === "zone" && !open ? ` title="${esc(noList)}"` : "";
            return `<button class="btn${e.layer === layer ? " sel" : ""}" data-action="layer" data-layer="${layer}"${title}${busy || !open ? " disabled" : ""}>${label}</button>`;
        });
        const body = e.layer === "zone" ? this._zoneEditorHtml(e, busy, dis) : e.layer === "software" ? this._softEditorHtml(e, busy, dis) : this._areaEditorHtml(e, busy, dis);
        const msg = e.message ? `<div class="msg ${e.message.kind}">${esc(e.message.text)}</div>` : "";
        this._set(el.editor, `<div class="bar layers">${layers.join("")}</div>${body}${msg}`);
    }

    _softEditorHtml(e, busy, dis) {
        const chips = this._softZones()
            .filter((z) => z.config)
            .map((z) => `<button class="btn${z.id === e.id ? " sel" : ""}" data-action="soft-select" data-id="${z.id}"${dis}>${esc(z.config.name)}</button>`);
        const freeId = this._newSoftId();
        if (e.isNew) chips.push(`<button class="btn sel" disabled>${esc(e.name.trim() || `Zone ${e.id}`)} (new)</button>`);
        else {
            const title = freeId == null ? "All eight software zones are in use" : `Create software zone ${freeId}`;
            chips.push(`<button class="btn" data-action="soft-new" title="${title}"${freeId == null || busy ? " disabled" : ""}>+ New</button>`);
        }
        const z = e.sz;
        const m = (cm) => (Math.round(cm) / 100).toFixed(cm % 10 ? 2 : 1);
        const where = z
            ? `x ${z.x_min} to ${z.x_max} cm, y ${z.y_min} to ${z.y_max} cm (${m(z.x_max - z.x_min)} × ${m(z.y_max - z.y_min)} m)${z.rotation ? `, turned ${z.rotation}°` : ""}.`
            : "No rectangle yet.";
        const {problems} = this._softDraft(e);
        const warns = [];
        if (z?.rotation) warns.push("This zone is turned. A rectangle drawn here replaces it, without the turn.");
        // Only what stops a save the user has started on: the name and timeout fields say the rest themselves.
        const shown = problems.filter((p) => !(e.isNew && !z && p.startsWith("Drag")));
        const dirty = this._editDirty();
        const save = `<button class="btn primary" data-action="save"${!dirty || problems.length || busy ? " disabled" : ""}>${e.isNew ? "Create zone" : "Save zone"}</button>`;
        const revert = dirty && !busy ? `<button class="btn" data-action="revert">Undo changes</button>` : "";
        const del = e.isNew ? "" : `<button class="btn danger" data-action="delete"${dis}>Delete zone</button>`;
        return (
            `<div class="bar zones-bar">${chips.join("")}</div>` +
            `<div class="hint">Software zones are worked out by Zigbee2MQTT from the positions, as rectangles in 10 cm steps. Drag a rectangle on the map to place this one. ${where}</div>` +
            `<div class="bar"><label>Name <input type="text" class="name" data-sz="name" data-focus="sz-name" maxlength="32" value="${esc(e.name)}"${dis}></label>` +
            `<label>Empty after <input type="number" data-sz="timeout" data-focus="sz-timeout" min="0" max="300" step="1" value="${esc(e.timeout)}"${dis}> s</label></div>` +
            [...warns, ...shown].map((w) => `<div class="warn">${esc(w)}</div>`).join("") +
            `<div class="bar">${save}${revert}${del}<button class="btn" data-action="close"${dis}>Done</button></div>`
        );
    }

    /* ── Settings panel (admins, live view): each change is written at once and confirmed by the device's state ── */

    _openPanel() {
        this._closePop();
        this._panel = {pending: null, message: null};
        this._drawEditor();
    }

    _panelHtml() {
        const p = this._panel;
        const snap = this._mqtt;
        const s = snap.settings || {};
        const busy = Boolean(this._busy);
        const dis = busy ? " disabled" : "";
        const sections = new Map();
        for (const def of SETTINGS) {
            if (!(def.key in s)) continue;
            const v = s[def.key];
            const id = `${this._uid}-${def.key}`;
            let control;
            if (def.type === "enum") {
                const values = def.values.includes(v) ? def.values : [v, ...def.values];
                const options = values.map((o) => `<option value="${esc(o ?? "")}"${o === v ? " selected" : ""}${def.values.includes(o) ? "" : " disabled"}>${esc(o == null ? "?" : pretty(o))}</option>`);
                control = `<select id="${id}" data-config="${def.key}"${dis}>${options.join("")}</select>`;
            } else if (def.type === "switch") {
                control = `<input id="${id}" type="checkbox" data-config="${def.key}"${v === "ON" ? " checked" : ""}${dis}>${v === "ON" || v === "OFF" ? "" : `<span class="hint">${esc(String(v ?? "unknown"))}</span>`}`;
            } else {
                const extra = def.key === "forget_still_targets" ? `<span class="hint">0 = off</span>` : "";
                control = `<input id="${id}" type="number" data-config="${def.key}" data-focus="cfg-${def.key}" min="${def.min}" max="${def.max}" step="1" value="${esc(v ?? "")}"${dis}> ${def.unit}${extra}`;
            }
            if (!sections.has(def.section)) sections.set(def.section, []);
            sections.get(def.section).push(`<label class="k" for="${id}">${def.label}</label><span class="v">${control}</span>`);
        }
        // One grid for every section, so the controls line up.
        const grid = [];
        for (const [name, rows] of sections) grid.push(`<div class="sh">${name}</div>`, ...rows);
        // Learning: the sensor maps the empty room. The converter publishes no progress, so the card only sends the start.
        grid.push(`<div class="sh">Room learning</div><div class="wide bar"><button class="btn" data-action="learn"${dis}>Learn the empty room</button></div>`);
        if (snap.restore) {
            const r = snap.restore;
            grid.push(`<div class="sh">Restore</div><span class="k">Status</span><span class="v">${esc(String(r.status ?? "unknown"))}</span>`);
            if (r.error) grid.push(`<span class="k">Error</span><span class="v">${esc(String(r.error))}</span>`);
        }
        const out = [`<div class="hint">Each change is written to the sensor at once and confirmed when it reports the new value.</div>`, `<div class="form">${grid.join("")}</div>`];
        if (p.message) out.push(`<div class="msg ${p.message.kind}">${esc(p.message.text)}</div>`);
        out.push(`<div class="bar"><button class="btn" data-action="close-settings"${dis}>Done</button></div>`);
        return `<div class="panel">${out.join("")}</div>`;
    }

    _areaEditorHtml(e, busy, dis) {
        const area = AREAS[e.layer];
        const cells = e.draft.reduce((n, b) => n + b, 0);
        const warns = [];
        if (e.layer === "edge") {
            if (!cells) warns.push("Draw at least one cell: with none, the sensor would ignore the whole room.");
            const cut = this._zones().filter((z) => z.bits.some((b, i) => b && !e.draft[i]));
            if (cut.length) warns.push(`Part of ${cut.map((z) => esc(this._zoneName(z.id))).join(", ")} is outside; the sensor will ignore movement there.`);
        } else {
            const edge = maskBits(this._mqtt.masks.edge);
            let outside = 0;
            if (edge) for (let i = 0; i < CELLS; i++) if (e.draft[i] && edge[i]) outside++;
            if (outside) warns.push(`${outside} cell${outside === 1 ? " is" : "s are"} outside the monitored area, where the sensor ignores movement anyway.`);
        }
        const dirty = this._editDirty();
        const save = `<button class="btn primary" data-action="save"${!dirty || busy || (e.layer === "edge" && !cells) ? " disabled" : ""}>Save</button>`;
        const fit =
            e.layer === "edge" && this._config.room.outline
                ? `<button class="btn" data-action="fit" title="The cells at least half inside the room outline"${dis}>Fit to room</button>`
                : "";
        const clear = e.layer !== "edge" && cells ? `<button class="btn" data-action="clear"${dis}>Clear</button>` : "";
        const revert = dirty && !busy ? `<button class="btn" data-action="revert">Undo changes</button>` : "";
        return (
            `<div class="hint">${area.name}: ${cells} cell${cells === 1 ? "" : "s"} of 50 × 50 cm. ${AREA_HINTS[e.layer]} Tap a cell to add or remove it; drag to fill or clear a rectangle.</div>` +
            warns.map((w) => `<div class="warn">${w}</div>`).join("") +
            `<div class="bar">${save}${fit}${clear}${revert}<button class="btn" data-action="close"${dis}>Done</button></div>`
        );
    }

    _zoneEditorHtml(e, busy, dis) {
        const zones = this._zones();
        const name = esc(this._zoneName(e.id));
        const chips = zones.map(
            (z) => `<button class="btn${z.id === e.id ? " sel" : ""}" data-action="select" data-id="${z.id}"${dis}>${esc(this._zoneName(z.id))}</button>`,
        );
        const freeId = this._newZoneId();
        if (e.isNew) chips.push(`<button class="btn sel" disabled>${name} (new)</button>`);
        else {
            const title = freeId == null ? `The sensor holds at most ${MAX_ZONES} zones` : `Create zone ${freeId}`;
            chips.push(`<button class="btn" data-action="new" title="${title}"${freeId == null || busy ? " disabled" : ""}>+ New zone</button>`);
        }
        const check = zoneCheck(e.draft, zones, e.id, maskBits(this._mqtt.masks.edge));
        const warns = [];
        if (check.overlaps.length) {
            const names = check.overlaps.map((id) => esc(this._zoneName(id))).join(", ");
            warns.push(`Shares cells with ${names}. The sensor accepts overlapping zones; how it counts someone in a shared cell is untested.`);
        }
        if (check.outside) warns.push(`${check.outside} cell${check.outside === 1 ? " is" : "s are"} outside the monitored area, where the sensor ignores movement.`);
        // The sensor pushes changes for five things: room presence, the light, and three zones; the converter gives the
        // first three zones those entries.
        const count = zones.length + (e.isNew ? 1 : 0);
        if (e.isNew && count >= 4) warns.push("The sensor pushes changes for at most 3 zones; with more, the others are read once a minute. The dots show every zone right away.");
        const dirty = this._editDirty();
        const save = `<button class="btn primary" data-action="save"${!dirty || !check.cells || busy ? " disabled" : ""}>${e.isNew ? "Create zone" : "Save zone"}</button>`;
        const revert = dirty && !busy ? `<button class="btn" data-action="revert">Undo changes</button>` : "";
        const del = e.isNew ? "" : `<button class="btn danger" data-action="delete"${dis}>Delete zone</button>`;
        return (
            `<div class="bar zones-bar">${chips.join("")}</div>` +
            `<div class="hint">${name}: ${check.cells} cell${check.cells === 1 ? "" : "s"} of 50 × 50 cm. Tap a cell to add or remove it; drag to fill or clear a rectangle. Your own dot shows where you stand.</div>` +
            warns.map((w) => `<div class="warn">${w}</div>`).join("") +
            (e.isNew ? "" : this._settingsHtml(e.id, busy)) +
            `<div class="bar">${save}${revert}${del}<button class="btn" data-action="close"${dis}>Done</button></div>`
        );
    }

    _settingsHtml(id, busy) {
        const s = this._mqtt.zoneSettings?.[id] || {};
        // The settings live on the endpoint that carries the zone; until the sensor has said which, they cannot be written.
        const known = this._mqtt.zoneEndpoints?.[id] != null;
        const dis = busy || !known ? " disabled" : "";
        const options = ["low", "medium", "high"].map((v) => `<option value="${v}"${s.sensitivity === v ? " selected" : ""}>${v}</option>`).join("");
        const unknown = s.sensitivity == null ? `<option value="" selected>?</option>` : "";
        return (
            `<div class="bar"><label>Sensitivity <select data-setting="sensitivity"${dis}>${unknown}${options}</select></label>` +
            `<label>Absence timeout <input type="number" min="0" max="300" step="1" data-setting="absence_timeout" value="${s.timeout ?? ""}"${dis}> s</label></div>` +
            (known ? "" : `<div class="hint">The zone's settings can be changed once the sensor reports which endpoint carries it, within a minute.</div>`)
        );
    }

    _onEditorClick(ev) {
        const button = ev.target.closest?.("button[data-action]");
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === "open") return this._openFirst();
        if (action === "settings") return this._openPanel();
        if (action === "close-settings") {
            this._panel = null;
            return this._drawEditor();
        }
        if (action === "learn") {
            if (this._busy || !this._panel) return;
            if (!confirm("Start learning the empty room? Leave the room empty for a few minutes.")) return;
            // Nothing comes back to confirm it: after 5 s without an error from Zigbee2MQTT the start counts as sent.
            const sent = "Sent. The sensor reports no progress; keep the room empty for a few minutes.";
            return this._send({spatial_learning: "start"}, {kind: "learn", label: "Starting room learning…", timeout: 5000, timeoutText: sent}, this._panel);
        }
        const e = this._edit;
        if (!e) return;
        const discardOk = () => !this._editDirty() || confirm("Discard the unsaved changes?");
        if (action === "close") {
            if (!discardOk()) return;
            this._closeEditor();
            return this._redrawEdit();
        }
        if (action === "layer") {
            const layer = button.dataset.layer;
            if (layer === e.layer || !discardOk()) return;
            if (layer === "software") return this._openSoftware(this._firstSoftId());
            if (layer !== "zone") return this._openLayer(layer);
            const zones = this._zones();
            return this._openEditor(zones.length ? zones[0].id : this._newZoneId());
        }
        if (action === "revert") return e.layer === "zone" ? this._openEditor(e.id) : e.layer === "software" ? this._openSoftware(e.id) : this._openLayer(e.layer);
        if (e.layer === "software") return this._onSoftAction(action, button, e, discardOk);
        if (action === "fit" || action === "clear") {
            e.draft = action === "fit" ? roomCells(this._config.room.outline) : new Uint8Array(CELLS);
            e.message = null;
            return this._redrawEdit();
        }
        if (e.layer !== "zone") {
            if (action !== "save") return;
            const area = AREAS[e.layer];
            const hex = bitsToHex(e.layer === "edge" ? invertBits(e.draft) : e.draft);
            const done = `${area.name} saved; the sensor confirmed its cells.`;
            return this._send({[area.key]: hex}, {kind: "area", layer: e.layer, hex, label: `Saving the ${area.name.toLowerCase()}…`, done});
        }
        if (action === "select" || action === "new") {
            const id = action === "new" ? this._newZoneId() : Number(button.dataset.id);
            if (id === e.id || !discardOk()) return;
            return this._openEditor(id);
        }
        const name = this._zoneName(e.id);
        if (action === "save") {
            const hex = bitsToHex(e.draft);
            const done = `${name} ${e.isNew ? "created" : "saved"}; the sensor confirmed its cells.`;
            return this._send({native_zone: {zone_id: e.id, mask_hex: hex}}, {kind: "save", id: e.id, hex, label: `${e.isNew ? "Creating" : "Saving"} ${name}…`, done});
        }
        if (action === "delete") {
            if (!confirm(`Remove ${name} (zone ${e.id}) from the sensor?`)) return;
            return this._send({native_zone_remove: e.id}, {kind: "delete", id: e.id, label: `Removing ${name}…`, done: `${name} removed.`});
        }
    }

    _onSoftAction(action, button, e, discardOk) {
        if (action === "soft-select" || action === "soft-new") {
            const id = action === "soft-new" ? this._newSoftId() : Number(button.dataset.id);
            if (id === e.id || !discardOk()) return;
            return this._openSoftware(id);
        }
        const name = e.isNew ? e.name.trim() || `Zone ${e.id}` : this._softZones().find((z) => z.id === e.id)?.config?.name || `Zone ${e.id}`;
        const key = `software_zone_${e.id}_config`;
        if (action === "save") {
            const {zone} = this._softDraft(e);
            if (!zone) return;
            const done = `${zone.name} ${e.isNew ? "created" : "saved"}; Zigbee2MQTT confirmed it.`;
            return this._send({[key]: JSON.stringify(zone)}, {kind: "soft", id: e.id, zone, label: `${e.isNew ? "Creating" : "Saving"} ${zone.name}…`, done});
        }
        if (action === "delete") {
            if (!confirm(`Remove the software zone ${name}?`)) return;
            return this._send({[key]: "clear"}, {kind: "soft-delete", id: e.id, label: `Removing ${name}…`, done: `${name} removed.`});
        }
    }

    /** Typing in the software zone's name or timeout: the draft follows, the field keeps its focus (see _set). */
    _onEditorInput(ev) {
        const which = ev.target.dataset?.sz;
        const e = this._edit;
        if (!which || e?.layer !== "software" || e.pending) return;
        if (which === "name") e.name = ev.target.value;
        else e.timeout = ev.target.value;
        e.message = null;
        this._drawEditor();
    }

    _onEditorChange(ev) {
        if (ev.target.dataset?.config) return this._onConfigChange(ev.target);
        const which = ev.target.dataset?.setting;
        const e = this._edit;
        if (!which || !e || e.layer !== "zone" || e.isNew || e.pending) return;
        const endpoint = this._mqtt?.zoneEndpoints?.[e.id];
        if (endpoint == null) return;
        const name = this._zoneName(e.id);
        if (which === "sensitivity") {
            const value = ev.target.value;
            if (!["low", "medium", "high"].includes(value)) return;
            return this._send({[`presence_sensitivity_${endpoint}`]: value}, {kind: "setting", id: e.id, key: "sensitivity", value, label: `Setting the sensitivity of ${name}…`, done: `${name}: sensitivity ${value}.`});
        }
        const value = Math.round(Number(ev.target.value));
        if (ev.target.value === "" || !Number.isFinite(value) || value < 0 || value > 300) {
            e.message = {kind: "error", text: "The absence timeout must be 0 to 300 s."};
            return this._drawEditor();
        }
        this._send({[`absence_timeout_${endpoint}`]: value}, {kind: "setting", id: e.id, key: "timeout", value, label: `Setting the absence timeout of ${name}…`, done: `${name}: absence timeout ${value} s.`});
    }

    /** A control of the settings panel changed: write it (checked first, so nothing out of range is sent). */
    _onConfigChange(input) {
        const p = this._panel;
        const def = SETTINGS.find((d) => d.key === input.dataset.config);
        if (!p || !def || this._busy) return;
        let value;
        if (def.type === "switch") value = input.checked ? "ON" : "OFF";
        else if (def.type === "enum") {
            value = input.value;
            if (!def.values.includes(value)) return;
        } else {
            value = Number(input.value);
            if (input.value.trim() === "" || !Number.isInteger(value) || value < def.min || value > def.max) {
                p.message = {kind: "error", text: `${def.label} must be a whole number from ${def.min} to ${def.max} ${def.unit}.`};
                return this._drawEditor();
            }
        }
        const shown = def.type === "number" ? `${value} ${def.unit}` : def.type === "switch" ? (value === "ON" ? "on" : "off") : pretty(value);
        this._send({[def.key]: value}, {kind: "config", key: def.key, value, label: `Setting ${def.label.toLowerCase()} to ${shown}…`, done: `${def.label}: ${shown}.`}, p);
    }

    /**
     * Publishes one write for `owner` (the editor, the settings panel or a dot's popover) and waits for the device's
     * confirmation (see _checkPending), an error, or a timeout. One write at a time.
     */
    _send(payload, pending, owner = this._edit) {
        if (!owner || this._busy) return;
        owner.pending = pending;
        owner.message = {kind: "info", text: pending.label};
        this._busy = owner;
        this._redrawUi();
        this._watchErrors();
        clearTimeout(this._pendingTimer);
        this._pendingTimer = setTimeout(
            () =>
                pending.timeoutText
                    ? this._finishPending(true, pending.timeoutText, "info")
                    : this._finishPending(false, "No confirmation from the sensor within 20 s. If it comes later the map updates; otherwise see the Zigbee2MQTT log."),
            pending.timeout || 20000,
        );
        Promise.resolve()
            .then(() => this._hass.callService("mqtt", "publish", {topic: `${this._config.topic}/set`, payload: JSON.stringify(payload)}))
            .catch((err) => this._finishPending(false, `Could not send the command: ${err?.message || err}`));
    }

    _checkPending() {
        const p = this._busy?.pending;
        const snap = this._mqtt;
        if (!p || !snap) return;
        let done = false;
        const soft = () => snap.softwareZones?.find((z) => z.id === p.id);
        if (p.kind === "save") done = this._zones().some((z) => z.id === p.id && bitsToHex(z.bits) === p.hex);
        else if (p.kind === "delete") done = Boolean(snap.zones) && !this._zones().some((z) => z.id === p.id);
        else if (p.kind === "setting") done = snap.zoneSettings?.[p.id]?.[p.key] === p.value;
        else if (p.kind === "area") done = String(snap.masks?.[AREAS[p.layer].mask] ?? "").toLowerCase() === p.hex;
        else if (p.kind === "soft") done = sameSoftwareZone(soft()?.config, p.zone);
        else if (p.kind === "soft-delete") done = Boolean(soft()) && soft().config === null;
        else if (p.kind === "config") done = p.key in snap.settings && sameSetting(snap.settings[p.key], p.value);
        else if (p.kind === "forget") done = Array.isArray(snap.targets) && !snap.targets.some((t) => t.id === p.id);
        if (done) this._finishPending(true, p.done);
    }

    _finishPending(ok, text, kind = ok ? "ok" : "error") {
        const owner = this._busy;
        if (!owner?.pending) return;
        const p = owner.pending;
        clearTimeout(this._pendingTimer);
        this._stopErrorWatch();
        owner.pending = null;
        this._busy = null;
        const message = {kind, text};
        if (owner === this._edit) {
            if (ok && p.kind === "save") return this._openEditor(p.id, message); // the confirmed cells become the saved state
            if (ok && p.kind === "area") return this._openLayer(p.layer, message);
            if (ok && p.kind === "delete") {
                const rest = this._zones().filter((z) => z.id !== p.id);
                return this._openEditor(rest.length ? rest[0].id : this._newZoneId(), message);
            }
            if (ok && p.kind === "soft") return this._openSoftware(p.id, message);
            if (ok && p.kind === "soft-delete") return this._openSoftware(this._firstSoftId(), message);
        }
        owner.message = message;
        this._redrawUi();
    }

    /** Drops a write still waiting (the card is reconfigured, or the editor that sent it closed). */
    _cancelPending() {
        clearTimeout(this._pendingTimer);
        this._stopErrorWatch();
        if (this._busy) this._busy.pending = null;
        this._busy = null;
    }

    /* ── The popover of a dot (admins, live view): forget the target, or ignore the spot it is on ── */

    _popAllowed() {
        return this._writesAllowed() && !this._edit && Boolean(this._snap?.targets);
    }

    _openPop(id) {
        const d = this._dotAt.get(id);
        const t = this._snap?.targets?.find((x) => x.id === id);
        const ctm = this._el.svg.getScreenCTM();
        if (!d || !t || !ctm) return;
        const s = new DOMPoint(d.X, d.Y).matrixTransform(ctm);
        const box = this._el.map.getBoundingClientRect();
        this._pop = {id, x: t.x, y: t.y, left: s.x - box.left, top: s.y - box.top, gap: d.r * ctm.a + 6, pending: null, message: null};
        document.addEventListener("pointerdown", this._onOutside, true);
        document.addEventListener("keydown", this._onKey);
        this._drawPopover();
    }

    _closePop() {
        if (!this._pop) return;
        this._pop = null;
        document.removeEventListener("pointerdown", this._onOutside, true);
        document.removeEventListener("keydown", this._onKey);
        this._drawPopover();
    }

    _drawPopover() {
        const el = this._el?.pop;
        if (!el) return;
        const p = this._pop;
        if (!p) {
            el.hidden = true;
            return this._set(el, "");
        }
        const t = this._snap?.targets?.find((x) => x.id === p.id);
        const busy = Boolean(this._busy);
        const zone = t?.zone ? ` · ${esc(this._zoneName(t.zone))}` : "";
        const sub = t ? `At x ${p.x} cm, y ${p.y} cm${zone}` : "No longer reported.";
        const canIgnore = this._layerAvailable("interference");
        const html =
            `<div class="t"><span class="sw" style="background:${this._color(p.id)}"></span>Target ${p.id}</div><div class="sub">${sub}</div>` +
            `<div class="bar"><button class="btn" data-action="forget" title="The sensor drops this target from its list; a real person is found again"${busy || !t ? " disabled" : ""}>Forget this target</button>` +
            `<button class="btn" data-action="ignore" title="Mark the 1 × 1 m around it as interference, to look at and save"${busy || !canIgnore ? " disabled" : ""}>Ignore this spot</button></div>` +
            `<div class="hint">Forget suits a ghost: a real person is found again. Ignore adds the cells around it to the interference area, for you to save.</div>` +
            (p.message ? `<div class="msg ${p.message.kind}">${esc(p.message.text)}</div>` : "");
        this._set(el, html);
        el.hidden = false;
        // Next to the dot, inside the map: right of it if there is room, else left; below it, else above.
        const W = this._el.map.clientWidth;
        const H = this._el.map.clientHeight;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const left = p.left + p.gap + w <= W - 4 ? p.left + p.gap : p.left - p.gap - w;
        const top = p.top + h <= H - 4 ? p.top : p.top - h;
        el.style.left = `${clamp(left, 4, Math.max(4, W - w - 4))}px`;
        el.style.top = `${clamp(top, 4, Math.max(4, H - h - 4))}px`;
    }

    _onPopClick(ev) {
        const button = ev.target.closest?.("button[data-action]");
        const p = this._pop;
        if (!button || button.disabled || !p) return;
        if (button.dataset.action === "forget") {
            return this._send(
                {remove_target: p.id},
                {
                    kind: "forget",
                    id: p.id,
                    label: `Asking the sensor to forget target ${p.id}…`,
                    done: `Target ${p.id} forgotten.`,
                    timeout: 8000,
                    timeoutText: `Sent. The sensor still reports target ${p.id}: someone may really be there.`,
                },
                p,
            );
        }
        if (button.dataset.action === "ignore") {
            const {id, x, y} = p;
            this._closePop();
            this._panel = null;
            this._openLayer("interference", {kind: "info", text: `Added the cells around target ${id}. Save to make the sensor ignore movement there.`});
            if (!this._edit) return;
            for (const i of cellsAround(x, y)) this._edit.draft[i] = 1;
            this._redrawEdit();
        }
    }

    /**
     * While a write is pending: Zigbee2MQTT's error for this device, from bridge/logging (info and up, never debug), e.g.
     * {"level":"error","message":"z2m: Publish 'set' 'native_zone' to '<device>' failed: 'Error: <reason>'"}.
     * Zigbee2MQTT skips a log message identical to the one before it, so the same failure twice in a row with nothing
     * logged between ends in the 20 s timeout instead.
     */
    _watchErrors() {
        const c = this._config;
        if (this._errSub || !c.base_topic || !c.device) return;
        const marker = `to '${c.device}' failed: `;
        this._errSub = Promise.resolve()
            .then(() =>
                this._hass.connection.subscribeMessage(
                    (m) => {
                        let log;
                        try {
                            log = JSON.parse(m.payload);
                        } catch {
                            return;
                        }
                        if (log?.level !== "error" || typeof log.message !== "string" || !log.message.includes(marker)) return;
                        const reason = log.message.slice(log.message.indexOf(marker) + marker.length).replace(/^'|'$/g, "").replace(/^Error: /, "");
                        this._finishPending(false, `Not applied: ${reason}`);
                    },
                    {type: "mqtt/subscribe", topic: `${c.base_topic}/bridge/logging`},
                ),
            )
            .catch(() => null);
    }

    _stopErrorWatch() {
        const sub = this._errSub;
        this._errSub = null;
        if (sub) sub.then((unsub) => unsub && Promise.resolve(unsub()).catch(() => {}));
    }

    _noteText(snap) {
        const c = this._config;
        if (this._mode === "starting") return "Connecting…";
        if (this._mode === "mqtt") {
            if (!this._mqtt) return `Listening to ${c.topic}; showing Home Assistant's values until the sensor reports.`;
            if (!snap.targets) return "Tracking is off. Turn on the device's tracking option in Zigbee2MQTT to see positions.";
            return `Live from Zigbee2MQTT (${c.topic}). Positions stay in this browser.`;
        }
        const reason =
            this._why === "admin"
                ? "zone outlines need an admin account"
                : this._why === "no topic configured"
                  ? "no topic is configured, so zone outlines are not shown"
                  : `could not listen to Zigbee2MQTT (${this._why}), so zone outlines are not shown`;
        if (!snap.targets) {
            const id = this._positionEntityId();
            const exists = Boolean(this._hass?.states[id]);
            return `Reduced view: ${reason}. ${exists ? "No positions yet." : `No position entity (${id}): is tracking on?`}`;
        }
        return `Reduced view from Home Assistant entities: ${reason}.`;
    }
}

if (typeof customElements !== "undefined" && !customElements.get(TAG)) {
    customElements.define(TAG, Fp400MapCard);
    window.customCards = window.customCards || [];
    window.customCards.push({type: TAG, name: "Aqara FP400 map", description: "Room map with the FP400's areas, zones and tracked people", preview: false});
    console.info(`%c ${TAG} %c ${VERSION} `, "background:#2a78d6;color:#fff;border-radius:3px 0 0 3px", "background:#52514e;color:#fff;border-radius:0 3px 3px 0");
}
