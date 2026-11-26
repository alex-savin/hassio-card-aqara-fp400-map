// node --test tests/  (Node 20+, no dependencies)
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
    bitsToHex,
    CELLS,
    cellsAround,
    inSoftwareZone,
    parseSoftwareZone,
    sameSetting,
    sameSoftwareZone,
    SETTINGS,
    snapTo,
    softwareZoneCorners,
    COLS,
    cellAt,
    cellBox,
    cellRuns,
    entityIds,
    inverseTransform,
    invertBits,
    rectCells,
    roomCells,
    zoneCheck,
    maskBits,
    normalizeConfig,
    outlineSegments,
    parseTargets,
    parseTargetsText,
    parseTargetsXy,
    targetsTextCut,
    parseZones,
    snapshotFromPayload,
    snapshotFromStates,
    viewTransform,
} from "../fp400-map-card.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/payloads.json", import.meta.url)));
const lounge = JSON.parse(readFileSync(new URL("../examples/lounge.json", import.meta.url)));
const last = fixtures[fixtures.length - 1].payload;
const cellOf = (x, y) => Math.floor(y / 50) * COLS + Math.floor((400 - x) / 50);
const setCells = (bits) => [...bits.keys()].filter((i) => bits[i]);

test("mask layout: bit 0 is the most significant bit of byte 0, row 0 column 0 at x = +350..+400", () => {
    const bits = maskBits(`80${"0".repeat(78)}`);
    assert.deepEqual(setCells(bits), [0]);
    assert.deepEqual(cellBox(0), {r: 0, c: 0, x0: 350, x1: 400, y0: 0, y1: 50});
    assert.deepEqual(cellBox(7), {r: 0, c: 7, x0: 0, x1: 50, y0: 0, y1: 50});
    assert.deepEqual(cellBox(8), {r: 0, c: 8, x0: -50, x1: 0, y0: 0, y1: 50});
    assert.deepEqual(setCells(maskBits(`${"0".repeat(78)}01`)), [CELLS - 1]);
    assert.equal(maskBits("abc"), null);
    assert.equal(maskBits(`zz${"0".repeat(78)}`), null);
    assert.equal(maskBits(null), null);
});

test("the lounge's monitored area (edge mask cleared cells) is x -200..+250, y 0..450", () => {
    const edge = maskBits(last.edge_mask_hex);
    const monitored = setCells(edge.map((b) => 1 - b)).map(cellBox);
    assert.equal(Math.min(...monitored.map((b) => b.x0)), -200);
    assert.equal(Math.max(...monitored.map((b) => b.x1)), 250);
    assert.equal(Math.min(...monitored.map((b) => b.y0)), 0);
    assert.equal(Math.max(...monitored.map((b) => b.y1)), 450);
});

test("zones decode to the cells written for them (Table, Sofa, Armchair)", () => {
    const zones = parseZones(last.native_zones);
    assert.deepEqual(zones.map((z) => z.id), [1, 2, 3]);
    const span = (z) => {
        const boxes = setCells(z.bits).map(cellBox);
        return [Math.min(...boxes.map((b) => b.x0)), Math.max(...boxes.map((b) => b.x1)), Math.min(...boxes.map((b) => b.y0)), Math.max(...boxes.map((b) => b.y1))];
    };
    assert.deepEqual(span(zones[0]), [50, 200, 100, 250]); // Table: rows 2-4, columns 4-6
    assert.deepEqual(span(zones[1]), [100, 250, 300, 450]); // Sofa: rows 6-8, columns 3-5
    assert.deepEqual(span(zones[2]), [-200, -50, 300, 450]); // Armchair: rows 6-8, columns 9-11
});

