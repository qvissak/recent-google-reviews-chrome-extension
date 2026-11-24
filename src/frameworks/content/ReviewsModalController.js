/**
 * Orchestrates the reviews modal: opens it, has the use case load reviews
 * behind it, keeps its view model fresh, and reacts to the window dropdown.
 * Thin — all rules live in the use cases and the presenter.
 *
 * One rule matters for the user experience: while reviews are still being
 * loaded, nothing that depends on them (rating, count, list) is shown — they
 * are skeletons — and everything appears at once when loading finishes.
 * Otherwise the numbers would keep changing for several seconds.
 */
export class ReviewsModalController {
  /**
   * @param {Object} deps
   * @param {import('../../usecases/CalculateRecentRatingUseCase.js').CalculateRecentRatingUseCase} deps.calculateUseCase
   * @param {import('../../usecases/LoadReviewsUseCase.js').LoadReviewsUseCase} deps.loadUseCase
   * @param {import('../../adapters/presenters/ReviewsModalPresenter.js').ReviewsModalPresenter} deps.presenter
   * @param {{ render(vm: unknown): void, dispose(): void }} deps.renderer
   * @param {() => string} deps.getTimeWindow  The window the modal shows.
   * @param {() => string} [deps.getLoadWindow]  How far back to load reviews: at least the shown window, more when the badge's strip needs it. Defaults to getTimeWindow.
   * @param {(windowId: string) => Promise<void> | void} deps.setTimeWindow  Persists the choice (and updates the badge).
   * @param {(state: 'loading' | 'idle' | 'incomplete') => void} [deps.onLoadStateChange]
   *        'loading': a load is running; 'idle': the last load finished; 'incomplete': a load failed
   *        (its partial data has been discarded).
   * @param {() => Promise<void>} [deps.stopBackground]  Cancels the badge's background calculation and waits until it has let go of Google's UI.
   * @param {() => void} [deps.onVisibilityChange]  The modal just opened or closed (it does not say which: read isOpen). Lets the
   *        page decide whether it needs to explain a pause itself: a closed modal with a load still running leaves the page paused.
   */
  constructor({ calculateUseCase, loadUseCase, presenter, renderer, getTimeWindow, getLoadWindow = getTimeWindow, setTimeWindow, onLoadStateChange = () => {}, stopBackground = async () => {}, onVisibilityChange = () => {} }) {
    this.calculateUseCase = calculateUseCase;
    this.loadUseCase = loadUseCase;
    this.presenter = presenter;
    this.renderer = renderer;
    this.getTimeWindow = getTimeWindow;
    this.getLoadWindow = getLoadWindow;
    this.setTimeWindow = setTimeWindow;
    this.onLoadStateChange = onLoadStateChange;
    this.stopBackground = stopBackground;
    this.onVisibilityChange = onVisibilityChange;

    this.isOpen = false;
    this.loading = false;
    this.partial = false;
    this.exhausted = false; // Google has no more reviews to give: wider windows cannot gain anything
    // Closing the modal never cancels a load: it finishes behind the scenes (so the badge gets its result) and then puts Google's page back.
    this.detached = false;
  }

  /** True while the modal is open, or closed but still finishing a load it started: nothing else may drive Google's list. */
  get isBusy() {
    return this.isOpen || this.detached;
  }

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.onVisibilityChange();
    this.partial = false;
    this.exhausted = false;
    if (this.detached) {
      // Reopened while its load is still going: show it (skeleton, then everything at once) instead of starting a second one.
      this.detached = false;
      this.refresh();
      return;
    }

    // The badge may already have calculated this in the background: then there is nothing to wait for.
    const fresh = this.loadUseCase.freshResult({ timeWindow: this.getLoadWindow() });
    if (fresh) {
      this.partial = fresh.reason === 'max-rounds';
      this.exhausted = fresh.reason === 'exhausted';
      this.refresh();
      return;
    }

    this.#beginLoading(); // the first paint is the skeleton, never stale or partial numbers
    await this.stopBackground(); // two loads must never drive Google's list at once
    await this.#run((input) => this.loadUseCase.execute(input));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.renderer.dispose();
    if (this.loading) this.detached = true; // #run puts Google's page back when the load is done
    this.onVisibilityChange();
    if (this.loading) return;
    Promise.resolve(this.loadUseCase.release()).catch((error) => console.warn('[Recent Google Reviews] restore failed', error));
  }

  /** Re-render from the current data (cheap; called whenever anything may have changed). */
  refresh() {
    if (!this.isOpen) return;
    const summary = this.calculateUseCase.execute({ timeWindow: this.getTimeWindow() });
    this.renderer.render(this.presenter.present(summary, { loading: this.loading, partial: this.partial }));
  }

  /** "Load more reviews": loading had stopped at its cap; carry on in the same session. */
  async loadMore() {
    if (!this.isOpen || this.loading) return;
    this.partial = false;
    this.#beginLoading();
    await this.#run((input) => this.loadUseCase.extend(input));
  }

  /** The dropdown changed. */
  async changeWindow(windowId) {
    // Decide BEFORE the setting changes: saving it re-renders everything, and a wider window computed
    // from too few reviews would flash a wrong number. If more reviews are needed, go to the
    // loading state first; otherwise (narrower, or already covered) the answer is instant.
    const needsMore = this.isOpen && !this.loading && !this.exhausted && this.loadUseCase.needsMore({ timeWindow: windowId });
    this.partial = false;
    if (needsMore) this.#beginLoading();
    await this.setTimeWindow(windowId);
    if (needsMore) await this.#run((input) => this.loadUseCase.extend(input));
    else this.refresh();
  }

  #beginLoading() {
    this.loading = true;
    this.onLoadStateChange('loading');
    this.refresh();
  }

  #settle(state) {
    this.loading = false;
    this.onLoadStateChange(state);
    this.refresh(); // everything appears at once, now
  }

  async #run(run) {
    try {
      const result = await run({
        timeWindow: this.getLoadWindow, // re-read each round: the user may change it mid-load
        onLoading: () => {
          if (!this.loading) this.#beginLoading();
        },
        onProgress: () => this.refresh(),
      });
      this.partial = result.reason === 'max-rounds' || result.reason === 'stalled'; // either way there may be more to load
      this.exhausted = result.reason === 'exhausted';
      this.#settle('idle');
    } catch (error) {
      console.warn('[Recent Google Reviews] loading reviews failed', error);
      this.loadUseCase.discard();
      this.#settle('incomplete');
    }
    if (this.detached) {
      this.detached = false;
      await Promise.resolve(this.loadUseCase.release()).catch((error) => console.warn('[Recent Google Reviews] restore failed', error));
    }
  }
}
