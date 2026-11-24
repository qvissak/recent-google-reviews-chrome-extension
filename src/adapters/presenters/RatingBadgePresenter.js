import { RatingBadgePresenterPort } from '../../usecases/ports/RatingBadgePresenterPort.js';
import { timeWindowMonths, timeWindowShortLabel } from '../../domain/entities/TimeWindow.js';
import { fmt, formatDelta, plural, toneFor } from './formatting.js';

/** Lower-case tag in the "(6m, n=12)" text; the 6-month one keeps its tilde because Google's dates are rounded. */
const windowTag = (id) => {
  const months = timeWindowMonths(id);
  return months === 0 ? '1w' : months === 6 ? '~6m' : `${months}m`;
};

const SMALL_SAMPLE = 5;
// A window with fewer reviews than this is shown dimmed and never decides the overall trend: two reviews are noise.
const MIN_TREND_SAMPLE = 3;
// A difference of at most this many stars between the newest and the 6-month average is rounding noise, not a trend.
const FLAT_BAND = 0.1;

const toDirection = (delta) => (delta === null ? 'none' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat');

/**
 * Overall direction of recent reviews: the shortest window with enough reviews, against the average of the longest
 * window shown (or against the all-time rating when that is the window it is compared with, or the longest one is unusable).
 * @param {import('../../domain/entities/RatingSummary.js').RatingSummary[]} windows  Shortest first; the last is the longest.
 * @returns {'up' | 'down' | 'flat' | 'none'}
 */
export function overallTrend(windows) {
  // A window that reaches further back than what was loaded is a number for the newest reviews only: it decides nothing.
  const usable = windows.filter((w) => w.sampleCount >= MIN_TREND_SAMPLE && w.recentAverage !== null && w.covered !== false);
  const newest = usable[0];
  if (!newest) return 'none';
  const widest = windows.at(-1)?.timeWindow;
  const longest = usable.find((w) => w.timeWindow === widest);
  const baseline = newest === longest || !longest ? newest.allTimeRating : longest.recentAverage;
  if (baseline === null || baseline === undefined) return 'none';
  const diff = Math.round((newest.recentAverage - baseline) * 10) / 10;
  return Math.abs(diff) <= FLAT_BAND ? 'flat' : diff > 0 ? 'up' : 'down';
}

/** RatingSummary -> display strings. No DOM, no formatting of markup. */
export class RatingBadgePresenter extends RatingBadgePresenterPort {
  /**
   * @param {import('../../domain/entities/RatingSummary.js').RatingSummary} summary  The selected window (decides loading / idle / ready).
   * @param {{ pending?: boolean, willCalculate?: boolean, unsupported?: boolean, windows?: import('../../domain/entities/RatingSummary.js').RatingSummary[] }} [options]
   *        pending: reviews are being loaded right now, so show the skeleton, not a half-baked number.
   *        willCalculate: nothing is calculated yet, but the extension is about to do it by itself, so show the skeleton.
   *        When it is not going to (it already tried), show a click-to-calculate pill instead, so the badge
   *        never looks like it is loading forever.
   *        unsupported: Google is serving a layout this extension cannot read (its phone layout): show a note, no numbers.
   *        windows: the summaries shown side by side (1M, 3M, 6M), shortest first. Defaults to just `summary`.
   * @returns {import('../../usecases/ports/RatingBadgePresenterPort.js').BadgeViewModel}
   * @example presenter.present(summary, { windows: [oneMonth, threeMonths, sixMonths] }).cells.map((c) => c.valueText) // ['3.9', '4.1', '4.3']
   */
  present(summary, { pending = false, willCalculate = true, unsupported = false, windows = [summary] } = {}) {
    if (unsupported) return this.#unsupported(summary);
    const short = windowTag(summary.timeWindow);
    // No finished load (or no reviews at all) means no number, never one made from whatever snippets the page shows.
    // Not the same as "loaded, none recent".
    const notCalculated = !summary.complete || summary.totalScanned === 0;
    const loading = pending || (notCalculated && willCalculate);
    const idle = !loading && notCalculated;
    const waiting = loading || idle; // no result to show either way
    const hasSample = !waiting && windows.some((w) => w.sampleCount > 0);
    const delta = waiting ? null : formatDelta(summary.delta);

    const valueText = waiting ? '' : summary.sampleCount > 0 ? fmt(summary.recentAverage) : '–';
    const metaText = loading
      ? ''
      : idle
        ? 'Recent rating · click to calculate'
        : summary.sampleCount > 0
          ? `(${short}, n=${summary.sampleCount})`
          : `(${short}, n=0 of ${summary.totalScanned})`;
    const badgeText = loading ? 'Calculating recent rating…' : idle ? metaText : `${valueText} ★ ${metaText}`;

    const cells = windows.map((w) => this.#cell(w, waiting));
    const trend = waiting ? 'none' : overallTrend(windows);

    return {
      state: loading ? 'loading' : idle ? 'idle' : hasSample ? 'ready' : 'empty',
      tone: toneFor(summary.delta, summary.sampleCount > 0 && !waiting),
      badgeText,
      valueText,
      metaText,
      deltaShort: delta?.short ?? null,
      cells,
      trend,
      // Only used to size the skeleton: same number of cells, placeholder text of the final size.
      placeholder: {
        valueText: '0.0',
        deltaShort: '−0.0',
        metaText: `(${short}, n=00)`,
        cells: windows.map((w) => ({ windowId: w.timeWindow, label: timeWindowShortLabel(w.timeWindow), valueText: '0.0', deltaText: '0.0', sampleText: 'n=00' })),
      },
      ariaLabel: this.#ariaLabel(summary, windows, trend, loading, idle, hasSample),
      tooltip: {
        title: loading ? 'Calculating recent rating…' : idle ? 'Recent rating not calculated' : hasSample ? 'Recent reviews' : 'No recent reviews loaded',
        rows: this.#rows(summary, windows, loading, waiting),
        notes: this.#notes(summary, windows, hasSample, loading, pending, idle),
        hint: pending
          ? 'Loading reviews…'
          : waiting
            ? 'Click to load the reviews and calculate.'
            : 'Click to see the reviews behind these numbers.',
      },
    };
  }

  /** Google's phone layout opens reviews on a separate page, which cannot be read in the background: say so, once. */
  #unsupported(summary) {
    // "Recent-only" says it is not Google's all-time number. Kept to one line on the narrowest phone (360px wide, about
    // 280px of text after the pill's icon and padding): about 212px at 13px Arial, so a longer wording would wrap.
    const note = 'Recent-only rating · open on desktop';
    return {
      state: 'unsupported',
      tone: 'muted',
      badgeText: note,
      valueText: '',
      metaText: note,
      deltaShort: null,
      cells: [],
      trend: 'none',
      placeholder: { valueText: '0.0', deltaShort: '−0.0', metaText: '', cells: [] },
      ariaLabel: `${note}. Recent ratings are not available on this layout.`,
      tooltip: {
        title: 'Needs a larger screen',
        rows: [
          {
            label: 'All-time rating',
            value: summary.allTimeRating !== null ? `${fmt(summary.allTimeRating)} ★` : 'not found on page',
          },
        ],
        notes: [
          "Google's phone layout shows reviews on a separate page, which this extension can't read. Open this search on a computer (a narrow desktop window works too) to see the recent ratings.",
        ],
        hint: null,
      },
    };
  }

  /** Every loaded review had a date this extension cannot read (a non-English Google): "none are recent" would be a lie. */
  #datesUnreadable(summary) {
    return summary.totalScanned > 0 && summary.unparsedCount === summary.totalScanned;
  }

  #cell(w, waiting) {
    const hasValue = !waiting && w.sampleCount > 0;
    const delta = hasValue ? formatDelta(w.delta) : null;
    return {
      windowId: w.timeWindow,
      label: timeWindowShortLabel(w.timeWindow),
      valueText: waiting ? '' : hasValue ? fmt(w.recentAverage) : '–',
      // Magnitude only: the icon already says up or down.
      deltaText: delta ? fmt(Math.abs(w.delta)) : '',
      direction: hasValue ? toDirection(w.delta) : 'none',
      sampleText: waiting ? '' : `n=${w.sampleCount}`,
      dim: !waiting && w.sampleCount < MIN_TREND_SAMPLE,
      // Loading stopped before this window's far end (a very busy place): the value is for the newest reviews only.
      partial: !waiting && w.covered === false,
    };
  }

  #rows(summary, windows, loading, waiting) {
    const rows = windows.map((w) => {
      const d = formatDelta(w.delta);
      return {
        label: w.timeWindowLabel,
        value: loading
          ? 'calculating…'
          : waiting
            ? 'not loaded yet'
            : w.sampleCount > 0
              ? `${fmt(w.recentAverage)} ★ · n=${w.sampleCount}${d ? ` · ${d.short}` : ''}${w.covered === false ? ' · partial' : ''}`
              : w.covered === false
                ? 'not fully loaded'
                : 'no reviews',
      };
    });
    rows.push({
      label: 'All-time rating',
      value: summary.allTimeRating !== null ? `${fmt(summary.allTimeRating)} ★` : 'not found on page',
    });
    if (summary.allTimeReviewCount !== null) {
      rows.push({ label: 'All-time reviews', value: summary.allTimeReviewCount.toLocaleString('en-US') });
    }
    if (!waiting) rows.push({ label: 'Loaded on this page', value: plural(summary.totalScanned, 'review') });
    return rows;
  }

  #ariaLabel(summary, windows, trend, loading, idle, hasSample) {
    const action = 'Press to view the reviews.';
    if (loading) {
      return 'Calculating recent rating. Waiting for reviews to load. Press to load them.';
    }
    if (idle) return 'Recent rating not calculated yet. Press to load the reviews and calculate it.';
    if (!hasSample && this.#datesUnreadable(summary)) return `Review dates could not be read, so no recent rating is available. ${action}`;
    if (!hasSample) {
      return `None of the ${summary.totalScanned} loaded reviews are from the ${summary.timeWindowLabel}. ${action}`;
    }
    const parts = windows
      .filter((w) => w.sampleCount > 0)
      .map((w) => `${w.timeWindowLabel}: ${fmt(w.recentAverage)} stars from ${plural(w.sampleCount, 'review')}${w.covered === false ? ' (partial)' : ''}`);
    const all = summary.allTimeRating !== null ? ` All-time ${fmt(summary.allTimeRating)}.` : '';
    const direction = { up: ' Trending up.', down: ' Trending down.', flat: ' Steady.', none: '' }[trend];
    return `Recent ratings. ${parts.join('; ')}.${all}${direction} ${action}`;
  }

  #notes(summary, windows, hasSample, loading, pending, idle) {
    const notes = [];
    if (pending) {
      notes.push('Loading the reviews — the result appears here when it is complete.');
    } else if (loading) {
      notes.push('Calculating the recent rating automatically. This takes a few seconds.');
    } else if (idle) {
      notes.push(
        'Not calculated yet. Google only shows a few reviews on the page, so click the badge to load the recent ones and calculate.',
      );
    } else if (!hasSample && this.#datesUnreadable(summary)) {
      notes.push('The dates on the reviews could not be read: the extension understands English dates only ("2 weeks ago").');
    } else if (!hasSample) {
      notes.push(
        `None of the ${plural(summary.totalScanned, 'loaded review')} fall in the ${summary.timeWindowLabel}. Try a wider window.`,
      );
    } else if (windows.some((w) => w.sampleCount > 0 && w.sampleCount < SMALL_SAMPLE)) {
      notes.push('Small sample in some windows — treat those averages with caution.');
    }

    const partial =
      summary.allTimeReviewCount !== null && summary.totalScanned < summary.allTimeReviewCount;
    if (hasSample && (partial || summary.allTimeReviewCount === null)) {
      notes.push('Only reviews loaded so far are counted; reviews are loaded newest first.');
    }
    const partialLabels = windows.filter((w) => w.covered === false).map((w) => timeWindowShortLabel(w.timeWindow));
    if (!loading && !idle && partialLabels.length > 0) {
      notes.push(
        `Only the newest ${plural(summary.totalScanned, 'review')} could be loaded, which does not reach back far enough for ${partialLabels.join(' and ')}: those numbers are underlined and cover the newest reviews only. Click to load more.`,
      );
    }
    if (hasSample) {
      notes.push('Arrows compare each window with the all-time rating. Google rounds review dates ("a month ago"), so a window can reach back a little further than its label.');
    }
    if (summary.unparsedCount > 0 && !this.#datesUnreadable(summary)) {
      notes.push(`${plural(summary.unparsedCount, 'review')} skipped (date not recognized).`);
    }
    return notes;
  }
}

