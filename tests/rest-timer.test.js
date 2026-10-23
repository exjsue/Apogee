import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REST_SECONDS, MAX_REST_SECONDS, formatRest, parseRest, startTimer, remainingMs, remainingSeconds,
  isRunning, fractionRemaining, rescheduleTimer, setPhase, pieGeometry,
  parseRestEntry, previewRestEntry, restToDigits, REST_ENTRY_HELP,
} from "../src/domain/rest-timer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECOND = 1000;

test("rest: the default is 3:00 and the longest is 60:00", () => {
  assert.equal(DEFAULT_REST_SECONDS, 180);
  assert.equal(MAX_REST_SECONDS, 3600);
});

test("rest: formatRest gives m:ss and rounds partial seconds up", () => {
  assert.deepEqual([0, 5, 59, 60, 185, 3600].map(formatRest), ["0:00", "0:05", "0:59", "1:00", "3:05", "60:00"]);
  assert.equal(formatRest(0.2), "0:01");
  assert.equal(formatRest(-3), "0:00");
});

test("rest: parseRest accepts m:ss only, up to 60:00", () => {
  assert.deepEqual(["3:00", "0:30", " 1:05 ", "60:00", "00:10"].map(parseRest), [180, 30, 65, 3600, 10]);
  for (const bad of ["", "90", "3", "3:5", "3:60", "-1:00", "1:00:00", "60:01", "99:59", "a:bc", null, undefined, 180]) {
    assert.throws(() => parseRest(bad), /rest/, String(bad));
  }
});

test("timer: the end is absolute, and the remaining time is the end minus the clock", () => {
  const timer = startTimer({ setId: "s1", nowMs: 1_000_000, restSeconds: 180 });
  assert.deepEqual(timer, { setId: "s1", startedAt: 1_000_000, endsAt: 1_180_000 });
  assert.equal(remainingMs(timer, 1_000_000), 180_000);
  assert.equal(remainingMs(timer, 1_060_000), 120_000);
  assert.equal(remainingSeconds(timer, 1_060_001), 120); // rounded up
  assert.equal(remainingSeconds(timer, 1_179_999), 1);
  assert.equal(remainingSeconds(timer, 1_180_000), 0);
  assert.equal(fractionRemaining(timer, 1_090_000), 0.5);
  assert.deepEqual([isRunning(timer, 1_179_999), isRunning(timer, 1_180_000), isRunning(null, 0)], [true, false, false]);
});

test("timer: a clock jump forward ends it, a jump back never shows more than the full rest", () => {
  const timer = startTimer({ setId: "s1", nowMs: 1_000_000, restSeconds: 180 });
  assert.equal(remainingMs(timer, 1_000_000 + 3_600_000), 0);
  assert.equal(remainingMs(timer, 1_000_000 - 3_600_000), 180_000);
  assert.equal(fractionRemaining(timer, 1_000_000 - 3_600_000), 1);
  assert.equal(fractionRemaining(timer, 1_000_000 + 3_600_000), 0);
});

test("timer: startTimer refuses a bad rest or id", () => {
  for (const bad of [-1, 1.5, 3601, "180", null, undefined]) {
    assert.throws(() => startTimer({ setId: "s1", nowMs: 0, restSeconds: bad }), /rest/);
  }
  assert.throws(() => startTimer({ setId: "", nowMs: 0, restSeconds: 60 }), /setId/);
  assert.throws(() => startTimer({ setId: "s1", nowMs: NaN, restSeconds: 60 }), /nowMs/);
  assert.deepEqual(startTimer({ setId: "s1", nowMs: 5, restSeconds: 0 }), { setId: "s1", startedAt: 5, endsAt: 5 });
});

test("timer: editing the rest recomputes the end from the start, and ends at once if it is not longer than the elapsed time", () => {
  const timer = startTimer({ setId: "s1", nowMs: 1_000_000, restSeconds: 180 });
  const shorter = rescheduleTimer(timer, 60, 1_030_000); // 30 s elapsed
  assert.deepEqual(shorter, { setId: "s1", startedAt: 1_000_000, endsAt: 1_060_000 });
  assert.equal(remainingSeconds(shorter, 1_030_000), 30);
  assert.equal(rescheduleTimer(timer, 300, 1_030_000).endsAt, 1_300_000);
  assert.equal(rescheduleTimer(timer, 60, 1_090_000), null); // 90 s elapsed, new rest 60
  assert.equal(rescheduleTimer(timer, 60, 1_060_000), null); // exactly elapsed
  assert.equal(rescheduleTimer(timer, 0, 1_000_000), null);
  assert.throws(() => rescheduleTimer(timer, 3601, 1_000_000), /60:00/);
});