test("the card's cell geometry agrees with the sensor's own zone for each reported target", () => {
    const zones = new Map(parseZones(last.native_zones).map((z) => [z.id, z.bits]));
    let checked = 0;
    let agree = 0;
    for (const {payload} of fixtures) {
        for (const t of payload.targets || []) {
            if (!t.zone || !zones.has(t.zone)) continue;
            checked++;
            const i = cellOf(t.x, t.y);
            if (i >= 0 && i < CELLS && zones.get(t.zone)[i]) agree++;
        }
    }
    assert.ok(checked > 50, `only ${checked} targets in a zone`);
    // A target on a cell boundary can round either way; a mirrored or shifted grid would agree far less.
    assert.ok(agree / checked >= 0.9, `${agree} of ${checked} targets fall in their reported zone`);
    const mirrored = (x, y) => Math.floor(y / 50) * COLS + Math.floor((400 + x) / 50);
    let agreeMirrored = 0;
    for (const {payload} of fixtures) for (const t of payload.targets || []) if (t.zone && zones.get(t.zone)?.[mirrored(t.x, t.y)]) agreeMirrored++;
    assert.ok(agreeMirrored < agree * 0.6, `mirrored grid agrees ${agreeMirrored} times vs ${agree}`);
});

test("cell runs and outlines", () => {
    const bits = new Uint8Array(CELLS);
    for (const i of [0, 1, COLS, COLS + 1]) bits[i] = 1; // a 2 x 2 block in the corner
    assert.deepEqual(cellRuns(bits), [
        {x0: 300, x1: 400, y0: 0, y1: 50},
        {x0: 300, x1: 400, y0: 50, y1: 100},
    ]);
    const segments = outlineSegments(bits);
    assert.equal(segments.length, 8);
    for (const [x0, y0, x1, y1] of segments) {
        const onEdge = (x0 === x1 && (x0 === 300 || x0 === 400)) || (y0 === y1 && (y0 === 0 || y0 === 100));
        assert.ok(onEdge, `inner segment ${[x0, y0, x1, y1]}`);
    }
});

test("view transform: rotation 180 + mirror puts the sensor at the bottom, +x to the right", () => {
    const T = viewTransform(180, true);
    assert.deepEqual(T(100, 0), [100, 0]);
    assert.deepEqual(T(0, 100), [0, -100]);
    assert.deepEqual(viewTransform(0, false)(30, 40), [30, 40]);
    assert.deepEqual(viewTransform(90, false)(0, 100), [-100, 0]);
});

test("targets: payload list and targets_xy text", () => {
    assert.deepEqual(parseTargets([{id: 0, speed: 18, x: 120, y: 175, zone: 1}, {id: 2, x: -40, y: 260}]), [
        {id: 0, x: 120, y: 175, zone: 1, speed: 18},
        {id: 2, x: -40, y: 260},
    ]);
    assert.equal(parseTargets(undefined), null);
    assert.deepEqual(parseTargets([]), []);
    assert.deepEqual(parseTargetsXy("0:120:175;2:-40:260"), [
        {id: 0, x: 120, y: 175},
        {id: 2, x: -40, y: 260},
    ]);
    assert.deepEqual(parseTargetsXy("0:-5:310"), [{id: 0, x: -5, y: 310}]);
    assert.deepEqual(parseTargetsXy("none"), []);
    assert.equal(parseTargetsXy("unknown"), null);
    assert.equal(parseTargetsXy("0:1"), null);
    assert.equal(parseTargetsXy("0:1:2;junk"), null);
});

test("targets entity text: Python or JSON, cut at 255 characters", () => {
    // How Home Assistant shows the list (made-up positions).
    const text = "[{'id': 0, 'x': 120, 'y': 175, 'zone': 1}, {'id': 2, 'x': -40, 'y': 260, 'zone': 0, 'speed': 3, 'leaving': False}]";
    assert.deepEqual(parseTargetsText(text), [
        {id: 0, x: 120, y: 175, zone: 1},
        {id: 2, x: -40, y: 260, zone: 0, speed: 3, leaving: false},
    ]);
    assert.equal(targetsTextCut(text), false);
    assert.deepEqual(parseTargetsText('[{"id": 5, "x": -7, "y": 300}]'), [{id: 5, x: -7, y: 300}]);
    assert.deepEqual(parseTargetsText("[]"), []);
    // Cut inside the second target: the first is kept, the second left out.
    const cut = "[{'id': 0, 'x': 120, 'y': 175, 'zone': 1}, {'id': 2, 'x': -4";
    assert.deepEqual(parseTargetsText(cut), [{id: 0, x: 120, y: 175, zone: 1}]);
    assert.equal(targetsTextCut(cut), true);
    for (const unknown of [null, undefined, "", "unknown", "unavailable"]) assert.equal(parseTargetsText(unknown), null);
});

