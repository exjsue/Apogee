// What the Body detail panel says (src/domain/muscle-detail.js). The loads are made with computeMuscleLoad from small
// hand-made workouts, with the same three windows as logger.getMuscleStatus; expected values are worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMuscleLoad } from "../src/domain/muscle-load.js";
import { buildMuscleDetails } from "../src/domain/muscle-detail.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");

const ex = (id, name, primaryMuscles, secondaryMuscles = []) => ({ id, name, primaryMuscles, secondaryMuscles });
const BENCH = ex("bench", "Bench press", ["chest"], ["front_delts", "triceps"]);
const CURL = ex("curl", "Curl", ["biceps"]);
const LOG_LIFT = ex("log", "Log lift", ["front_delts", "side_delts"]);
const SHRUG = ex("shrug", "Shrug", ["traps"], ["neck"]);
const NECK_CURL = ex("neck", "Neck curl", ["neck"]);
const NECK_TRAPS = ex("nt", "Neck traps", ["neck"], ["traps"]);
const NECK_RAISE = ex("nr", "Neck raise", ["lats"], ["neck", "traps"]);
const ALL = [BENCH, CURL, LOG_LIFT, SHRUG, NECK_CURL, NECK_TRAPS, NECK_RAISE];

// agoMs: how long before NOW each set was done.
const entry = (exerciseId, ...agoMs) => ({ exerciseId, sets: agoMs.map((ago) => ({ completedAt: new Date(NOW - ago).toISOString(), isWarmup: false })) });
const day = (days, count = 1) => Array.from({ length: count }, (_, i) => days * DAY + 30 * 60 * 1000 + i * 60 * 1000); // `count` sets about `days` days ago
const workout = (...entries) => ({ startedAt: "2026-10-30T10:00:00.000Z", entries });

function detailsOf(workouts, exercises = ALL) {
  const load = (start, end, detail = false) => computeMuscleLoad({ workouts, exercises, window: { start, end }, detail });
  return buildMuscleDetails({
    recent: load(NOW - 7 * DAY, NOW + 1, true),
    previous: load(NOW - 14 * DAY, NOW - 7 * DAY),
    longer: load(NOW - 21 * DAY, NOW + 1, true),
    exercises,
    now: NOW,
  });
}
const of = (muscle, ...entries) => detailsOf([workout(...entries)])[muscle];

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test("a normal case: front delts 3.5 weighted sets, below the default target, the sentences and the contributors", () => {
  // bench x 3 gives the front delts 1.5 (secondary), log lift x 2 gives 2.0 (primary): 3.5
  const d = of("front_delts", entry("bench", ...day(1, 3)), entry("log", ...day(3, 2)));
  assert.equal(d.weighted, 3.5);
  assert.equal(d.hasSets, true);
  assert.equal(d.position, "below");
  assert.equal(d.positionText, "Below the default target");
  assert.equal(d.weightedText, "3.5 weighted sets in the last 7 days");
  assert.equal(d.targetText, "Default target: 10 to 20 weighted sets in 7 days");
  assert.equal(d.label, "Front delts");
  assert.deepEqual(d.contributors.primary, [{ exerciseId: "log", name: "Log lift", sets: 2, weighted: 2, text: "Log lift: 2 sets, 2 weighted" }]);
  assert.deepEqual(d.contributors.secondary, [{ exerciseId: "bench", name: "Bench press", sets: 3, weighted: 1.5, text: "Bench press: 3 sets, 1.5 weighted" }]);
  assert.equal(d.lastTrainedText, "1 day ago");
});

test("below, within and above the default target: 9.5 below, 10 and 20 within, 20.5 above (front delts from bench sets at 0.5 each)", () => {
  const position = (sets) => of("front_delts", entry("bench", ...day(1, sets))).position;
  assert.equal(position(19), "below"); // 9.5
  assert.equal(position(20), "within"); // 10
  assert.equal(position(40), "within"); // 20
  assert.equal(position(41), "above"); // 20.5
});

