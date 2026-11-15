# Aqara FP400 Map Card

A Home Assistant dashboard card for the Aqara FP400 presence multi-sensor on Zigbee2MQTT. It draws one sensor on a
map of its room: the area it monitors, its entrance and interference cells, its own detection zones, software zones,
and the people it tracks, each with a short trail. Admins can also edit the zones and areas, forget a target or ignore
its spot, and change the sensor's settings, all from the card. The map zooms and pans.

- Live positions of every tracked target, with the sensor's zone it is in
- The monitored area, entrances and interference cells, drawn and edited on the sensor's 50 cm grid
- The sensor's own zones (up to 8) with occupancy and people count: create, reshape and delete them on the map
- Software zones (rectangles Zigbee2MQTT checks the positions against), drawn and edited the same way
- A popover on each dot: forget the target (for ghosts), or mark its spot as interference
- A settings panel for the sensor's options, spatial learning and the settings-restore status
- An optional room outline with doors, windows and furniture, turned and mirrored to match your floor plan
- Light and dark themes; a reduced, read-only view for users who are not admins

## Requirements

- Home Assistant with the MQTT integration, and Zigbee2MQTT on the same broker.
- FP400 support in Zigbee2MQTT. It comes with zigbee-herdsman-converters: the device itself arrives with
  [Koenkk/zigbee-herdsman-converters#13812](https://github.com/Koenkk/zigbee-herdsman-converters/pull/13812) (presence,
  light, people count, activity, settings). Target positions follow in
  [#13836](https://github.com/Koenkk/zigbee-herdsman-converters/pull/13836); the detection areas, the sensor's own zones,
  movement events, software zones and settings restore in later pull requests.

The card draws what the converter publishes and leaves out the rest, so parts of the map stay empty until the
converter has them and the matching device options are on in Zigbee2MQTT:

| On the map | Needs |
|---|---|
| Dots, trails, the popover | the device's `tracking` option |
| The sensor's own zones | the device's `native_zones` option |
| Software zones | the device's `software_zones` option |

## Install

### HACS

1. HACS → ⋮ → **Custom repositories**: add `https://github.com/alex-savin/hassio-card-aqara-fp400-map` as type
   **Dashboard**.
2. Install **Aqara FP400 Map Card**. HACS adds the dashboard resource.
3. Reload the browser and add the card (see Configuration).

### Manually

1. Copy `fp400-map-card.js` to `/config/www/`.
2. Add the dashboard resource `/local/fp400-map-card.js?v=0.4.1` (type: JavaScript module). Change `?v=` on every
   update: browsers cache `/local/` files for a month.
3. Add the card.

The card's footnote ends with its version (`Card 0.4.1.`). If it shows an older one, the browser still has the old
file: reload the page (Companion app: Settings → Companion app → Debugging → Reset frontend cache).

## Configuration

```yaml
type: custom:fp400-map-card
topic: zigbee2mqtt/fp400_lounge           # the device's Zigbee2MQTT topic (live view)
entity_prefix: fp400_lounge               # optional; defaults to the last part of the topic (reduced view)
title: Lounge                             # optional
rotation: 180                             # optional; degrees clockwise, turns the whole map (default 0)
mirror: false                             # optional; flips x before turning
zones: {1: Table, 2: Sofa, 3: Armchair}   # optional; names of the sensor's zones (default "Zone N")
trail_seconds: 15                         # optional; 0 turns trails off (max 120)
stale_seconds: 30                         # optional; dots go hollow when nothing arrived for this long
refresh_on_open: true                     # optional; see "Opening the card in an empty room"
zone_editor: true                         # optional; false hides the editor, settings and dot popover
base_topic: zigbee2mqtt                   # optional; Zigbee2MQTT's base topic, default the topic's first part
entities:                                 # optional; override any derived entity id
  targets: sensor.lounge_targets
room:                                     # optional; the room in the sensor's frame, in mm
  outline_mm: [[x, y], ...]               # the wall line, closed automatically
  features:                               # door | opening | window | glass | wall | furniture | fixture
    - {type: furniture, name: Table, points_mm: [[x, y], ...], label: true}
```

`examples/` holds two complete cards for made-up rooms: `lounge.json` (a wall-mounted sensor with three zones) and
`study.json` (a sensor in a corner, its room turned square with `rotation: -45`).

**The frame.** Everything is in the sensor's own coordinates: x across (negative to the sensor's left; the grid's
column 0 is x = +350..+400 cm), y = distance out from the sensor. Targets come in cm, the room in mm. `mirror` and
`rotation` turn the result for display; labels stay upright. Both belong to the card, not the device, so each card of a
sensor can turn its map its own way. Without a room outline the map frames the monitored area; a sensor whose
`installation_mode` is `ceiling` is framed 6 m all around instead, since it sees on every side (y can be negative). With
an outline, the room is framed.

