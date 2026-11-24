// What: Decides whether a set of loaded reviews is enough to answer a time window, and whether Google's list has ended.
// Who calls it / when: LoadReviewsUseCase (to know when to stop loading) and CalculateRecentRatingUseCase (to flag windows that reach further back than what was loaded).
// Gotchas: Relies on Google listing reviews newest-first; a list that is not in age order proves nothing, so it never counts as covering a window.

import { windowIncludes } from '../entities/TimeWindow.js';

// A list that ended with at least this share of the reviews Google says exist is treated as complete.
const END_OF_LIST_SHARE = 0.9;

/**
 * True when the reviews are in age order and at least one is older than the window, i.e. everything inside the window has been seen.
 * @param {import('../entities/Review.js').Review[]} reviews
 * @param {string} windowId
 * @returns {boolean}
 * @example coversWindow([twoDaysAgo, eightMonthsAgo], '6_MONTHS') // true
 */
export function coversWindow(reviews, windowId) {
  let previous = -Infinity;
  let sawOlder = false;
  for (const review of reviews) {
    const bucket = review.parsedAgeBucket;
    if (!bucket) continue;
    if (bucket.approxDays < previous) return false; // not newest-first: can't conclude anything
    previous = bucket.approxDays;
    if (!windowIncludes(windowId, bucket)) sawOlder = true;
  }
  return sawOlder;
}

/**
 * Has the list really ended: nearly everything Google says exists is loaded (or Google never said how many)?
 * @param {{ reviews: unknown[], allTimeReviewCount?: number | null }} snapshot
 * @returns {boolean}
 * @example reachedEnd({ reviews: new Array(95), allTimeReviewCount: 100 }) // true
 */
export function reachedEnd({ reviews, allTimeReviewCount }) {
  return allTimeReviewCount === null || allTimeReviewCount === undefined || reviews.length >= allTimeReviewCount * END_OF_LIST_SHARE;
}

/**
 * Can the loaded reviews answer this window exactly? Either one of them is older than the window, or the whole list is loaded.
 * A window that fails this reaches further back than what was loaded (e.g. a busy place that hit the page cap), so its numbers are partial.
 * Stricter than the loader's stop rule: when Google gave no total there is no proof the list ended, so it does not count.
 * @param {{ reviews: import('../entities/Review.js').Review[], allTimeReviewCount?: number | null }} snapshot
 * @param {string} windowId
 * @returns {boolean}
 * @example windowIsCovered({ reviews: newest120, allTimeReviewCount: 900 }, '6_MONTHS') // false when all 120 are from this week
 */
export function windowIsCovered(snapshot, windowId) {
  const total = snapshot.allTimeReviewCount;
  return coversWindow(snapshot.reviews, windowId) || (typeof total === 'number' && reachedEnd(snapshot));
}
