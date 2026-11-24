import { RatingSummary } from '../domain/entities/RatingSummary.js';
import {
  normalizeTimeWindow,
  timeWindowLabel,
  windowIncludes,
} from '../domain/entities/TimeWindow.js';
import { windowIsCovered } from '../domain/services/ReviewCoverage.js';

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Filters the loaded reviews by time window, averages their ratings and
 * compares the result with the all-time rating. The reviews that made it into
 * the sample are returned too (newest first) so a view can list exactly them.
 */
export class CalculateRecentRatingUseCase {
  /** @param {{ reviewSource: import('./ports/ReviewSourcePort.js').ReviewSourcePort }} deps */
  constructor({ reviewSource }) {
    this.reviewSource = reviewSource;
  }

  /**
   * @param {{ timeWindow?: string }} [input]
   * @returns {RatingSummary}
   */
  execute({ timeWindow } = {}) {
    return this.executeAll({ timeWindows: [timeWindow] })[0];
  }

  /**
   * One summary per window from a single read of the reviews (reading them scans the page, so don't do it per window).
   * @param {{ timeWindows: Array<string | undefined> }} input
   * @returns {RatingSummary[]}  In the order of `timeWindows`.
   * @example useCase.executeAll({ timeWindows: ['1_MONTH', '3_MONTHS', '6_MONTHS'] }).map((s) => s.recentAverage)
   */
  executeAll({ timeWindows }) {
    const snapshot = this.reviewSource.readSnapshot();
    return timeWindows.map((timeWindow) => this.#summarize(snapshot, normalizeTimeWindow(timeWindow)));
  }

  #summarize({ reviews, allTimeRating, allTimeReviewCount, placeName, placeKey, complete }, windowId) {
    const matched = [];
    let sum = 0;
    let unparsedCount = 0;
    for (const review of reviews) {
      if (!review.parsedAgeBucket) {
        unparsedCount += 1;
        continue;
      }
      if (windowIncludes(windowId, review.parsedAgeBucket)) {
        sum += review.rating;
        matched.push(review);
      }
    }
    // Stable sort: equal ages keep the order Google showed them in.
    matched.sort((a, b) => a.parsedAgeBucket.approxDays - b.parsedAgeBucket.approxDays);

    const sampleCount = matched.length;
    const recentAverage = sampleCount > 0 ? round1(sum / sampleCount) : null;
    const allTime = typeof allTimeRating === 'number' ? allTimeRating : null;
    let delta = null;
    if (recentAverage !== null && allTime !== null) {
      delta = round1(recentAverage - allTime);
      if (delta === 0) delta = 0; // normalize -0
    }

    return new RatingSummary({
      recentAverage,
      sampleCount,
      totalScanned: reviews.length,
      allTimeRating: allTime,
      delta,
      timeWindow: windowId,
      timeWindowLabel: timeWindowLabel(windowId),
      unparsedCount,
      allTimeReviewCount: allTimeReviewCount ?? null,
      placeName: placeName ?? null,
      placeKey: placeKey ?? null,
      matchedReviews: matched,
      covered: windowIsCovered({ reviews, allTimeReviewCount }, windowId),
      complete: complete !== false,
    });
  }
}
