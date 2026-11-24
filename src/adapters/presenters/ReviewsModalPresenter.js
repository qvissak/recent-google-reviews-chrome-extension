import { TIME_WINDOW_OPTIONS, timeWindowOptionLabel } from '../../domain/entities/TimeWindow.js';
import { fmt, formatDelta, plural, toneFor } from './formatting.js';

/**
 * @typedef {Object} ReviewsModalViewModel
 * @property {string} title
 * @property {string} subtitle
 * @property {{ id: string, label: string, selected: boolean }[]} windowOptions
 * @property {string} selectedWindow
 * @property {'loading'|'ready'|'empty'} state
 * @property {{ valueText: string, starFill: number, countText: string, allTimeText: string|null, deltaText: string|null, tone: string }} headline
 * @property {string} statusText
 * @property {boolean} loadingMore
 * @property {boolean} canLoadMore  Loading stopped at its cap; offer a "Load more" button.
 * @property {string|null} emptyText
 * @property {string[]} reviewIds   Reviews to list, newest first.
 */

/** RatingSummary (+ loading state) -> everything the reviews modal shows. */
export class ReviewsModalPresenter {
  /**
   * @param {import('../../domain/entities/RatingSummary.js').RatingSummary} summary
   * @param {{ loading?: boolean, partial?: boolean }} [progress]
   *        loading: more reviews are still being fetched;
   *        partial: fetching stopped before the window was fully covered.
   * @returns {ReviewsModalViewModel}
   */
  present(summary, { loading = false, partial = false } = {}) {
    const label = timeWindowOptionLabel(summary.timeWindow);
    const hasSample = summary.sampleCount > 0;
    const delta = formatDelta(summary.delta);

    const allTimeParts = [];
    if (summary.allTimeRating !== null) allTimeParts.push(`All-time ${fmt(summary.allTimeRating)} ★`);
    if (summary.allTimeReviewCount !== null) {
      allTimeParts.push(plural(summary.allTimeReviewCount, 'review').replace(/^\d+/, summary.allTimeReviewCount.toLocaleString('en-US')));
    }

    return {
      title: summary.placeName ?? 'Recent reviews',
      subtitle: `Only reviews from the ${label.toLowerCase()}`,
      windowOptions: TIME_WINDOW_OPTIONS.map(({ id, label: optionLabel }) => ({
        id,
        label: optionLabel,
        selected: id === summary.timeWindow,
      })),
      selectedWindow: summary.timeWindow,
      // While loading, nothing computed from the (still growing) review set is shown.
      state: loading ? 'loading' : hasSample ? 'ready' : 'empty',
      // While loading the headline carries no numbers at all (only the all-time figures, which the
      // page already showed and which don't change), so a view cannot leak a half-computed result.
      headline: {
        valueText: loading ? '' : hasSample ? fmt(summary.recentAverage) : '–',
        starFill: !loading && hasSample ? summary.recentAverage : 0,
        countText: loading ? '' : plural(summary.sampleCount, 'review'),
        allTimeText: allTimeParts.length > 0 ? allTimeParts.join(' · ') : null,
        deltaText: loading ? null : delta?.long ?? null,
        tone: toneFor(summary.delta, !loading && hasSample),
        // Only used to size the skeleton: the view draws these invisibly (shimmer inside the same boxes), so the
        // headline is exactly as big while loading as when the result lands.
        placeholder: { valueText: '0.0', countText: '00 reviews', deltaText: '−0.0 vs all-time' },
      },
      statusText: this.#statusText(summary, loading, partial),
      loadingMore: loading,
      canLoadMore: partial && !loading,
      emptyText: hasSample || loading
        ? null
        : summary.totalScanned === 0
          ? 'No reviews have loaded yet.'
          : `None of the ${plural(summary.totalScanned, 'loaded review')} are from the ${label.toLowerCase()}. Try a wider window.`,
      reviewIds: loading ? [] : summary.matchedReviews.map((review) => review.id).filter(Boolean),
    };
  }

  #statusText(summary, loading, partial) {
    if (loading) return `Loading reviews… ${summary.totalScanned} loaded so far`;
    const base = `Based on ${summary.sampleCount} of ${plural(summary.totalScanned, 'loaded review')}`;
    if (partial) return `${base} — stopped early, there may be more in this window.`;
    if (summary.unparsedCount > 0) return `${base} · ${plural(summary.unparsedCount, 'review')} skipped (date not recognized)`;
    return base;
  }
}
