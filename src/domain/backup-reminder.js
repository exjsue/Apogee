// The backup reminder rule. Pure: no DOM, no storage, no network. The caller
// reads the stored values and passes them in.
//
// The reminder is due when the last CONFIRMED export is more than 14 days old,
// or when no export has ever been confirmed and at least one workout is logged.
// Dismissing it hides it until `dismissedUntil`, 7 days after the dismissal.

export const REMINDER_AFTER_DAYS = 14;
export const REMINDER_SNOOZE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// A Date or an ISO string, as a number of milliseconds.
function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error("time must be a valid date");
  return ms;
}

// lastExportAt: when the last confirmed export was made, or null if none.
// dismissedUntil: when a dismissal ends, or null if the reminder was never dismissed.
export function isReminderDue({ now, lastExportAt, dismissedUntil, workoutCount }) {
  const current = toMs(now);
  if (dismissedUntil !== null && current < toMs(dismissedUntil)) return false;
  if (lastExportAt === null) return workoutCount > 0;
  return current - toMs(lastExportAt) > REMINDER_AFTER_DAYS * DAY_MS;
}

// The time a dismissal lasts until, as a UTC ISO string.
export function snoozeUntil(now) {
  return new Date(toMs(now) + REMINDER_SNOOZE_DAYS * DAY_MS).toISOString();
}
