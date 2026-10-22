import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDecimal,
  parseWholeNumber,
  formatLabel,
  formatCount,
  formatWeight,
  formatSetWeight,
  formatDateTime,
} from "../src/domain/format.js";

test("parseDecimal: accepts plain numbers and a decimal point", () => {
  assert.equal(parseDecimal("0"), 0);
  assert.equal(parseDecimal("100"), 100);
  assert.equal(parseDecimal("62.5"), 62.5);
  assert.equal(parseDecimal("007.5"), 7.5);
  assert.equal(parseDecimal("2.25"), 2.25);
  assert.equal(parseDecimal("  62.5  "), 62.5);
  assert.equal(parseDecimal("1.500"), 1.5); // a dot is always a decimal point
});

test("parseDecimal: a single comma is a decimal mark only with 1 or 2 digits after it", () => {
  assert.equal(parseDecimal("62,5"), 62.5);
  assert.equal(parseDecimal("62,25"), 62.25);
  assert.equal(parseDecimal("0,5"), 0.5);
  assert.equal(parseDecimal("100,0"), 100);
});

test("parseDecimal: rejects thousands separators and ambiguous forms", () => {
  for (const text of ["1,500", "1,5000", "1.500,5", "1,500.5", "1,5,5", "1.5.5", "62,", ",5", "1 500"]) {
    assert.throws(() => parseDecimal(text, "weight"), /weight must be a number/, text);
  }
});

test("parseDecimal: rejects exponent, hex, Infinity, NaN, signs and words", () => {
  for (const text of ["1e3", "1E3", "1e-3", "0x10", "0b1", "Infinity", "-Infinity", "NaN", "+5", "abc", "5kg", "5 kg", "6 2", ".5", "5.", "--5", "∞", "١٢"]) {
    assert.throws(() => parseDecimal(text, "weight"), /weight must be a number/, text);
  }
});

test("parseDecimal: a minus sign says the weight can't be negative, not 'must be a number'", () => {
  for (const text of ["-5", "-3", "-0", "-62.5", "-62,5", " -3 "]) {
    assert.throws(() => parseDecimal(text, "weight"), /^Error: weight can't be negative$/, text);
  }
});

test("parseDecimal: long numbers are read (the domain refuses them with the maximum), absurd ones are 'too large'", () => {
  assert.equal(parseDecimal("12345678"), 12345678);
  assert.equal(parseDecimal("920319039"), 920319039);
  assert.throws(() => parseDecimal("9".repeat(400), "weight"), /^Error: weight is too large$/);
  assert.throws(() => parseDecimal("1.23456", "weight"), /^Error: weight can have at most 4 decimal places$/);
  assert.equal(parseDecimal("1.2345"), 1.2345);
});

test("parseDecimal: blank or whitespace is an error, never 0", () => {
  for (const text of ["", " ", "   ", "\t", "\n", " ", " \t\n "]) {
    assert.throws(() => parseDecimal(text, "weight"), /weight is required/, JSON.stringify(text));
  }
  for (const notText of [undefined, null, 0, 5, NaN, {}, []]) {
    assert.throws(() => parseDecimal(notText, "weight"), /weight must be entered as text/);
  }
});

test("parseDecimal: error messages never repeat the input", () => {
  for (const text of ["secret-1e3", "1,500", "SECRET"]) {
    try {
      parseDecimal(text, "weight");
      assert.fail("expected a rejection");
    } catch (error) {
      assert.ok(!error.message.includes(text));
    }
  }
});

test("parseWholeNumber: accepts digits only", () => {
  assert.equal(parseWholeNumber("0"), 0);
  assert.equal(parseWholeNumber("12"), 12);
  assert.equal(parseWholeNumber(" 8 "), 8);
  assert.equal(parseWholeNumber("007"), 7);
});

test("parseWholeNumber: rejects everything else, and blank is an error not 0", () => {
  for (const text of ["1.5", "1,5", "+3", "1e1", "0x5", "5 reps", "abc", "1 2", "1,000", "∞"]) {
    assert.throws(() => parseWholeNumber(text, "reps"), /reps must be a whole number/, text);
  }
  assert.throws(() => parseWholeNumber("-3", "reps"), /^Error: reps can't be negative$/);
  assert.equal(parseWholeNumber("920319039"), 920319039); // read here, refused by the domain with the maximum
  assert.equal(parseWholeNumber("9999999999"), 9999999999);
  assert.throws(() => parseWholeNumber("9".repeat(400), "reps"), /^Error: reps is too large$/);
  for (const text of ["", " ", "\t\n"]) {
    assert.throws(() => parseWholeNumber(text, "reps"), /reps is required/);
  }
  assert.throws(() => parseWholeNumber(5, "reps"), /reps must be entered as text/);
});

test("formatLabel: ids become readable labels", () => {
  assert.equal(formatLabel("front_delts"), "Front delts");
  assert.equal(formatLabel("chest"), "Chest");
  assert.equal(formatLabel("pull_up_bar"), "Pull up bar");
});

test("formatCount: singular for exactly one, plural otherwise", () => {
  assert.equal(formatCount(0, "set"), "0 sets");
  assert.equal(formatCount(1, "set"), "1 set");
  assert.equal(formatCount(2, "set"), "2 sets");
  assert.equal(formatCount(1, "entry", "entries"), "1 entry");
  assert.equal(formatCount(3, "entry", "entries"), "3 entries");
});

test("formatWeight: same unit shows the stored number exactly; other unit converts and rounds to 1 decimal", () => {
  assert.equal(formatWeight(62.5, "kg", "kg"), "62.5");
  assert.equal(formatWeight(135, "lb", "lb"), "135");
  assert.equal(formatWeight(100, "kg", "lb"), "220.5");
  assert.equal(formatWeight(135, "lb", "kg"), "61.2");
  assert.equal(formatWeight(0, "kg", "lb"), "0");
  assert.equal(formatWeight(45, "lb", "kg"), "20.4");
});

test("formatSetWeight: shows the entered unit, the converted value with the original, or bodyweight", () => {
  assert.equal(formatSetWeight(100, "kg", "kg"), "100 kg");
  assert.equal(formatSetWeight(100, "kg", "lb"), "220.5 lb (entered 100 kg)");
  assert.equal(formatSetWeight(135, "lb", "kg"), "61.2 kg (entered 135 lb)");
  assert.equal(formatSetWeight(0, "kg", "lb"), "Bodyweight");
  assert.equal(formatSetWeight(0, "lb", "lb"), "Bodyweight");
});

test("formatDateTime: formats a stored UTC timestamp", () => {
  const text = formatDateTime("2026-10-22T10:00:00.000Z", { locale: "en-US", timeZone: "UTC" });
  assert.ok(text.includes("2026") && text.includes("Oct") && text.includes("10:00"), text);
  assert.throws(() => formatDateTime("yesterday"), /not a valid timestamp/);
});
