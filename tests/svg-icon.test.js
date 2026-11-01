import test from "node:test";
import assert from "node:assert/strict";
import { equipmentIcon, iconShape, ICON_NAMES } from "../src/ui/svg-icon.js";

const EQUIPMENT = [
  "bodyweight", "barbell", "dumbbell", "cable", "other", "kettlebell", "machine", "smith_machine",
  "resistance_band", "foam_roll", "pull_up_bar", "medicine_ball", "exercise_ball", "ez_bar", "trap_bar",
];

test("every catalog equipment value maps to a drawn icon of its own name", () => {
  for (const value of EQUIPMENT) {
    const name = equipmentIcon(value);
    assert.equal(name, value);
    assert.ok(ICON_NAMES.includes(name), `${value} has no icon`);
    assert.match(iconShape(name), /^M/, `${value} has no path data`);
    if (value !== "fallback") assert.notEqual(iconShape(name), iconShape("fallback"), `${value} drew the fallback`);
  }
});

test("null and unknown equipment map to the fallback icon, and unknown names draw it", () => {
  for (const value of [null, undefined, "", "sled", "toString", "__proto__"]) assert.equal(equipmentIcon(value), "fallback");
  assert.equal(iconShape("sled"), iconShape("fallback"));
  assert.equal(iconShape("toString"), iconShape("fallback"));
});

test("the shared shapes are the ones listed, and the rest are distinct", () => {
  assert.equal(iconShape("ez_bar"), iconShape("barbell"));
  assert.equal(iconShape("smith_machine"), iconShape("machine"));
  assert.equal(iconShape("pull_up_bar"), iconShape("bodyweight"));
  const own = EQUIPMENT.filter((v) => !["ez_bar", "smith_machine", "pull_up_bar"].includes(v));
  assert.equal(new Set(own.map(iconShape)).size, own.length);
});