## Where the data comes from

| Viewer | Source | Shows |
|---|---|---|
| Admin user | The device's Zigbee2MQTT topic, through Home Assistant's websocket (`mqtt/subscribe`) | Everything: all targets with their zone, masks, zone outlines |
| Anyone else, or no `topic`, or the subscription fails | The device's Home Assistant entities | Reduced view: positions from `targets`, masks, presence, counts, zone outlines and occupancy, software zones. No editing |

Home Assistant only lets admin users listen to MQTT topics, which is why there are two views.

**Positions and the database.** In the live view, positions go from MQTT straight to the browser. They never become
Home Assistant states, so they never reach the recorder. Trails are kept in the browser's memory only and are gone on
reload. The reduced view reads `sensor.<prefix>_targets`, so exclude that entity from the recorder if positions
must not be stored. Home Assistant cuts its state at 255 characters, about six targets; the card then marks the report
partial.

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.<prefix>_targets*
```

**Entities used by the reduced view** (with `entity_prefix: dev`): `binary_sensor.dev_occupancy_1`,
`sensor.dev_human_count`, `sensor.dev_targets` (or `sensor.dev_targets_xy` from earlier test builds of the converter),
`text.dev_edge_mask_hex`, `text.dev_entry_exit_mask_hex`, `text.dev_interference_mask_hex`,
`binary_sensor.dev_native_zone_N_occupancy`, `sensor.dev_native_zone_N_count`, and for zone outlines
`sensor.dev_configured_zones_compact` (`configured_zones` itself is cut at Home Assistant's 255 characters), the software
zones' four entities each (see below) and `select.dev_installation_mode`.

**Opening the card in an empty room.** A quiet sensor sends nothing, so if no message arrives within 4 s of opening,
the card asks Zigbee2MQTT for a fresh state once (`<topic>/get` `{"edge_mask_hex": ""}`, one Zigbee read of the
monitoring mask; at most once a minute per page). `refresh_on_open: false` turns this off.

## Editing (admins, live view)

**Edit zones and areas** (bottom right) opens the editor on the map. Its first row picks the layer: **Zones**,
**Software zones** (when the device publishes them), or one of the sensor's three areas.

Hiding the editor from non-admins is a convenience, not a lock: Home Assistant lets any user call `mqtt.publish`.
`zone_editor: false` removes every write from the card: the editor, the settings panel and the dot popover.

### Areas

- **Monitored area**: the cells the sensor watches; it ignores everything outside, such as people behind a wall. The
  sensor stores the opposite (the ignored cells, `edge_mask_hex`); the card draws and edits the watched cells and inverts
  on save. **Fit to room** picks the cells at least half inside the room outline. An empty monitored area cannot be
  saved, and a zone partly outside it is warned about.
- **Entrances** (`entry_exit_mask_hex`): doorways, where the sensor picks up and drops people faster.
- **Interference** (`interference_mask_hex`): things that move by themselves (a fan, a curtain); the sensor ignores
  movement there.
- While an area is edited its normal drawing is hidden and the draft is shown instead. **Save** writes the whole mask;
  the converter reads it back, and the card counts the write as done when the published mask equals the draft.

### Zones

- Pick a zone, or **+ New zone** (the lowest free number, up to the sensor's `maximum_zones`, 8).
- Tap a cell to add or remove it; drag to fill or clear a rectangle (starting on a drawn cell clears). The map keeps
  showing people, so you can stand where a zone should go and see your dot.
- **Create zone** / **Save zone** sends `native_zone` `{zone_id, mask_hex}` to `<topic>/set`; **Delete zone** sends
  `native_zone_remove`. Sensitivity and absence timeout are written as soon as they change (`zone_N_sensitivity`,
  `zone_N_absence_timeout`).
- A write counts as done only when the sensor's own zone list (or the setting) comes back with the new value. Zigbee2MQTT
  publishes a few intermediate states first, so the card waits for the exact cells. If Zigbee2MQTT logs an error for the
  device meanwhile (`<base_topic>/bridge/logging`, error level), the card shows it; after 20 s without either it says so.
- Warnings, not blocks: cells shared with another zone, and cells outside the monitored area. The sensor accepts both
  (firmware 63); how it counts someone in a shared cell is untested.
- Reporting: the sensor pushes changes for room presence and four more things. The converter shares these out again
  after a zone is created or removed: zones first, then the light sensor. So with 4 zones the light is read once a
  minute, and from a 5th zone on the extra zones are. The dots show every zone straight away, since each target carries
  its zone.
- Zone names are not stored on the sensor: name the zones in the card's `zones:`.
- The editor needs the sensor's zone list. A sensor that never had a zone has published none, so the card reads it once
  (`<topic>/get` `{"configured_zones": ""}`, at most once a minute per page); the answer, `[]`, comes back only with the
  device's `native_zones` option on. Until the list is known, **Edit zones** stays hidden, so a new zone can never
  overwrite one the card does not know about.

### Software zones

Software zones are rectangles that Zigbee2MQTT checks the tracked positions against; the sensor knows nothing of them.
The layer appears when the device's state carries `software_zone_N_config` keys, that is with the device's
`software_zones` option on in Zigbee2MQTT (eight slots, N = 1..8).

- Pick a zone, or **+ New** (the lowest free slot). Drag a rectangle on the map to place it, in 10 cm steps; it is drawn
  in the sensor's frame, so with a turned map it shows turned too. Give it a **Name** (1 to 32 characters) and
  **Empty after** (the absence timeout, 0 to 300 s, default 3).
- **Create zone** / **Save zone** sends `{"software_zone_N_config": "<JSON>"}` to `<topic>/set`, the JSON being
  `{name, x_min, x_max, y_min, y_max, absence_timeout}` in cm (plus `rotation` if the zone had one). The write counts as
  done when the published config parses to the same zone. **Delete zone** sends `"clear"`. Errors and the 20 s timeout
  work as for the sensor's zones.
- A zone with a `rotation` (set some other way; the card draws new zones unturned) is drawn turned, and the card counts a
  target as inside the way the converter does: turn the target by -rotation, then check `[x_min, x_max) × [y_min, y_max)`.
  Drawing a new rectangle over a turned zone replaces it without the turn (the editor says so).
- On the map a software zone is a thin solid outline with a rounded name tag; while someone is in it the zone is shaded
  and the tag turns solid, with the count. The rows list each zone with its count and, while occupied, whether people in
  it are moving or still (`software_zone_N_occupancy`, `_count`, `_activity`).
- Reduced view: `text.<prefix>_software_zone_N_config`, `binary_sensor.<prefix>_software_zone_N_occupancy`,
  `sensor.<prefix>_software_zone_N_count` and `sensor.<prefix>_software_zone_N_activity`.

### A dot's popover

In the live view, clicking a dot (not while editing) opens a popover next to it. Clicking anywhere else, or Escape,
closes it.

- **Forget this target** sends `{"remove_target": <id>}`: the sensor drops the target, which suits a ghost (a real person
  is found again within a second or two). It counts as done when the next message no longer has that id; after 8 s
  without that it says the sensor still reports it. If Zigbee2MQTT refuses the command, its error is shown in the
  popover.
- **Ignore this spot** opens the Interference layer with the 2 × 2 cells around the dot (the 1 × 1 m block centred on
  the nearest grid corner) added to the draft. Nothing is written until **Save**.

### Settings

**Settings** (next to **Edit zones and areas**) opens a panel with the device's options. Each change is written at once
(`<topic>/set`), one at a time, and counts as done when the device's state reports the new value; errors show as in the
editor. Only settings whose key is in the device's state are shown:

| Section | Settings |
|---|---|
| Detection | `presence_sensitivity` (low/medium/high), `absence_timeout` (0-300 s), `proximity_distance` (far/medium/near), `detection_direction` (omnidirectional/left_right), `coordinate_reverse` (disabled/enabled/auto), `human_count_enabled` |
| AI | `ai_high_precision`, `ai_adaptive_sensitivity`, `ai_entry_exit_recognition`, `ai_interference_recognition` (ON/OFF) |
| Mounting | `installation_mode` (wall/ceiling), `side_installation` (wall/left_corner/right_corner), `installation_height` (mm) |
| Map | `forget_still_targets` (0-240 min, 0 = off); kept by the converter, not the sensor |

**Learn the empty room** sends `{"spatial_learning": "start"}` (after a confirmation: the room must be empty) and shows
`learning_state` / `learning_result_code` as they come. `restore_status` / `restore_error` are shown read-only when the
device publishes them.

### Zoom and pan

Ctrl or ⌘ with the mouse wheel (or a trackpad pinch) zooms about the pointer, up to 8×; on a touch screen, pinch with
two fingers. A plain wheel scrolls the page past the whole map, and zooms once it is zoomed in. While zoomed in, drag to
pan (in the editor dragging draws, so pan there with a pinch or the middle mouse button). Double-click the map or press
**Fit** (top right while zoomed) to see the whole map again. Text and dots keep their size on screen. On phones a
one-finger drag scrolls the page until the map is zoomed in.

## Tests

```sh
node --test tests/                                    # unit tests, no dependencies
python3 -m http.server 8765 --bind 127.0.0.1          # then open:
# http://127.0.0.1:8765/tests/harness.html?frame=195  four cards (admin/non-admin, light/dark) fed the fixture messages
# add &scenario=NAME to drive the card with pointer events against a fake Zigbee2MQTT; results under the cards
```

| Scenario (with `&frame=60`) | Checks |
|---|---|
| `edit` | the sensor's zones: create, reshape, settings, errors, delete |
| `areas` | monitored area, entrances, interference |
| `zones` (with `&config=study&fixtures=no-zones&frame=6`) | a sensor that never had a zone |
| `software` | software zones: draw, name, create, rename, errors, delete, turned zones, reduced view |
| `settings` | the settings panel, room learning, restore status |
| `dot` | the dot popover: forget, ignore this spot, errors |
| `view` | wheel, drag, pinch, double-click, Fit, ceiling framing, a leftover `map_rotation` ignored |
| `reduced` | the reduced view reading positions from the `targets` entity (Python text, cut at 255 characters) |

`&software=1` makes the fake device publish software zones (`=demo` adds two); `&stay=software|settings|pop|zoom|ceiling`
leaves that view open after its scenario, for a screenshot.

Headless: `chrome --headless=new --user-data-dir=<fresh dir> --virtual-time-budget=60000 --dump-dom "<harness URL>"`
prints the PASS/FAIL lines in `<pre id="result">` (a fresh profile, or Chrome may run a cached copy of the card).

The fixtures are made up: `node tests/make-fixtures.mjs` writes `tests/fixtures/payloads.json` (400 messages from the
lounge: people walking in, sitting at the table, on the sofa and in the armchair, and leaving), `tests/fixtures/no-zones.json`
(40 messages from the study's sensor, which never had a zone) and the two example rooms, the same every time. The grid
layout they use, column 0 at x = +350..+400 cm, was checked against a real FP400: every target it reported inside one
of its zones fell in that zone's cells, while a mirrored grid did not match.

## Support

If this card is useful to you, you can support its development through
[GitHub Sponsors](https://github.com/sponsors/alex-savin).

## License

MIT — see [LICENSE](LICENSE).
