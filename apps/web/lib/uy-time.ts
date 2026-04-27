/**
 * Uruguay timezone helpers.
 *
 * Uruguay is UTC-3 year-round (no DST since 2015 per Decree 411/014). All
 * "today" / "this month" computations on the dashboard MUST use UY-local
 * boundaries, not server-local — Vercel/Render run in UTC, so a naive
 * `new Date(y, m, d)` would interpret midnight as UTC, missing the 21:00–24:00
 * UY window every day (and silently misattributing 3 hours of activity to
 * the wrong calendar day / month).
 *
 * Why a fixed offset and not Intl.DateTimeFormat with timeZone:'America/Montevideo':
 *   1. UY DST is not coming back; 2015 was the last time it changed.
 *   2. Intl-based math requires parsing formatted strings — fragile and
 *      ~50× slower than arithmetic on epoch ms.
 *   3. Tests stay deterministic without faking timezones.
 *
 * If UY ever reinstates DST, this file is the single switch to flip.
 */
const UY_OFFSET_MS = 3 * 60 * 60 * 1000; // UY = UTC-3, fixed.

/**
 * Returns the UTC `Date` corresponding to 00:00 UY of the day that contains
 * `now` (defaults to `Date.now()`).
 *
 * Example: at 2026-04-27 22:30 UY (= 2026-04-28 01:30 UTC), this returns
 * the UTC instant 2026-04-27 03:00 UTC — i.e. 00:00 UY of April 27, the
 * "today" the user perceives.
 */
export function startOfDayUy(now: Date = new Date()): Date {
  // Shift the epoch back by 3h so that getUTC*() returns the UY-clock date
  // components instead of UTC ones.
  const uyClock = new Date(now.getTime() - UY_OFFSET_MS);
  const y = uyClock.getUTCFullYear();
  const m = uyClock.getUTCMonth();
  const d = uyClock.getUTCDate();
  // Date.UTC(y,m,d) gives midnight UTC; adding 3h yields midnight UY in UTC.
  return new Date(Date.UTC(y, m, d) + UY_OFFSET_MS);
}

/**
 * Returns the UTC `Date` corresponding to 00:00 UY of the 1st of the month
 * that contains `now` (defaults to `Date.now()`).
 */
export function startOfMonthUy(now: Date = new Date()): Date {
  const uyClock = new Date(now.getTime() - UY_OFFSET_MS);
  const y = uyClock.getUTCFullYear();
  const m = uyClock.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) + UY_OFFSET_MS);
}