test("days since last trained is elapsed time: under 24 h, 24 to under 48 h, then whole days; secondary credit counts; none in 3 weeks says so", () => {
  const text = (ago) => of("biceps", entry("curl", ago)).lastTrainedText;
  assert.equal(text(0), "less than 24 hours ago", "a set at this very moment");
  assert.equal(text(DAY - 1), "less than 24 hours ago");
  assert.equal(text(DAY), "1 day ago");
  assert.equal(text(2 * DAY - 1), "1 day ago");
  assert.equal(text(2 * DAY), "2 days ago");
  assert.equal(text(2.25 * DAY), "2 days ago");
  assert.equal(text(10 * DAY), "10 days ago");
  assert.equal(of("biceps", entry("curl", 10 * DAY)).daysSince, 10);
  assert.equal(of("biceps", entry("curl", 2.25 * DAY)).daysSince, 2);
  assert.equal(of("biceps", entry("curl", 5 * HOUR)).daysSince, 0);
  // front delts only worked as a secondary muscle, 3 days ago
  assert.equal(of("front_delts", entry("bench", ...day(3))).lastTrainedText, "3 days ago");
  // nothing counted: the set is older than the 3 weeks that are loaded, or there is no set at all
  const never = of("biceps", entry("curl", 22 * DAY));
  assert.equal(never.lastTrainedText, "more than 3 weeks ago or never");
  assert.equal(never.daysSince, null);
  assert.equal(of("chest", entry("curl", DAY)).lastTrainedText, "more than 3 weeks ago or never");
});

test("elapsed time does not depend on the calendar: exactly 48 hours is 2 days across a clock change", () => {
  // 2026-10-25 is the end of daylight saving time in Europe; the arithmetic is on UTC milliseconds
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const set = { completedAt: "2026-10-24T12:00:00.000Z", isWarmup: false };
  const workouts = [{ entries: [{ exerciseId: "curl", sets: [set] }] }];
  const load = (start, end, detail = false) => computeMuscleLoad({ workouts, exercises: [CURL], window: { start, end }, detail });
  const d = buildMuscleDetails({ recent: load(now - 7 * DAY, now + 1, true), previous: load(now - 14 * DAY, now - 7 * DAY), longer: load(now - 21 * DAY, now + 1, true), exercises: [CURL], now });
  assert.equal(d.biceps.lastTrainedText, "2 days ago");
});

test("the trend shows both values and the signed difference: 6 vs 0 (+6), 1.5 vs 6 (-4.5), 2 vs 2 (0)", () => {
  assert.equal(of("biceps", entry("curl", ...day(1, 6))).trend.text, "6 vs 0 (+6) sets, last 7 days vs the 7 days before");
  assert.deepEqual(of("biceps", entry("curl", ...day(1, 6))).trend, { current: 6, previous: 0, delta: 6, text: "6 vs 0 (+6) sets, last 7 days vs the 7 days before" });
  // front delts: bench x 3 now (1.5), log lift x 6 in the week before (6.0)
  const down = of("front_delts", entry("bench", ...day(1, 3)), entry("log", ...day(9, 6)));
  assert.deepEqual([down.trend.current, down.trend.previous, down.trend.delta], [1.5, 6, -4.5]);
  assert.equal(down.trend.text, "1.5 vs 6 (-4.5) sets, last 7 days vs the 7 days before");
  assert.equal(of("biceps", entry("curl", ...day(1, 2), ...day(9, 2))).trend.text, "2 vs 2 (0) sets, last 7 days vs the 7 days before");
});

test("nothing in the last 7 days: no zeros as data, but the last-trained time and the trend are still there when they exist", () => {
  const d = of("biceps", entry("curl", ...day(10, 4)));
  assert.equal(d.hasSets, false);
  assert.equal(d.position, null);
  assert.equal(d.positionText, null);
  assert.equal(d.weightedText, "No sets in the last 7 days");
  assert.deepEqual(d.contributors, { primary: [], secondary: [] });
  assert.equal(d.lastTrainedText, "10 days ago");
  assert.equal(d.trend.text, "0 vs 4 (-4) sets, last 7 days vs the 7 days before");
});

test("an empty previous window still gives a trend, and both windows empty gives none", () => {
  assert.equal(of("biceps", entry("curl", ...day(1, 1))).trend.text, "1 vs 0 (+1) sets, last 7 days vs the 7 days before");
  const empty = detailsOf([]).biceps;
  assert.equal(empty.trend, null);
  assert.equal(empty.hasSets, false);
  assert.equal(empty.lastTrainedText, "more than 3 weeks ago or never");
});

