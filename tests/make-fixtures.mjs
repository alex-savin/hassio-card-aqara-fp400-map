// node tests/make-fixtures.mjs — writes the made-up example rooms and recorded-style fixtures the tests use.
// Nothing here comes from a real home: two invented rooms, and people walking scripted paths with seeded noise.
// The output is deterministic, so running it again reproduces the committed files.
import {writeFileSync} from "node:fs";
import {bitsToHex, CELLS, COLS, cellAt, invertBits, roomCells, ZONE_ENDPOINTS} from "../fp400-map-card.js";

const out = (path, value) => writeFileSync(new URL(path, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
/** A list of messages, one per line: small, and a diff shows which message changed. */
const outLines = (path, list) => writeFileSync(new URL(path, import.meta.url), `[\n${list.map((m) => JSON.stringify(m)).join(",\n")}\n]\n`);

/** mulberry32: a small seeded generator, so every run gives the same files. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A mask from cells given as [row, column] pairs. */
function mask(cells) {
    const bits = new Uint8Array(CELLS);
    for (const [r, c] of cells) bits[r * COLS + c] = 1;
    return bitsToHex(bits);
}
/** Every [row, column] of a block of rows and columns. */
const block = (r0, r1, c0, c1) => {
    const cells = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push([r, c]);
    return cells;
};
const cm = (points) => points.map(([x, y]) => [x / 10, y / 10]);
const time = (start, s) => new Date(Date.parse(start) + s * 1000).toISOString().replace("T", " ").slice(0, 19);

/* ── The lounge: a wall-mounted sensor at the middle of the near wall, three native zones ── */

// Sensor frame, mm: x across (negative to the sensor's left), y out from the sensor.
const lounge = {
    type: "custom:fp400-map-card",
    title: "Lounge",
    topic: "zigbee2mqtt/fp400_lounge",
    entity_prefix: "fp400_lounge",
    rotation: 180,
    zones: {1: "Table", 2: "Sofa", 3: "Armchair"},
    room: {
        outline_mm: [
            [-1950, -100],
            [2450, -100],
            [2450, 4420],
            [-1950, 4420],
        ],
        features: [
            {type: "door", name: "Entrance", points_mm: [[2450, 600], [2450, 1500]]},
            {type: "opening", name: "Hall", points_mm: [[-1950, 1600], [-1950, 2900]]},
            {type: "window", name: "Window", points_mm: [[-900, 4420], [1100, 4420]]},
            {type: "furniture", name: "Table", points_mm: [[800, 1300], [1700, 1300], [1700, 2200], [800, 2200]]},
            {type: "furniture", name: "Sofa", points_mm: [[1500, 3300], [2400, 3300], [2400, 4300], [1500, 4300]]},
            {type: "furniture", name: "Armchair", points_mm: [[-1800, 3400], [-1000, 3400], [-1000, 4200], [-1800, 4200]]},
            {type: "furniture", name: "Bookcase", points_mm: [[-1950, 3000], [-1650, 3000], [-1650, 3300], [-1950, 3300]], label: false},
            {type: "fixture", name: "Fan", points_mm: [[-1900, 600], [-1600, 600], [-1600, 900], [-1900, 900]]},
        ],
    },
    grid_options: {columns: 12, rows: "auto"},
};

// Native zones, as [row, column] blocks: Table rows 2-4 columns 4-6 (x 50..200, y 100..250), Sofa rows 6-8 columns 3-5
// (x 100..250, y 300..450), Armchair rows 6-8 columns 9-11 (x -200..-50, y 300..450).
const loungeZones = [
    {zone_id: 1, cells: block(2, 4, 4, 6)},
    {zone_id: 2, cells: block(6, 8, 3, 5)},
    {zone_id: 3, cells: block(6, 8, 9, 11)},
].map((z) => ({...z, bits: new Set(z.cells.map(([r, c]) => r * COLS + c))}));

const loungeMasks = {
    // The monitored area is the room: the cells at least half inside its outline (81 cells, rows 0-8, columns 3-11).
    edge_mask_hex: bitsToHex(invertBits(roomCells(cm(lounge.room.outline_mm)))),
    // The door (rows 1-2 at the right wall) and the opening to the hall (rows 3-5 at the left wall).
    entry_exit_mask_hex: mask([[1, 3], [2, 3], [3, 11], [4, 11], [5, 11]]),
    // The fan in the near left corner.
    interference_mask_hex: mask([[1, 11], [2, 11]]),
};

/**
 * People in the lounge: waypoints [second, x, y] in cm; between two waypoints a person walks in a straight line, and
 * where two waypoints share a position they sit still. Each appears at its first waypoint and is gone after its last.
 */
const loungePeople = [
    // Comes in from the hall, crosses the room near the table (walking at second 60), sits at the table, leaves by the door.
    {id: 0, path: [[52, -185, 230], [57, -40, 205], [61, 50, 185], [64, 130, 170], [200, 130, 170], [203, 200, 130], [206, 238, 105]]},
    // Comes in by the door and sits on the sofa, then leaves through the hall.
    {id: 1, path: [[90, 238, 110], [93, 215, 250], [96, 195, 380], [295, 195, 380], [299, 40, 300], [304, -185, 240]]},
    // Comes in from the hall to the armchair, then crosses to the door.
    {id: 2, path: [[130, -185, 260], [134, -140, 380], [250, -140, 380], [253, -40, 260], [257, 120, 120], [260, 238, 95]]},
    // Walks to the window, looks out for a few seconds and leaves again.
    {id: 3, path: [[340, 238, 120], [344, 100, 300], [347, 20, 410], [353, 20, 410], [357, 150, 260], [360, 238, 105]]},
];

/** Where a person is at second `s` (undefined when not in the room), and whether they are walking. */
function position(person, s) {
    const p = person.path;
    if (s < p[0][0] || s > p.at(-1)[0]) return undefined;
    for (let i = 1; i < p.length; i++) {
        const [t0, x0, y0] = p[i - 1];
        const [t1, x1, y1] = p[i];
        if (s > t1) continue;
        const f = t1 === t0 ? 0 : (s - t0) / (t1 - t0);
        const speed = t1 === t0 ? 0 : Math.hypot(x1 - x0, y1 - y0) / (t1 - t0);
        return {x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, speed, leaving: s > p.at(-1)[0] - 2};
    }
}

function zoneOf(zones, x, y) {
    const cell = cellAt(x, y);
    return zones.find((z) => z.bits.has(cell))?.zone_id ?? 0;
}

function stream({people, zones, seconds, start, base, rand}) {
    const messages = [];
    const lastSeen = {room: -Infinity};
    for (const z of zones) lastSeen[z.zone_id] = -Infinity;
    const present = new Set();
    for (let s = 0; s < seconds; s++) {
        const targets = [];
        for (const person of people) {
            const at = position(person, s);
            if (!at) continue;
            // The sensor's positions wander a little even for someone sitting still.
            const jitter = at.speed ? 6 : 3;
            const x = Math.round(at.x + (rand() - 0.5) * jitter * 2);
            const y = Math.round(at.y + (rand() - 0.5) * jitter * 2);
            const t = {id: person.id, x, y, zone: zoneOf(zones, x, y), speed: at.speed ? Math.max(1, Math.round(at.speed + (rand() - 0.5) * 8)) : 0};
            if (at.leaving) t.leaving = true;
            targets.push(t);
        }
        const payload = {...base, illuminance_2: base.illuminance_2 + Math.round((rand() - 0.5) * 6), linkquality: base.linkquality + Math.round((rand() - 0.5) * 20)};
        const ids = new Set(targets.map((t) => t.id));
        if ([...ids].some((id) => !present.has(id))) payload.action = "enter";
        else if ([...present].some((id) => !ids.has(id))) payload.action = "leave";
        present.clear();
        for (const id of ids) present.add(id);
        if (targets.length) lastSeen.room = s;
        // Occupancy holds for the absence timeout (10 s) after the last detection, as the sensor reports it.
        payload.occupancy_1 = s - lastSeen.room < payload.absence_timeout;
        payload.human_count = targets.filter((t) => !t.leaving).length;
        payload.activity_state = targets.length === 0 ? "none" : targets.some((t) => t.speed) ? "active" : "still";
        // Per zone endpoint, as firmware 63 answers: endpoint N carries zone N - 2, and those without a zone answer too.
        for (const n of ZONE_ENDPOINTS) {
            const zoneId = n - 2;
            const inside = zones.some((z) => z.zone_id === zoneId) ? targets.filter((t) => t.zone === zoneId) : [];
            if (inside.length) lastSeen[zoneId] = s;
            payload[`human_count_${n}`] = inside.length;
            payload[`occupancy_${n}`] = s - (lastSeen[zoneId] ?? -Infinity) < payload[`absence_timeout_${n}`];
        }
        payload.target_count = targets.length;
        payload.targets = targets;
        payload.targets_xy = targets.map((t) => `${t.id}:${t.x}:${t.y}`).join(";") || "none";
        payload.tracking_status = "valid";
        messages.push({time: time(start, s), payload: Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))});
    }
    return messages;
}

