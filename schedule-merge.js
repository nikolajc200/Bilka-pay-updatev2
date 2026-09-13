/**
 * Folds imported UKG shifts into a plan's shifts without disturbing anything
 * entered by hand. Pure and dependency-free so the browser and the nightly
 * server job apply exactly the same rules — the merge is the part that must
 * never disagree between the two.
 *
 * Only shifts previously imported (`source: "ukg"`) are updated or withdrawn,
 * and withdrawals happen only inside the window the feed actually covers, so
 * older pay periods are never touched.
 */
export function mergeSchedule(existingShifts = {}, imported = {}, { from, to } = {}) {
  const shifts = { ...existingShifts };
  const added = [];
  const updated = [];
  const removed = [];
  let kept = 0;

  for (const [date, incoming] of Object.entries(imported)) {
    const existing = shifts[date];

    if (!existing) {
      shifts[date] = { ...incoming, pauseOverride: incoming.pauseOverride ?? null };
      added.push({ date, time: incoming.time });
      continue;
    }
    if (existing.source !== "ukg") {
      kept += 1;
      continue;
    }
    if (existing.time !== incoming.time) {
      // A pause the user typed themselves outlives a roster change.
      shifts[date] = { ...incoming, pauseOverride: existing.pauseOverride ?? null };
      updated.push({ date, time: incoming.time, was: existing.time });
    }
  }

  if (from && to) {
    for (const [date, shift] of Object.entries(shifts)) {
      if (date < from || date > to) continue;
      if (shift?.source === "ukg" && !imported[date]) {
        removed.push({ date, time: shift.time });
        delete shifts[date];
      }
    }
  }

  const sortByDate = (a, b) => a.date.localeCompare(b.date);
  added.sort(sortByDate);
  updated.sort(sortByDate);
  removed.sort(sortByDate);

  return {
    shifts,
    added,
    updated,
    removed,
    kept,
    changed: added.length + updated.length + removed.length > 0
  };
}