test("window edges: a set exactly 7 days ago is in the last 7 days, 1 ms older is in the week before; 14 days is before, 1 ms older is in neither", () => {
  const trend = (ago) => of("biceps", entry("curl", ago)).trend;
  assert.deepEqual([trend(7 * DAY).current, trend(7 * DAY).previous], [1, 0]);
  assert.deepEqual([trend(7 * DAY + 1).current, trend(7 * DAY + 1).previous], [0, 1]);
  assert.deepEqual([trend(14 * DAY).current, trend(14 * DAY).previous], [0, 1]);
  assert.equal(trend(14 * DAY + 1), null, "in neither window");
  assert.equal(of("biceps", entry("curl", 14 * DAY + 1)).lastTrainedText, "14 days ago", "but still inside the 3 weeks");
});

test("contributors: at most 5 per group, biggest weighted credit first, ties by name, primary and secondary apart", () => {
  const names = ["Alpha", "Zed", "Fly", "Dip", "Press", "Row"];
  const chest = names.map((name, i) => ex(`p${i}`, name, ["chest"]));
  // sets: Alpha 6, Zed 3, Fly 3, Dip 4, Press 2, Row 1
  const counts = [6, 3, 3, 4, 2, 1];
  const helpers = [ex("s0", "Helper two", ["biceps"], ["chest"]), ex("s1", "Helper one", ["biceps"], ["chest"])];
  const entries = [...chest.map((e, i) => entry(e.id, ...day(2, counts[i]))), entry("s0", ...day(2, 4)), entry("s1", ...day(2, 4))];
  const d = detailsOf([workout(...entries)], [...chest, ...helpers]).chest;
  assert.deepEqual(d.contributors.primary.map((row) => row.name), ["Alpha", "Dip", "Fly", "Zed", "Press"], "Row, the smallest, is cut");
  assert.deepEqual(d.contributors.primary.map((row) => row.sets), [6, 4, 3, 3, 2]);
  assert.deepEqual(d.contributors.secondary.map((row) => [row.name, row.sets, row.weighted]), [["Helper one", 4, 2], ["Helper two", 4, 2]]);
  assert.equal(d.weighted, 6 + 3 + 3 + 4 + 2 + 1 + 2 + 2);
});

test("an exercise with no stored name is listed by its id", () => {
  const d = detailsOf([workout(entry("gone", ...day(1, 2)))], [{ id: "gone", primaryMuscles: ["biceps"], secondaryMuscles: [] }]).biceps;
  assert.equal(d.contributors.primary[0].name, "gone");
});

test("the neck is shown with the traps: 19 muscles, no neck key, and the label says both", () => {
  const all = detailsOf([]);
  assert.equal(Object.keys(all).length, 19);
  assert.ok(!("neck" in all));
  assert.equal(all.traps.label, "Traps and neck");
});

test("neck and traps: an exercise crediting both is ONE entry, sets once, credits added, primary if either is primary", () => {
  // traps primary, neck secondary: 2 sets -> traps 2.0 + neck 1.0 = 3.0
  const shrug = of("traps", entry("shrug", ...day(1, 2)));
  assert.deepEqual(shrug.contributors.primary.map(({ exerciseId, sets, weighted }) => [exerciseId, sets, weighted]), [["shrug", 2, 3]]);
  assert.deepEqual(shrug.contributors.secondary, []);
  assert.equal(shrug.weighted, 3);
  // neck primary, traps secondary: 2 sets -> 1.5 per set = 3.0, primary
  const reverse = of("traps", entry("nt", ...day(1, 2)));
  assert.deepEqual(reverse.contributors.primary.map(({ exerciseId, sets, weighted }) => [exerciseId, sets, weighted]), [["nt", 2, 3]]);
  assert.deepEqual(reverse.contributors.secondary, []);
  // neck secondary and traps secondary: 2 sets -> 1.0 per set = 2.0, secondary
  const both = of("traps", entry("nr", ...day(1, 2)));
  assert.deepEqual(both.contributors.primary, []);
  assert.deepEqual(both.contributors.secondary.map(({ exerciseId, sets, weighted }) => [exerciseId, sets, weighted]), [["nr", 2, 2]]);
  // only the neck: 3 sets -> 3.0 primary, shown under the traps
  const neckOnly = of("traps", entry("neck", ...day(1, 3)));
  assert.deepEqual(neckOnly.contributors.primary.map(({ exerciseId, name, sets, weighted }) => [exerciseId, name, sets, weighted]), [["neck", "Neck curl", 3, 3]]);
  assert.equal(neckOnly.weighted, 3);
});