test("every fixture's targets_xy matches its targets list", () => {
    for (const {payload} of fixtures) {
        const xy = parseTargetsXy(payload.targets_xy);
        assert.deepEqual(
            xy,
            payload.targets.map((t) => ({id: t.id, x: t.x, y: t.y})),
        );
    }
});

test("snapshot from a Zigbee2MQTT message", () => {
    const withPeople = fixtures.find((f) => f.payload.targets.length === 3).payload;
    const s = snapshotFromPayload(withPeople);
    assert.equal(s.source, "mqtt");
    assert.equal(s.targets.length, 3);
    assert.equal(s.zones.length, 3);
    assert.equal(typeof s.presence, "boolean");
    // Every zone endpoint answers (firmware 63), so there is state for zones 1-8; the zone list says 1-3 exist.
    assert.deepEqual(Object.keys(s.zoneState).sort(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
    assert.ok(Object.values(s.zoneState).some((z) => z.occupied === true));
    const empty = snapshotFromPayload(last);
    assert.deepEqual(empty.targets, []);
    assert.equal(empty.presence, false);
    assert.equal(empty.zoneState[3].occupied, false);
    assert.equal(snapshotFromPayload({linkquality: 9}).targets, null); // tracking never on
});

test("zone state and settings come per endpoint, keyed by the zone it carries", () => {
    const s = snapshotFromPayload({zone_id_3: 2, occupancy_3: true, human_count_3: 1, presence_sensitivity_3: "high", absence_timeout_3: 30, zone_id_4: 0, occupancy_4: true, zone_id_5: 9, zone_id_6: "1"});
    assert.deepEqual(s.zoneState, {2: {occupied: true, count: 1}});
    assert.deepEqual(s.zoneSettings, {2: {sensitivity: "high", timeout: 30}});
    assert.deepEqual(s.zoneEndpoints, {2: 3});
    const last8 = snapshotFromPayload(last);
    assert.deepEqual(last8.zoneEndpoints, {1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 9, 8: 10});
    assert.deepEqual(last8.zoneSettings[1], {sensitivity: "medium", timeout: 10});
    assert.equal(snapshotFromPayload({}).zones, null); // no zone list read yet
});

test("snapshot from Home Assistant entities (the reduced view)", () => {
    const ids = entityIds("fp400_lounge");
    const states = {
        [ids.presence]: {state: "on"},
        [ids.human_count]: {state: "2"},
        [ids.targets_xy]: {state: "0:120:175;2:-40:260"},
        [ids.edge_mask]: {state: last.edge_mask_hex},
        // Endpoint 3 carries zone 1, endpoint 4 zone 2; endpoint 6 is unknown, endpoint 5 has not said its zone.
        [ids.zone_id(3)]: {state: "1"},
        [ids.zone_occupancy(3)]: {state: "on"},
        [ids.zone_count(3)]: {state: "2"},
        [ids.zone_id(4)]: {state: "2"},
        [ids.zone_occupancy(4)]: {state: "off"},
        [ids.zone_occupancy(5)]: {state: "on"},
        [ids.zone_id(6)]: {state: "4"},
        [ids.zone_occupancy(6)]: {state: "unknown"},
    };
    assert.equal(ids.zone_occupancy(3), "binary_sensor.fp400_lounge_occupancy_3");
    assert.equal(ids.zone_count(3), "sensor.fp400_lounge_human_count_3");
    assert.equal(ids.zone_id(3), "sensor.fp400_lounge_zone_id_3");
    const s = snapshotFromStates(states, ids);
    assert.equal(s.source, "entities");
    assert.equal(s.presence, true);
    assert.equal(s.humanCount, 2);
    assert.equal(s.targets.length, 2);
    assert.equal(s.zones, null);
    assert.deepEqual(s.zoneState, {1: {occupied: true, count: 2}, 2: {occupied: false, count: null}});
    assert.equal(s.masks.edge, last.edge_mask_hex);
    assert.equal(snapshotFromStates({}, ids).targets, null);
    // Newer converters have a targets entity; it comes first, and a cut one makes the report partial.
    const list = {...states, [ids.targets]: {state: "[{'id': 7, 'x': 10, 'y': 200, 'zone': 0}, {'id': 8, 'x"}};
    const fromList = snapshotFromStates(list, ids);
    assert.deepEqual(fromList.targets, [{id: 7, x: 10, y: 200, zone: 0}]);
    assert.equal(fromList.tracking, "partial");
    assert.equal(snapshotFromStates({...states, [ids.targets]: {state: "[]"}}, ids).tracking, null);
    assert.equal(snapshotFromStates({...states, [ids.targets]: {state: "unknown"}}, ids).targets.length, 2);
    assert.equal(entityIds("dev", {targets_xy: "sensor.other", zone_count: "nope"}).targets_xy, "sensor.other");
    assert.equal(typeof entityIds("dev", {zone_count: "nope"}).zone_count, "function");
});

test("configuration", () => {
    const c = normalizeConfig(lounge);
    assert.equal(c.prefix, "fp400_lounge");
    assert.deepEqual(c.room.outline[0], [-195, -10]); // mm → cm
    assert.equal(c.room.features.length, 8);
    assert.equal(c.room.features.find((f) => f.name === "Table").closed, true);
    assert.equal(c.room.features.find((f) => f.name === "Entrance").closed, false);
    assert.equal(normalizeConfig({topic: "zigbee2mqtt/dev"}).prefix, "dev");
    assert.throws(() => normalizeConfig({}), /topic/);
    assert.throws(() => normalizeConfig({topic: "zigbee2mqtt/#"}), /wildcards/);
    assert.throws(() => normalizeConfig({topic: "t/d", room: {features: [{type: "sofa", points_mm: [[0, 0], [1, 1], [2, 2]]}]}}), /type must be/);
    assert.throws(() => normalizeConfig({topic: "t/d", room: {outline_mm: [[0, 0], [1, "x"], [2, 2]]}}), /outline_mm\[1\]/);
});

/* ── Zone editor helpers ── */

test("bitsToHex is the inverse of maskBits, for every mask in the fixtures", () => {
    for (const hex of [last.edge_mask_hex, last.entry_exit_mask_hex, ...last.native_zones.map((z) => z.mask_hex)]) {
        assert.equal(bitsToHex(maskBits(hex)), hex);
    }
    // A zone of rows 5-6, columns 9-10.
    const bits = new Uint8Array(CELLS);
    for (const i of rectCells(5 * COLS + 9, 6 * COLS + 10)) bits[i] = 1;
    assert.equal(bitsToHex(bits), "00000000000000000000006000600000000000000000000000000000000000000000000000000000");
});

test("inverseTransform undoes viewTransform for every rotation and mirror", () => {
    for (const rotation of [0, 90, 180, 270, 33]) {
        for (const mirror of [false, true]) {
            const T = viewTransform(rotation, mirror);
            const back = inverseTransform(rotation, mirror);
            for (const [x, y] of [[0, 0], [125, 340], [-399, 999], [12.5, -7]]) {
                const [bx, by] = back(...T(x, y));
                assert.ok(Math.abs(bx - x) < 1e-9 && Math.abs(by - y) < 1e-9, `rotation ${rotation} mirror ${mirror}: (${x}, ${y}) → (${bx}, ${by})`);
            }
        }
    }
});

test("cellAt: the cell under a point, matching cellBox", () => {
    for (let i = 0; i < CELLS; i++) {
        const b = cellBox(i);
        assert.equal(cellAt((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), i);
    }
    assert.equal(cellAt(25, 25), 7); // x 0..50 is column 7
    assert.equal(cellAt(-25, 25), 8);
    assert.equal(cellAt(401, 10), -1);
    assert.equal(cellAt(0, -1), -1);
    assert.equal(cellAt(0, 1000), -1);
});

test("rectCells covers the rectangle between two cells in either order", () => {
    const a = 2 * COLS + 3;
    const b = 4 * COLS + 1;
    const cells = rectCells(a, b);
    assert.equal(cells.length, 9);
    assert.deepEqual(rectCells(b, a), cells);
    assert.deepEqual(rectCells(a, a), [a]);
});

test("zoneCheck: overlaps with other zones and cells outside the monitored area", () => {
    const zones = parseZones(last.native_zones);
    const edge = maskBits(last.edge_mask_hex);
    const draft = new Uint8Array(CELLS);
    for (const i of rectCells(3 * COLS + 9, 6 * COLS + 10)) draft[i] = 1; // row 6, columns 9-10 are Armchair's
    assert.deepEqual(zoneCheck(draft, zones, 4, edge), {cells: 8, overlaps: [3], outside: 0});
    assert.deepEqual(zoneCheck(zones[2].bits, zones, 3, edge).overlaps, []); // a zone does not overlap itself
    const outside = new Uint8Array(CELLS);
    outside[12 * COLS + 8] = outside[12 * COLS + 9] = 1; // row 12 is beyond the lounge's monitored area
    assert.deepEqual(zoneCheck(outside, zones, 4, edge), {cells: 2, overlaps: [], outside: 2});
});

test("configuration: base topic and device name for bridge/logging", () => {
    const c = normalizeConfig(lounge);
    assert.equal(c.base_topic, "zigbee2mqtt");
    assert.equal(c.device, "fp400_lounge");
    const nested = normalizeConfig({topic: "zigbee2mqtt/lounge/fp400", base_topic: "zigbee2mqtt"});
    assert.equal(nested.device, "lounge/fp400");
    assert.throws(() => normalizeConfig({topic: "a/b", base_topic: "z"}), /base_topic/);
    assert.equal(normalizeConfig({topic: "a/b", zone_editor: false}).zone_editor, false);
});

/* ── Areas, leaving targets (0.3.0) ── */

test("Fit to room: the cells at least half inside the outline are exactly the lounge's monitored area", () => {
    const c = normalizeConfig(lounge);
    const fitted = roomCells(c.room.outline);
    assert.equal(bitsToHex(invertBits(fitted)), last.edge_mask_hex);
    assert.equal(fitted.reduce((n, b) => n + b, 0), 81);
    assert.equal(roomCells(null).reduce((n, b) => n + b, 0), 0);
});

test("targets keep the leaving flag", () => {
    assert.deepEqual(parseTargets([{id: 1, x: -120, y: 330, zone: 0, speed: 0, leaving: true}]), [{id: 1, x: -120, y: 330, zone: 0, speed: 0, leaving: true}]);
    assert.deepEqual(parseTargets([{id: 1, x: 0, y: 0, leaving: "yes"}]), [{id: 1, x: 0, y: 0}]);
});

/* ── Software zones, settings, map rotation (0.4.0) ── */

test("software zones parse like the converter's: JSON or an object, \"clear\" for none, anything else invalid", () => {
    const z = parseSoftwareZone('{"name":"Couch","x_min":-100,"x_max":50,"y_min":200,"y_max":320}');
    assert.deepEqual(z, {name: "Couch", x_min: -100, x_max: 50, y_min: 200, y_max: 320, absence_timeout: 3});
    assert.deepEqual(parseSoftwareZone({x_min: 0, x_max: 10, y_min: 0, y_max: 10, absence_timeout: 0, rotation: 30}), {name: "Zone", x_min: 0, x_max: 10, y_min: 0, y_max: 10, absence_timeout: 0, rotation: 30});
    assert.equal(parseSoftwareZone({x_min: 0, x_max: 10, y_min: 0, y_max: 10, rotation: 0}).rotation, undefined); // no turn, no key
    for (const none of ["clear", "", null, undefined]) assert.equal(parseSoftwareZone(none), null, String(none));
    const bad = [
        "{nope",
        "[1,2]",
        {name: "", x_min: 0, x_max: 10, y_min: 0, y_max: 10},
        {name: "x".repeat(33), x_min: 0, x_max: 10, y_min: 0, y_max: 10},
        {x_min: "0", x_max: 10, y_min: 0, y_max: 10}, // numbers only, as the converter
        {x_min: 10, x_max: 10, y_min: 0, y_max: 10}, // min < max
        {x_min: 0, x_max: 2001, y_min: 0, y_max: 10},
        {x_min: 0, x_max: 10, y_min: 0, y_max: 10, absence_timeout: 1.5},
        {x_min: 0, x_max: 10, y_min: 0, y_max: 10, absence_timeout: 301},
        {x_min: 0, x_max: 10, y_min: 0, y_max: 10, rotation: 181},
    ];
    for (const value of bad) assert.equal(parseSoftwareZone(value), undefined, JSON.stringify(value));
});

test("software zone containment: lower bounds in, upper bounds out; a turned zone looks from its own frame", () => {
    const z = {x_min: -50, x_max: 50, y_min: 100, y_max: 200};
    assert.equal(inSoftwareZone({x: -50, y: 100}, z), true);
    assert.equal(inSoftwareZone({x: 49.9, y: 199.9}, z), true);
    assert.equal(inSoftwareZone({x: 50, y: 150}, z), false);
    assert.equal(inSoftwareZone({x: 0, y: 200}, z), false);
    // Turned 90°: the target is turned by -90° first, x' = y, y' = -x. A box x' 100..200, y' -50..50 holds x -50..50, y 100..200.
    const turned = {x_min: 100, x_max: 200, y_min: -50, y_max: 50, rotation: 90};
    assert.equal(inSoftwareZone({x: 0, y: 150}, turned), true);
    assert.equal(inSoftwareZone({x: 150, y: 0}, turned), false);
    // The corners drawn for a turned zone are exactly the ones it contains: each corner turned back lands on the box.
    const corners = softwareZoneCorners(turned).map(([x, y]) => [Math.round(x), Math.round(y)]);
    assert.deepEqual(corners, [[50, 100], [50, 200], [-50, 200], [-50, 100]]);
    const centre = corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    assert.equal(inSoftwareZone({x: centre[0], y: centre[1]}, turned), true);
    // 45°: the centre of the drawn shape is inside, a point just past a corner is not.
    const diamond = {x_min: 0, x_max: 100, y_min: 0, y_max: 100, rotation: 45};
    const c45 = softwareZoneCorners(diamond).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    assert.equal(inSoftwareZone({x: c45[0], y: c45[1]}, diamond), true);
    assert.equal(inSoftwareZone({x: 90, y: 10}, diamond), false); // inside the unturned box, outside the turned one
    assert.equal(inSoftwareZone({x: 90, y: 10}, {...diamond, rotation: 0}), true);
    assert.deepEqual(softwareZoneCorners(z), [[-50, 100], [50, 100], [50, 200], [-50, 200]]);
});

test("a software zone as sent equals it as published (key order and a zero turn do not matter)", () => {
    const sent = {name: "Desk", x_min: 0, x_max: 100, y_min: 50, y_max: 150, absence_timeout: 3};
    const back = parseSoftwareZone(JSON.stringify({absence_timeout: 3, y_max: 150, y_min: 50, x_max: 100, x_min: 0, name: "Desk"}));
    assert.equal(sameSoftwareZone(back, sent), true);
    assert.equal(sameSoftwareZone(back, {...sent, absence_timeout: 4}), false);
    assert.equal(sameSoftwareZone(null, null), true);
    assert.equal(sameSoftwareZone(back, null), false);
});

test("the snapshot lists software zones only when the device publishes them", () => {
    assert.equal(snapshotFromPayload(last).softwareZones, null);
    const p = {
        software_zone_1_config: '{"name":"Couch","x_min":-100,"x_max":50,"y_min":200,"y_max":320,"absence_timeout":3}',
        software_zone_1_occupancy: true,
        software_zone_1_count: 2,
        software_zone_1_activity: "moving",
        software_zone_1_available: true,
        software_zone_2_config: "clear",
        software_zone_2_occupancy: null,
        software_zone_2_count: null,
        software_zone_2_activity: null,
        software_zone_2_available: false,
    };
    const s = snapshotFromPayload(p).softwareZones;
    assert.deepEqual(s.map((z) => [z.id, z.config?.name ?? null, z.occupied, z.count, z.activity, z.available]), [
        [1, "Couch", true, 2, "moving", true],
        [2, null, null, null, null, false],
    ]);
    const ids = entityIds("dev");
    const fromStates = snapshotFromStates(
        {
            [ids.software_config(3)]: {state: p.software_zone_1_config},
            [ids.software_occupancy(3)]: {state: "on"},
            [ids.software_count(3)]: {state: "1"},
            [ids.software_activity(3)]: {state: "still"},
            [ids.software_config(4)]: {state: "unknown"},
        },
        ids,
    ).softwareZones;
    assert.deepEqual(fromStates.map((z) => [z.id, z.config?.name ?? null, z.occupied, z.count, z.activity]), [
        [3, "Couch", true, 1, "still"],
        [4, null, null, null, null],
    ]);
    assert.equal(ids.software_config(1), "text.dev_software_zone_1_config");
    assert.equal(ids.software_occupancy(1), "binary_sensor.dev_software_zone_1_occupancy");
    assert.equal(ids.software_count(1), "sensor.dev_software_zone_1_count");
});

test("settings: only the keys the device publishes; values compare as written", () => {
    const s = snapshotFromPayload({...last, map_rotation: 30, forget_still_targets: 0, restore_status: "ok"});
    for (const key of ["presence_sensitivity", "absence_timeout", "installation_mode", "installation_height", "ai_high_precision", "forget_still_targets"]) assert.ok(key in s.settings, key);
    // A map_rotation an older converter left in the device's state is not a setting of the card's.
    assert.equal("map_rotation" in s.settings, false);
    // The zones' own settings (presence_sensitivity_N, absence_timeout_N) are not the room's.
    assert.equal(Object.keys(s.settings).some((k) => /_\d+$/.test(k)), false);
    assert.equal(s.settings.presence_sensitivity, "high");
    assert.deepEqual(s.restore, {status: "ok", error: ""});
    const bare = snapshotFromPayload({occupancy_1: true});
    assert.deepEqual(bare.settings, {});
    assert.equal(bare.restore, null);
    assert.equal(sameSetting(45, 45), true);
    assert.equal(sameSetting("45", 45), true);
    assert.equal(sameSetting("ON", "ON"), true);
    assert.equal(sameSetting("OFF", "ON"), false);
    for (const d of SETTINGS) assert.ok(d.type !== "enum" || d.values.length >= 2, d.key);
    const ids = entityIds("dev");
    const reduced = snapshotFromStates({[ids.installation_mode]: {state: "ceiling"}, "number.dev_map_rotation": {state: "-30"}}, ids);
    assert.deepEqual(reduced.settings, {installation_mode: "ceiling"});
});

test("ignore this spot: the 2 x 2 cells around a point; snapping to 10 cm", () => {
    // x 22, y 175: grid lines x 0, y 150 or 200 → nearest x 0, y 200; cells x -50..50, y 150..250.
    const cells = cellsAround(22, 175);
    assert.deepEqual(cells, [3 * COLS + 7, 3 * COLS + 8, 4 * COLS + 7, 4 * COLS + 8]);
    for (const i of cells) {
        const b = cellBox(i);
        assert.ok(b.x0 >= -50 && b.x1 <= 50 && b.y0 >= 150 && b.y1 <= 250);
    }
    assert.equal(cellsAround(390, 10).length, 1); // the grid's corner: only one of the four is on it
    assert.equal(snapTo(24, 10), 20);
    assert.equal(snapTo(25, 10), 30);
    assert.equal(Object.is(snapTo(-4, 10), 0), true); // never -0
});

test("configuration: the map turns by the card's own rotation only", () => {
    assert.equal(normalizeConfig({topic: "a/b"}).rotation, 0);
    assert.equal(normalizeConfig({topic: "a/b", rotation: -90}).rotation, -90);
    assert.equal(normalizeConfig({topic: "a/b", rotation: "x"}).rotation, 0);
});