test("phase: unchecked is template; the one running timer's set is resting; every other checked set is done", () => {
  const timer = startTimer({ setId: "b", nowMs: 0, restSeconds: 60 });
  assert.equal(setPhase({ logged: false, setId: "x", timer, nowMs: 0 }), "template");
  assert.equal(setPhase({ logged: true, setId: "b", timer, nowMs: 59_999 }), "resting");
  assert.equal(setPhase({ logged: true, setId: "b", timer, nowMs: 60_000 }), "done");
  assert.equal(setPhase({ logged: true, setId: "a", timer, nowMs: 1 }), "done"); // an earlier set
  assert.equal(setPhase({ logged: true, setId: "a", timer: null, nowMs: 1 }), "done");
});

test("pie: full, empty and clamped fractions", () => {
  assert.equal(pieGeometry(1).kind, "full");
  assert.equal(pieGeometry(1).d, "M 12 2 A 10 10 0 1 1 12 22 A 10 10 0 1 1 12 2 Z");
  assert.deepEqual(pieGeometry(0), { kind: "empty", d: "" });
  assert.deepEqual(pieGeometry(-5), { kind: "empty", d: "" });
  assert.deepEqual(pieGeometry(NaN), { kind: "empty", d: "" });
  assert.equal(pieGeometry(7).kind, "full");
});

test("pie: the wedge that remains depletes clockwise from 12 o'clock", () => {
  // three quarters left: the top-right quarter is gone, the wedge starts at 3 o'clock
  assert.equal(pieGeometry(0.75).d, "M 12 12 L 22 12 A 10 10 0 1 1 12 2 Z");
  // half left: the right half is gone, the wedge is the left half
  assert.equal(pieGeometry(0.5).d, "M 12 12 L 12 22 A 10 10 0 0 1 12 2 Z");
  // a quarter left: only the top-left quarter remains, starting at 9 o'clock
  assert.equal(pieGeometry(0.25).d, "M 12 12 L 2 12 A 10 10 0 0 1 12 2 Z");
  // the start of the wedge moves clockwise (its angle grows) as the fraction falls
  const angleOf = (fraction) => {
    const [, x, y] = /L (\S+) (\S+) A/.exec(pieGeometry(fraction).d);
    return (Math.atan2(Number(x) - 12, 12 - Number(y)) + 2 * Math.PI) % (2 * Math.PI);
  };
  const angles = [0.95, 0.8, 0.6, 0.4, 0.2, 0.05].map(angleOf);
  assert.deepEqual([...angles].sort((a, b) => a - b), angles);
});

test("pie: a custom size scales the path", () => {
  assert.equal(pieGeometry(0.75, { cx: 50, cy: 50, r: 40 }).d, "M 50 50 L 90 50 A 40 40 0 1 1 50 10 Z");
});

// ---- colours: contrast of the states, read from the real stylesheet ----

const css = fs.readFileSync(path.join(ROOT, "src", "ui", "app.css"), "utf8");

function variables(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((match) => [match[1], match[2]]));
}
const light = variables(/:root\s*\{([^}]*)\}/.exec(css)[1]);
const dark = { ...light, ...variables(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1]) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const [name, theme] of [["light", light], ["dark", dark]]) {
  test(`colours (${name}): the done state (muted) is readable on the card and on the page`, () => {
    assert.ok(contrast(theme.muted, theme.surface) >= 4.5, `muted on surface ${contrast(theme.muted, theme.surface).toFixed(2)}`);
    assert.ok(contrast(theme.muted, theme.bg) >= 4.5, `muted on bg ${contrast(theme.muted, theme.bg).toFixed(2)}`);
  });

  test(`colours (${name}): the check glyph is readable on its filled circle, resting and done`, () => {
    assert.ok(contrast(theme.bg, theme.text) >= 4.5, "page colour on the white (resting) circle");
    assert.ok(contrast(theme.bg, theme.muted) >= 4.5, "page colour on the grey (done) circle");
  });

  test(`colours (${name}): the pie and ring are visible against the card (3:1 for non-text)`, () => {
    assert.ok(contrast(theme.text, theme.surface) >= 3);
    assert.ok(contrast(theme.muted, theme.surface) >= 3);
  });

  test(`colours (${name}): done is still distinguishable from the active text colour`, () => {
    assert.notEqual(theme.muted.toLowerCase(), theme.text.toLowerCase());
  });
}

