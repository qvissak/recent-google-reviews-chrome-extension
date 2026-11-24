// What: Calculates the recent rating on its own, as soon as a place page shows its badge, so the badge resolves from its skeleton to a number without a click.
// Who calls it / when: ContentScriptController, after every badge update (consider), and ReviewsModalController when the modal opens (stop).
// Gotchas: One automatic attempt per place, so a cancelled or failed run never loops. It drives Google's own reviews list
//          (hidden by the loader's stylesheet rules), so it must never run alongside the modal's load: the modal calls
//          stop() first. Nothing the user does cancels a run: only a different place (the SPA moved on) or the modal taking over.

// The strip needs six months, and a busy place can have far more than the modal's 12 pages (~120 reviews on Search) in that
// time. Stopping there would leave 3M/6M as numbers for the newest reviews only, so the automatic load goes further.
const BACKGROUND_MAX_ROUNDS = 30;

/** Identifies the place a summary belongs to: its key when the source has one (the name alone is shared by a chain's branches). */
const placeKey = (summary) => summary.placeKey ?? summary.placeName ?? '';

/**
 * Schedules and runs the automatic calculation, once per place. It owns no rules about ratings: it only decides
 * when to ask LoadReviewsUseCase to load, and keeps the badge informed through callbacks.
 *
 * @example
 * const auto = new BackgroundLoadController({ window, loadUseCase, readSummary, getTimeWindow, isModalOpen, onLoadStateChange });
 * auto.consider(summary, { badgeShown: true }); // after every badge update: starts a countdown if the place has no result yet
 * await auto.stop();                            // before the modal loads by itself
 */
export class BackgroundLoadController {
  /**
   * @param {Object} deps
   * @param {Window} deps.window
   * @param {import('../../usecases/LoadReviewsUseCase.js').LoadReviewsUseCase} deps.loadUseCase
   * @param {() => import('../../domain/entities/RatingSummary.js').RatingSummary} deps.readSummary
   * @param {() => string} deps.getTimeWindow
   * @param {() => boolean} deps.isModalOpen  True while the modal is open or still finishing a load it started: never two loads at once.
   * @param {() => boolean} [deps.isPageHidden]  True while the tab is in the background: Chrome throttles it, so Google's list would not load. We wait.
   * @param {(state: 'loading' | 'idle' | 'incomplete') => void} deps.onLoadStateChange
   * @param {number} [deps.settleMs]  Delay between the badge appearing and the load starting. 0: the loader itself waits for
   *        Google's reviews link to exist, which is what a fixed delay used to stand in for.
   * @param {number} [deps.hiddenPollMs]  How often to look again while the tab is in the background.
   * @param {number} [deps.maxRounds]  Pages to load before giving up on covering the window (the modal's default is lower).
   */
  constructor({ window, loadUseCase, readSummary, getTimeWindow, isModalOpen, isPageHidden = () => false, onLoadStateChange, settleMs = 0, hiddenPollMs = 2000, maxRounds = BACKGROUND_MAX_ROUNDS }) {
    this.window = window;
    this.loadUseCase = loadUseCase;
    this.readSummary = readSummary;
    this.getTimeWindow = getTimeWindow;
    this.isModalOpen = isModalOpen;
    this.isPageHidden = isPageHidden;
    this.onLoadStateChange = onLoadStateChange;
    this.settleMs = settleMs;
    this.hiddenPollMs = hiddenPollMs;
    this.maxRounds = maxRounds;

    this.timer = null;
    this.running = null; // Promise while a run is in flight
    this.cancelled = false;
    this.attemptedKey = null; // the place we last tried (or decided not to try) automatically
  }

  /**
   * Will this place be calculated automatically (soon, or right now)? While true the badge shows its
   * skeleton; once false and still uncalculated, it shows a click-to-calculate pill instead.
   * @param {import('../../domain/entities/RatingSummary.js').RatingSummary} summary
   * @returns {boolean}
   * @example auto.expects(summary) // true on a fresh place page, false once it has a result or was already tried
   */
  expects(summary) {
    if (summary.complete) return false;
    if (this.running) return true;
    return !this.isModalOpen() && placeKey(summary) !== this.attemptedKey;
  }

  /**
   * Called after every badge update: starts the countdown for a place that has a badge but no result yet.
   * @param {import('../../domain/entities/RatingSummary.js').RatingSummary} summary
   * @param {{ badgeShown: boolean }} state
   * @returns {void}
   * @example auto.consider(summary, { badgeShown: Boolean(document.querySelector('[data-rgr-root]')) })
   */
  consider(summary, { badgeShown }) {
    if (this.timer || !badgeShown || !this.expects(summary) || this.running) return;
    this.timer = this.window.setTimeout(() => {
      this.timer = null;
      this.#start();
    }, this.settleMs);
  }

  /**
   * Cancel any run (or pending start) and wait until Google's list has been put back. Resolves immediately when idle.
   * @returns {Promise<void>}
   * @example await auto.stop(); // then it is safe for the modal to drive Google's list
   */
  async stop() {
    this.window.clearTimeout(this.timer);
    this.timer = null;
    this.attemptedKey = placeKey(this.readSummary()); // the user took over: do not start again by ourselves
    if (!this.running) return;
    this.cancelled = true;
    await this.running;
    this.cancelled = false;
  }

  dispose() {
    this.window.clearTimeout(this.timer);
    this.timer = null;
    this.cancelled = true;
  }

  #start() {
    const summary = this.readSummary();
    if (summary.complete || this.running || this.isModalOpen() || placeKey(summary) === this.attemptedKey) return;
    if (this.isPageHidden()) {
      // A background tab: driving Google's list there stalls (the page is throttled) and would end with a wrong result.
      // Not an attempt yet: look again shortly.
      this.timer = this.window.setTimeout(() => {
        this.timer = null;
        this.#start();
      }, this.hiddenPollMs);
      return;
    }
    this.attemptedKey = placeKey(summary);
    this.running = this.#run(this.attemptedKey);
  }

  /**
   * Did the SPA move to another place? Only a different, readable name counts: while we drive Google's reviews list the
   * place name can be missing from the page (Maps' Reviews tab), and that must not be mistaken for leaving.
   */
  #movedOn(key) {
    const now = placeKey(this.readSummary());
    return now !== '' && now !== key;
  }

  async #run(key) {
    this.cancelled = false;
    this.onLoadStateChange('loading');
    let state = 'idle';
    try {
      await this.loadUseCase.execute({
        timeWindow: this.getTimeWindow,
        maxRounds: this.maxRounds,
        isCancelled: () => this.cancelled || this.#movedOn(key),
      });
    } catch (error) {
      console.warn('[Recent Google Reviews] background calculation failed', error);
      this.loadUseCase.discard();
      state = 'incomplete';
    }
    try {
      await this.loadUseCase.release(); // put Google's page back
    } catch (error) {
      console.warn('[Recent Google Reviews] restore failed', error);
    }
    const handedOver = this.cancelled; // the modal asked us to stop: it reports the load state itself
    this.running = null;
    if (!handedOver) this.onLoadStateChange(state);
  }
}
