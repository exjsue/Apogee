import test from "node:test";
import assert from "node:assert/strict";
import { isReminderDue, snoozeUntil, REMINDER_AFTER_DAYS, REMINDER_SNOOZE_DAYS } from "../src/domain/backup-reminder.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-10-23T12:00:00.000Z";
const daysBefore = (days) => new Date(Date.parse(NOW) - days * DAY).toISOString();

test("reminder: the thresholds are 14 days to remind and 7 to snooze", () => {
  assert.equal(REMINDER_AFTER_DAYS, 14);
  assert.equal(REMINDER_SNOOZE_DAYS, 7);
});

test("reminder: never exported and no workouts logged is not due", () => {
  assert.equal(isReminderDue({ now: NOW, lastExportAt: null, dismissedUntil: null, workoutCount: 0 }), false);
});

test("reminder: never exported and at least one workout is due", () => {
  assert.equal(isReminderDue({ now: NOW, lastExportAt: null, dismissedUntil: null, workoutCount: 1 }), true);
});

test("reminder: a confirmed export older than 14 days is due, but exactly 14 days is not", () => {
  assert.equal(isReminderDue({ now: NOW, lastExportAt: daysBefore(14), dismissedUntil: null, workoutCount: 0 }), false);
  assert.equal(isReminderDue({ now: NOW, lastExportAt: daysBefore(14.001), dismissedUntil: null, workoutCount: 0 }), true);
});

test("reminder: a recent confirmed export is not due, whatever the workout count", () => {
  assert.equal(isReminderDue({ now: NOW, lastExportAt: daysBefore(1), dismissedUntil: null, workoutCount: 50 }), false);
});

test("reminder: a dismissal hides it until the snooze time, then it returns", () => {
  const dismissedUntil = snoozeUntil(NOW);
  assert.equal(dismissedUntil, "2026-10-30T12:00:00.000Z");
  const inputs = { lastExportAt: null, workoutCount: 3, dismissedUntil };
  assert.equal(isReminderDue({ now: "2026-10-29T23:59:59.999Z", ...inputs }), false);
  assert.equal(isReminderDue({ now: dismissedUntil, ...inputs }), true);
});

test("reminder: accepts Date objects as well as ISO strings", () => {
  assert.equal(isReminderDue({ now: new Date(NOW), lastExportAt: daysBefore(20), dismissedUntil: null, workoutCount: 0 }), true);
});

test("reminder: an invalid time is an error, not a silent answer", () => {
  assert.throws(() => isReminderDue({ now: "not a date", lastExportAt: null, dismissedUntil: null, workoutCount: 1 }), /valid date/);
});