test("styles: the timer uses tabular numerals, done is greyed with the muted colour and its outline is hidden", () => {
  assert.match(css, /\.rest-line\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.rest-time\s*\{\s*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /\.set-row\[data-phase="done"\]\s*\{\s*color:\s*var\(--muted\)/);
  assert.match(css, /\.rest-icon\[data-phase="done"\] \.rest-ring\s*\{\s*display:\s*none/);
  assert.ok(!/opacity/.test(/\/\* set rows[\s\S]*$/.exec(css)[0]), "the done state must not rely on opacity");
});

// ---- typing a rest time with digits only (an iPhone keypad has no colon) ----

test("rest entry: the last two digits are seconds and the rest are minutes, and seconds above 59 roll into minutes", () => {
  const read = (text) => parseRestEntry(text);
  assert.deepEqual(["300", "130", "45", "5", "1000"].map(read), [180, 90, 45, 5, 600]); // 3:00, 1:30, 0:45, 0:05, 10:00
  assert.deepEqual(["90", "99", "190", "960"].map(read), [90, 99, 150, 600]); // 1:30, 1:39, 2:30, 10:00
  assert.deepEqual(["0045", "0300", " 300 "].map(read), [45, 180, 180]); // leading zeros and spaces around it
});

test("rest entry: zero is allowed, and the longest is 60:00 whichever way it is typed", () => {
  assert.deepEqual(["0", "00", "000", "0:00"].map(parseRestEntry), [0, 0, 0, 0]);
  assert.equal(parseRestEntry("6000"), 3600);
  assert.equal(parseRestEntry("60:00"), 3600);
  for (const tooLong of ["6001", "6100", "9999", "60:01", "1234567"]) {
    assert.throws(() => parseRestEntry(tooLong), /can't be longer than 60:00/, tooLong);
  }
});

test("rest entry: blank, junk and half-typed times are refused with the one plain message, and never become a number", () => {
  for (const junk of ["", "   ", "abc", "-5", "3.5", "1 30", "3:5", "3:60", "1:00:00", ":30", "3:", "1e3", "０３００", null, undefined, 300, {}]) {
    assert.throws(() => parseRestEntry(junk), (error) => error.message === REST_ENTRY_HELP, String(junk));
  }
  assert.equal(REST_ENTRY_HELP, "Enter the rest time, e.g. 300 for 3:00");
});

test("rest entry: a typed colon still works (hardware keyboards) and means the same as the digits", () => {
  assert.deepEqual(["3:00", "1:30", "0:45", "0:05", "10:00", "60:00", " 2:15 "].map(parseRestEntry), [180, 90, 45, 5, 600, 3600, 135]);
  for (const seconds of [0, 5, 45, 90, 180, 600, 3599, 3600]) {
    assert.equal(parseRestEntry(formatRest(seconds)), parseRestEntry(restToDigits(seconds)));
  }
});

test("rest entry: the digits an editor starts with read back to the same rest for every rest, so saving untouched changes nothing", () => {
  assert.deepEqual([0, 5, 45, 75, 180, 600, 3600].map(restToDigits), ["0", "5", "45", "115", "300", "1000", "6000"]);
  for (let seconds = 0; seconds <= 3600; seconds += 1) {
    assert.equal(parseRestEntry(restToDigits(seconds)), seconds, `${seconds} s`);
  }
  assert.throws(() => restToDigits(3601), /60:00/);
  assert.throws(() => restToDigits(-1), /rest/);
});

test("rest entry: the live preview shows the time as it will be read, nothing for blank, and the reason when it cannot be", () => {
  assert.deepEqual(previewRestEntry("300"), { ok: true, seconds: 180, label: "3:00", message: "" });
  assert.equal(previewRestEntry("90").label, "1:30");
  assert.equal(previewRestEntry("5").label, "0:05");
  assert.deepEqual(previewRestEntry(""), { ok: false, label: "", message: "" });
  assert.deepEqual(previewRestEntry("  "), { ok: false, label: "", message: "" });
  assert.equal(previewRestEntry("x").message, REST_ENTRY_HELP);
  assert.match(previewRestEntry("6001").message, /60:00/);
});
