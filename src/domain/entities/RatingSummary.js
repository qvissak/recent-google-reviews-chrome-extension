/**
 * Value object: the result of comparing recent reviews with the all-time rating.
 *
 * recentAverage / delta / allTimeRating are null when unknown (no matching
 * reviews, or the all-time rating was not found on the page).
 */
export class RatingSummary {
  /**
   * @param {Object} props
   * @param {number|null} props.recentAverage   Mean of matching reviews, 1 dp.
   * @param {number} props.sampleCount          Reviews inside the window (n).
   * @param {number} props.totalScanned         Reviews found in the DOM.
   * @param {number|null} props.allTimeRating
   * @param {number|null} props.delta           recentAverage - allTimeRating, 1 dp.
   * @param {string} props.timeWindow           TimeWindowId.
   * @param {string} props.timeWindowLabel      Human label, e.g. "~6 months".
   * @param {number} [props.unparsedCount]      Scanned reviews whose date could not be parsed.
   * @param {number|null} [props.allTimeReviewCount]  Total review count Google shows, if found.
   * @param {string|null} [props.placeName]
   * @param {string|null} [props.placeKey]  Identity of the place (the name alone is not unique: chains have several branches).
   * @param {import('./Review.js').Review[]} [props.matchedReviews]  The reviews inside the window, newest first.
   * @param {boolean} [props.covered]  The loaded reviews reach back past this window (or the whole list is loaded), so its numbers are exact. False when loading stopped early (e.g. a very busy place): the numbers are then for the newest reviews only.
   * @param {boolean} [props.complete]  The review set was fully loaded (as opposed to whatever happened to be on the page, e.g. the
   *        two or three snippets Google Maps shows on its Overview tab). Only a complete set gives a trustworthy average.
   */
  constructor({
    recentAverage,
    sampleCount,
    totalScanned,
    allTimeRating,
    delta,
    timeWindow,
    timeWindowLabel,
    unparsedCount = 0,
    allTimeReviewCount = null,
    placeName = null,
    placeKey = null,
    matchedReviews = [],
    covered = true,
    complete = true,
  }) {
    this.recentAverage = recentAverage;
    this.sampleCount = sampleCount;
    this.totalScanned = totalScanned;
    this.allTimeRating = allTimeRating;
    this.delta = delta;
    this.timeWindow = timeWindow;
    this.timeWindowLabel = timeWindowLabel;
    this.unparsedCount = unparsedCount;
    this.allTimeReviewCount = allTimeReviewCount;
    this.placeName = placeName;
    this.placeKey = placeKey;
    this.matchedReviews = Object.freeze([...matchedReviews]);
    this.covered = covered;
    this.complete = complete;
    Object.freeze(this);
  }
}