const settings = {
    absence_timeout: 10,
    ai_adaptive_sensitivity: "ON",
    ai_entry_exit_recognition: "ON",
    ai_high_precision: "OFF",
    ai_interference_recognition: "ON",
    coordinate_reverse: "auto",
    detection_direction: "omnidirectional",
    human_count_enabled: "ON",
    installation_height_max: 0,
    installation_height_min: 0,
    installation_mode: "wall",
    presence_sensitivity: "high",
    proximity_distance: "medium",
    update: {installed_version: -1, latest_version: -1},
    // Every zone endpoint, with or without a zone: the zone it carries and its two settings.
    ...Object.fromEntries(ZONE_ENDPOINTS.flatMap((n) => [[`zone_id_${n}`, n - 2], [`absence_timeout_${n}`, 10], [`presence_sensitivity_${n}`, "medium"]])),
};

const loungeBase = {
    ...settings,
    ...loungeMasks,
    illuminance_2: 210,
    installation_angle: 12,
    installation_height: 2100,
    installation_status: "side_facing_forward",
    linkquality: 150,
    native_zones: loungeZones.map((z) => ({zone_id: z.zone_id, mask_hex: mask(z.cells), enabled: true})),
    side_installation: "wall",
};

out("../examples/lounge.json", lounge);
outLines("./fixtures/payloads.json", stream({people: loungePeople, zones: loungeZones, seconds: 400, start: "2026-01-15T18:00:00Z", base: loungeBase, rand: random(400)}));

