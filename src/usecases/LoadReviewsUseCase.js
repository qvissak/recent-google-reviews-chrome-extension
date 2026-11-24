import { normalizeTimeWindow } from '../domain/entities/TimeWindow.js';
import { coversWindow, reachedEnd } from '../domain/services/ReviewCoverage.js';

export { coversWindow };

const DEFAULT_MAX_ROUNDS = 12;
// When Google gives nothing new, ask again this many times before believing the list has ended (it may just be slow).
const MAX_STALLS = 2;

/**
 * @typedef {Object} LoadInput
 * @property {string | (() => string)} timeWindow  A window id, or a getter (re-read every round, so the user can change it mid-load).
 * @property {(snapshot: import('./ports/ReviewSourcePort.js').ReviewSnapshot) => void} [onProgress]
 * @property {() => boolean} [isCancelled]
 * @property {() => void} [onLoading]  Called right before each real wait (opening the list, scrolling for more), so a view can show a loading state only when there is something to wait for.
 * @property {number} [maxRounds]  Load-more attempts (each is roughly one page of ~10 reviews).
 *
 * @typedef {{ reason: 'covered' | 'exhausted' | 'max-rounds' | 'stalled' | 'cancelled', rounds: number }} LoadResult
 *          'stalled': Google stopped giving reviews although far fewer than its total were loaded, so the reviews held are not a result.
 */

/**
 * Loads reviews until the selected time window is fully covered.
 *
 * Reviews arrive newest-first, so once a loaded review is older than the
 * window, everything inside the window has been seen and loading can stop.
 * If the loaded reviews are not in age order (we cannot trust the sort), that
 * shortcut is off and loading stops at `maxRounds` or when nothing new arrives.
 */
export class LoadReviewsUseCase {
  /**
   * @param {{
   *   reviewSource: import('./ports/ReviewSourcePort.js').ReviewSourcePort,
   *   reviewLoader: import('./ports/ReviewLoaderPort.js').ReviewLoaderPort,
   * }} deps
   */
  constructor({ reviewSource, reviewLoader }) {
    this.reviewSource = reviewSource;
    this.reviewLoader = reviewLoader;
    /** @type {LoadResult | null} how the last finished (not cancelled) load ended */
    this.last = null;
  }

  /**
   * Start a fresh session: open the reviews list (newest first) and load until the window is covered.
   * @param {LoadInput} input
   * @returns {Promise<LoadResult>}
   */
  async execute(input) {
    input.onLoading?.();
    this.last = null;
    this.reviewSource.reset(); // start from what this (newest-first) session shows
    await this.reviewLoader.open();
    return this.#fill(input);
  }

  /**
   * Keep loading in the already-open session (e.g. the user picked a wider window).
   * Does not reopen or re-sort the list, which would throw away the pages already loaded
   * (unless the list has since been closed, in which case it starts a fresh session).
   * @param {LoadInput} input
   * @returns {Promise<LoadResult>}
   */
  async extend(input) {
    if (this.reviewLoader.isOpen?.() === false) {
      // The list went away: start over, and allow more rounds than last time to get past where we were.
      return this.execute({ ...input, maxRounds: (input.maxRounds ?? DEFAULT_MAX_ROUNDS) * 2 });
    }
    return this.#fill(input);
  }

  /** Load, then mark the held reviews as a finished set (unless the load was cancelled part-way). */
  async #fill(input) {
    const result = await this.#loop(input);
    // A stalled load is not a finished set: calling it one would present, say, the 10 newest reviews as the whole picture.
    if (result.reason !== 'cancelled' && result.reason !== 'stalled') {
      this.reviewSource.markComplete?.();
      this.last = result;
    }
    return result;
  }

  async #loop({ timeWindow, onProgress = () => {}, isCancelled = () => false, onLoading = () => {}, maxRounds = DEFAULT_MAX_ROUNDS }) {
    const currentWindow = () => normalizeTimeWindow(typeof timeWindow === 'function' ? timeWindow() : timeWindow);

    let rounds = 0;
    let stalls = 0;
    for (;;) {
      const snapshot = this.reviewSource.readSnapshot();
      onProgress(snapshot);

      if (isCancelled()) return { reason: 'cancelled', rounds };
      if (coversWindow(snapshot.reviews, currentWindow())) return { reason: 'covered', rounds };
      if (rounds >= maxRounds) return { reason: 'max-rounds', rounds };

      onLoading();
      const grew = await this.reviewLoader.loadMore();
      if (isCancelled()) return { reason: 'cancelled', rounds };
      if (grew) {
        rounds += 1;
        stalls = 0;
        continue;
      }
      const now = this.reviewSource.readSnapshot();
      onProgress(now);
      if (reachedEnd(now)) return { reason: 'exhausted', rounds };
      stalls += 1;
      if (stalls > MAX_STALLS) return { reason: 'stalled', rounds };
    }
  }

  /**
   * Would showing this window need reviews that haven't been loaded yet? Lets a view start its
   * loading state first, instead of flashing numbers computed from too few reviews.
   * @param {{ timeWindow: string }} input
   */
  needsMore({ timeWindow }) {
    return !coversWindow(this.reviewSource.readSnapshot().reviews, normalizeTimeWindow(timeWindow));
  }

  /**
   * The outcome of an earlier, finished load if its reviews can answer this window as they are (so a view can show
   * them straight away, e.g. after the badge calculated in the background), else null.
   * @param {{ timeWindow: string }} input
   * @returns {LoadResult | null}
   * @example const fresh = loadUseCase.freshResult({ timeWindow: '6_MONTHS' }); if (fresh) showResultNow(fresh);
   */
  freshResult({ timeWindow }) {
    if (!this.last || this.reviewSource.readSnapshot().complete === false) return null;
    const { reason } = this.last;
    return reason === 'max-rounds' || reason === 'exhausted' || !this.needsMore({ timeWindow }) ? this.last : null;
  }

  /**
   * Forget what was loaded: a load was abandoned or failed, so the reviews held are partial and must not be shown as a result.
   * @returns {void}
   * @example loadUseCase.discard(); // after the user closed the modal mid-load
   */
  discard() {
    this.last = null;
    this.reviewSource.reset();
  }

  /** Put the page back as it was found. */
  async release() {
    await this.reviewLoader.close();
  }
}
