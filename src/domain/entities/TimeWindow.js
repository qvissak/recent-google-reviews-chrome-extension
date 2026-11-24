import { AgeUnit } from '../services/RelativeTimeParser.js';

/**
 * Enterprise rule: what counts as a "recent" review.
 *
 * Google only shows coarse relative dates ("a week ago", "3 weeks ago",
 * "a month ago", "5 months ago"), so every window is an inclusive,
 * approximate cut-off on that granularity:
 *
 *  - 1_WEEK     "a week ago" and newer
 *  - N_MONTHS   (1 to 11) "N months ago" / its equivalent in weeks and newer; 6_MONTHS is the default
 *
 * Google never says "12 months ago": reviews 12 to 23 months old read "a year ago", so 11 months is the longest
 * window that can be answered exactly. (The old 1_YEAR window, "anything shorter than a year ago", is that same window:
 * it is kept as an alias of 11_MONTHS so a stored setting keeps working.)
 */

export const TimeWindowId = Object.freeze({
  ONE_WEEK: '1_WEEK',
  ONE_MONTH: '1_MONTH',
  THREE_MONTHS: '3_MONTHS',
  SIX_MONTHS: '6_MONTHS',
  ONE_YEAR: '1_YEAR', // legacy id: normalizes to 11_MONTHS
});

export const DEFAULT_TIME_WINDOW = TimeWindowId.SIX_MONTHS;

// Google's "N months ago" means roughly N * 30.4 days; the week and day cut-offs follow from it (1 month = 30 days = 4 weeks).
const DAYS_PER_MONTH = 30.4;
const MONTHS = Object.freeze(Array.from({ length: 11 }, (_, i) => i + 1));

const monthsId = (months) => (months === 1 ? TimeWindowId.ONE_MONTH : `${months}_MONTHS`);

const monthLimits = (months) => {
  // The longest window is "anything shorter than a year" (it replaced the old 1_YEAR window, which allowed up to 364 days / 51 weeks).
  const days = months === 11 ? 364 : Math.round(months * DAYS_PER_MONTH);
  return {
    label: months === 1 ? '1 month' : months === 6 ? '~6 months' : `${months} months`,
    optionLabel: months === 1 ? 'Last month' : `Last ${months} months`,
    shortLabel: `${months}M`,
    days,
    weeks: months === 11 ? 51 : Math.floor(days / 7), // 52 weeks is a year
    months,
  };
};

const LIMITS = Object.freeze({
  [TimeWindowId.ONE_WEEK]: { label: '1 week', optionLabel: 'Last week', shortLabel: '1W', days: 7, weeks: 1, months: 0 },
  ...Object.fromEntries(MONTHS.map((months) => [monthsId(months), monthLimits(months)])),
});

const LEGACY_IDS = Object.freeze({ [TimeWindowId.ONE_YEAR]: monthsId(11) });

/** The longest window the badge can show, in months, and the range the user may choose from. */
export const MIN_MAX_MONTHS = 2;
export const MAX_MAX_MONTHS = 11;
export const DEFAULT_MAX_MONTHS = 6;

/**
 * @param {unknown} value
 * @returns {boolean} true for a whole number from MIN_MAX_MONTHS to MAX_MAX_MONTHS
 * @example isValidMaxMonths(11) // true; isValidMaxMonths(12) // false (Google says "a year ago" from there)
 */
export function isValidMaxMonths(value) {
  return Number.isInteger(value) && value >= MIN_MAX_MONTHS && value <= MAX_MAX_MONTHS;
}

export function normalizeMaxMonths(value) {
  return isValidMaxMonths(value) ? value : DEFAULT_MAX_MONTHS;
}

/**
 * The windows the badge shows side by side, shortest first (like a stock chart's 1D 5D 1M 6M), so the trend of recent
 * reviews against older ones is visible without opening anything. The longest is `maxMonths`; the middle one is half of
 * it (rounded up) and the shortest is a month, or a week when the middle one is already a month.
 * @param {number} [maxMonths]  Whole number from 2 to 11; anything else means the default.
 * @returns {readonly string[]}
 * @example trendWindowsFor(6) // ['1_MONTH', '3_MONTHS', '6_MONTHS']
 * @example trendWindowsFor(5) // ['1_MONTH', '3_MONTHS', '5_MONTHS']
 * @example trendWindowsFor(2) // ['1_WEEK', '1_MONTH', '2_MONTHS']
 */