/* ── The study: a sensor in a corner, never given a zone ── */

// The room in its own frame: 4.5 m along the right-hand wall (u) and 3.8 m along the left-hand one (v), the sensor in the
// corner where they meet, looking along the diagonal. In the sensor frame both walls run at 45° to its axis.
const s45 = Math.SQRT1_2;
const fromRoom = (u, v) => [Math.round((u - v) * s45), Math.round((u + v) * s45 - 100)];
const study = {
    type: "custom:fp400-map-card",
    title: "Study",
    topic: "zigbee2mqtt/fp400_study",
    entity_prefix: "fp400_study",
    // Turns the room square on screen: its walls run at 45° in the sensor frame.
    rotation: -45,
    room: {
        outline_mm: [fromRoom(0, 0), fromRoom(4500, 0), fromRoom(4500, 3800), fromRoom(0, 3800)],
        features: [
            {type: "door", name: "Door", points_mm: [fromRoom(4500, 2600), fromRoom(4500, 3500)]},
            {type: "window", name: "Window", points_mm: [fromRoom(1200, 3800), fromRoom(3200, 3800)]},
            {type: "furniture", name: "Desk", points_mm: [fromRoom(300, 2900), fromRoom(1900, 2900), fromRoom(1900, 3700), fromRoom(300, 3700)]},
            {type: "furniture", name: "Chair", points_mm: [fromRoom(800, 2300), fromRoom(1400, 2300), fromRoom(1400, 2800), fromRoom(800, 2800)]},
            {type: "furniture", name: "Bookcase", points_mm: [fromRoom(3200, 100), fromRoom(4400, 100), fromRoom(4400, 450), fromRoom(3200, 450)]},
        ],
    },
    grid_options: {columns: 12, rows: "auto"},
};
const studyCm = (u, v) => fromRoom(u, v).map((n) => n / 10);
const studyPeople = [
    // At the desk the whole time, working.
    {id: 0, path: [[0, ...studyCm(1100, 2550)], [60, ...studyCm(1100, 2550)]]},
    // Walking between the door and the bookcase.
    {id: 1, path: [[0, ...studyCm(4200, 3000)], [10, ...studyCm(3800, 900)], [16, ...studyCm(3800, 700)], [28, ...studyCm(3000, 2000)], [39, ...studyCm(4200, 3100)], [60, ...studyCm(4200, 3100)]]},
    // Coming in later and standing by the window.
    {id: 2, path: [[12, ...studyCm(4300, 3200)], [24, ...studyCm(2400, 3300)], [60, ...studyCm(2300, 3350)]]},
];
const studyBase = {
    ...settings,
    edge_mask_hex: bitsToHex(invertBits(roomCells(cm(study.room.outline_mm)))),
    entry_exit_mask_hex: mask([[cellAt(...studyCm(4500, 3050)) >> 4, cellAt(...studyCm(4500, 3050)) & 15]]),
    interference_mask_hex: "0".repeat(80),
    illuminance_2: 95,
    installation_angle: 20,
    installation_height: 2200,
    installation_status: "tilted_facing_down",
    linkquality: 130,
    mcu_version: "62",
    side_installation: "left_corner",
};
out("../examples/study.json", study);
// Everyone is still there when the 40 s end, so nobody is marked leaving here.
outLines("./fixtures/no-zones.json", stream({people: studyPeople, zones: [], seconds: 40, start: "2026-01-15T20:00:00Z", base: studyBase, rand: random(40)}));