test("neck and traps together: the total is what the diagram shows, last trained takes the later of the two", () => {
  const d = of("traps", entry("shrug", ...day(1, 2)), entry("nt", ...day(2, 2)), entry("nr", ...day(3, 2)), entry("neck", ...day(5, 3)));
  assert.equal(d.weighted, 3 + 3 + 2 + 3); // the sum of the four cases above
  assert.deepEqual(d.contributors.primary.map((row) => row.name), ["Neck curl", "Neck traps", "Shrug"], "all 3.0: by name");
  assert.equal(d.lastTrainedText, "1 day ago");
  // the neck alone was done most recently: the traps' time is the neck's
  assert.equal(of("traps", entry("neck", ...day(0))).lastTrainedText, "less than 24 hours ago");
});

test("balance: push against pull for each of its 8 muscles, the same totals and a ratio; no verdict", () => {
  // bench x 4: chest 4, front delts 2, triceps 2. log lift x 2: front delts 2, side delts 2. curl x 3: biceps 3.
  // push = 4 + (2 + 2) + 2 + 2 = 12; pull = 3; ratio 4
  const all = detailsOf([workout(entry("bench", ...day(1, 4)), entry("log", ...day(1, 2)), entry("curl", ...day(1, 3)))]);
  const expected = { first: { name: "Push", total: 12 }, second: { name: "Pull", total: 3 }, ratio: 4, text: "Push 12 vs Pull 3 weighted sets, ratio 4 : 1" };
  for (const id of ["chest", "front_delts", "side_delts", "triceps", "upper_back", "lats", "rear_delts", "biceps"]) assert.deepEqual(all[id].balance, expected, id);
});

test("balance: quads against hamstrings, abs against lower back; one side 0 shows the totals and no ratio; the ratio is rounded to 2 places", () => {
  const legs = ex("legs", "Legs", ["quads"]);
  const only = detailsOf([workout(entry("legs", ...day(1, 2)))], [legs]);
  for (const id of ["quads", "hamstrings"]) {
    assert.deepEqual(only[id].balance, { first: { name: "Quads", total: 2 }, second: { name: "Hamstrings", total: 0 }, ratio: null, text: "Quads 2 vs Hamstrings 0 weighted sets" }, id);
  }
  assert.deepEqual(only.abs.balance, { first: { name: "Abs", total: 0 }, second: { name: "Lower back", total: 0 }, ratio: null, text: "Abs 0 vs Lower back 0 weighted sets" });
  const core = [ex("a", "Crunch", ["abs"]), ex("b", "Extension", ["lower_back"])];
  const both = detailsOf([workout(entry("a", ...day(1, 7)), entry("b", ...day(1, 3)))], core);
  for (const id of ["abs", "lower_back"]) assert.deepEqual([both[id].balance.ratio, both[id].balance.text], [2.33, "Abs 7 vs Lower back 3 weighted sets, ratio 2.33 : 1"], id);
});

test("balance is not shown for muscles in no pair: traps, forearms, calves, glutes, obliques, adductors, abductors", () => {
  const all = detailsOf([workout(entry("bench", ...day(1, 3)))]);
  for (const id of ["traps", "forearms", "calves", "glutes", "obliques", "adductors", "abductors"]) assert.equal(all[id].balance, null, id);
  const paired = Object.values(all).filter((d) => d.balance !== null).map((d) => d.muscle).sort();
  assert.deepEqual(paired, ["abs", "biceps", "chest", "front_delts", "hamstrings", "lats", "lower_back", "quads", "rear_delts", "side_delts", "triceps", "upper_back"]);
});

test("the inputs are only read: frozen loads and exercises do not throw, and bad input is refused", () => {
  const exercises = deepFreeze([...ALL]);
  const workouts = deepFreeze([workout(entry("bench", ...day(1, 3)))]);
  const load = (start, end, detail = false) => computeMuscleLoad({ workouts, exercises, window: { start, end }, detail });
  const recent = deepFreeze(load(NOW - 7 * DAY, NOW + 1, true));
  const previous = deepFreeze(load(NOW - 14 * DAY, NOW - 7 * DAY));
  const longer = deepFreeze(load(NOW - 21 * DAY, NOW + 1, true));
  assert.doesNotThrow(() => buildMuscleDetails({ recent, previous, longer, exercises, now: NOW }));
  assert.throws(() => buildMuscleDetails({ recent: load(NOW - 7 * DAY, NOW + 1), previous, longer, exercises, now: NOW }), TypeError);
  assert.ok(buildMuscleDetails({ recent, previous, longer, exercises: new Map(ALL.map((e) => [e.id, e])), now: NOW }).chest.contributors.primary[0].name === "Bench press", "a Map of exercises works too");
});