export function trendWindowsFor(maxMonths = DEFAULT_MAX_MONTHS) {
  const max = normalizeMaxMonths(maxMonths);
  const middle = Math.ceil(max / 2);
  const shortest = middle === 1 ? TimeWindowId.ONE_WEEK : TimeWindowId.ONE_MONTH;
  return Object.freeze([shortest, monthsId(middle), monthsId(max)]);
}

/** The strip with the default longest window: 1M / 3M / 6M. */
export const TREND_WINDOWS = trendWindowsFor(DEFAULT_MAX_MONTHS);

/** Windows in display order, for dropdowns. */
export const TIME_WINDOW_OPTIONS = Object.freeze(
  Object.entries(LIMITS).map(([id, { optionLabel }]) => Object.freeze({ id, label: optionLabel })),
);

export function isValidTimeWindow(id) {
  return Object.hasOwn(LIMITS, id) || Object.hasOwn(LEGACY_IDS, id);
}

/** A known id as its current id (the legacy 1_YEAR becomes 11_MONTHS); anything unknown becomes the default. */
export function normalizeTimeWindow(id) {
  if (Object.hasOwn(LEGACY_IDS, id)) return LEGACY_IDS[id];
  return Object.hasOwn(LIMITS, id) ? id : DEFAULT_TIME_WINDOW;
}

/**
 * The window that reaches further back. Loading reviews far enough for it covers the other one too.
 * @param {string} a
 * @param {string} b
 * @returns {string}
 * @example widerTimeWindow('1_WEEK', '6_MONTHS') // '6_MONTHS'
 */
export function widerTimeWindow(a, b) {
  return LIMITS[normalizeTimeWindow(a)].days >= LIMITS[normalizeTimeWindow(b)].days ? normalizeTimeWindow(a) : normalizeTimeWindow(b);
}

/**
 * How far back to load reviews: far enough for every window the badge shows, and for the selected window if it reaches further.
 * @param {string} timeWindow  The window the reviews list shows.
 * @param {number} maxMonths  The longest window on the badge.
 * @returns {string} a window id
 * @example loadWindowFor('1_WEEK', 9) // '9_MONTHS'
 * @example loadWindowFor('11_MONTHS', 4) // '11_MONTHS'
 */
export function loadWindowFor(timeWindow, maxMonths) {
  return trendWindowsFor(maxMonths).reduce(widerTimeWindow, normalizeTimeWindow(timeWindow));
}

/** Short label for a column header, e.g. "6M" or "1W". */
export function timeWindowShortLabel(id) {
  return LIMITS[normalizeTimeWindow(id)].shortLabel;
}

/** Whole months a window reaches back (0 for a week). */
export function timeWindowMonths(id) {
  return LIMITS[normalizeTimeWindow(id)].months;
}

/** Short label, e.g. "~6 months". */
export function timeWindowLabel(id) {
  return LIMITS[normalizeTimeWindow(id)].label;
}

/** Dropdown label, e.g. "Last 6 months". */
export function timeWindowOptionLabel(id) {
  return LIMITS[normalizeTimeWindow(id)].optionLabel;
}

/**
 * @param {string} windowId
 * @param {import('../services/RelativeTimeParser.js').AgeBucket | null} bucket
 */
export function windowIncludes(windowId, bucket) {
  if (!bucket) return false;
  const limits = LIMITS[normalizeTimeWindow(windowId)];
  switch (bucket.unit) {
    case AgeUnit.JUST_NOW:
    case AgeUnit.MINUTES:
    case AgeUnit.HOURS:
      return true;
    case AgeUnit.DAYS:
      return bucket.value <= limits.days;
    case AgeUnit.WEEKS:
      return bucket.value <= limits.weeks;
    case AgeUnit.MONTHS:
      return bucket.value <= limits.months;
    default:
      return false; // YEARS and anything unknown
  }
}
