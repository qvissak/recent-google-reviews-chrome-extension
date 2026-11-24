import { ReviewLoaderPort } from '../../usecases/ports/ReviewLoaderPort.js';

/**
 * Drives Google's own UI to get more reviews into the page: opens the reviews
 * list, switches it to "Newest", and scrolls it to trigger lazy loading.
 * Everything it opens it puts back in close().
 *
 *  - Google Search: click "N Google reviews" (opens a modal), pick "Newest";
 *    restore = dismiss the modal.
 *  - Google Maps: select the "Reviews" tab, pick Sort > "Newest";
 *    restore = go back to the tab that was selected.
 *
 * Like the DOM reader, it avoids class names: it finds things by role, by
 * visible text and by scrollability.
 */
const BUTTONLIKE = '[role="button"], button, [role="radio"], [role="option"], [role="menuitemradio"], [role="menuitem"]';
const OWN_UI = '[data-rgr-root], [data-rgr-tip], [data-rgr-modal], [data-rgr-notice]';
const REVIEWS_OPENER_TEXT = /^\d[\d,.]*\s*(?:google\s+)?reviews?$/i;
// While we drive Google's reviews list, the stylesheet hides its dialog (QUIET_ATTR on <html>) and its page-dimming
// scrim (SCRIM_ATTR), so loading in the background never flashes Google's UI. Hidden by opacity: still laid out and scrollable.
const QUIET_ATTR = 'data-rgr-quiet';
const SCRIM_ATTR = 'data-rgr-quiet-hide';

export class GoogleReviewsLoader extends ReviewLoaderPort {
  /**
   * @param {Object} deps
   * @param {Document} deps.document
   * @param {Window} [deps.window]
   * @param {(ms: number) => Promise<void>} [deps.sleep]
   * @param {{ pollMs?: number, linkTimeoutMs?: number, openTimeoutMs?: number, sortTimeoutMs?: number, loadTimeoutMs?: number, settleMs?: number }} [deps.timing]
   *        linkTimeoutMs: how long open() waits for the reviews link (Search) or Reviews tab (Maps) to exist before giving up.
   *        It replaces a blind delay before starting: a load that begins right as the page renders starts the moment the link is there.
   */
  constructor({ document, window = document.defaultView, sleep, timing = {} }) {
    super();
    this.document = document;
    this.window = window;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    this.timing = { pollMs: 200, linkTimeoutMs: 2000, openTimeoutMs: 8000, sortTimeoutMs: 5000, loadTimeoutMs: 4000, settleMs: 300, ...timing };
    /** @type {null | (() => Promise<void>)} */
    this.restore = null;
  }

  async open() {
    this.restore = null;
    this.document.documentElement.setAttribute(QUIET_ATTR, ''); // before any click: Google's dialog must never show
    if (this.#isMaps()) await this.#openMaps();
    else await this.#openSearch();
  }

  isOpen() {
    if (this.#reviewIds().size === 0) return false;
    return this.#isMaps() ? true : Boolean(this.#googleDialog());
  }

  async loadMore() {
    const before = this.#reviewIds();
    if (before.size === 0) {
      // Nothing on the page right now. Maps empties the list while a new sort loads, so give it time to come back
      // (without scrolling anything); if it never does there is no list to load from.
      const filled = await this.#waitFor(() => this.#reviewIds().size > 0, this.timing.loadTimeoutMs);
      if (filled) await this.sleep(this.timing.settleMs);
      return Boolean(filled);
    }
    const scroller = this.#findScroller();
    if (!scroller) return false;

    scroller.scrollTop = scroller.scrollHeight;
    // Growth is "reviews I haven't seen appeared", not "the list got longer": when a slow re-sort (Newest) lands, Google
    // swaps the list for 10 different reviews of the same count, and that must not look like the end of the list.
    const grew = await this.#waitFor(() => [...this.#reviewIds()].some((id) => !before.has(id)), this.timing.loadTimeoutMs);
    if (grew) await this.sleep(this.timing.settleMs); // let the new cards finish rendering
    return grew;
  }

  async close() {
    const restore = this.restore;
    this.restore = null;
    if (restore) await restore();
    this.#unquiet();
  }

  // ----------------------------------------------------------------- Search

  async #openSearch() {
    const listAlreadyOpen = this.#reviewIds().size > 0 && Boolean(this.#googleDialog());
    if (!listAlreadyOpen) {
      // The rating row (which is what the badge hangs from) can be on the page a moment before the link beside it.
      const opener = await this.#waitFor(() => this.#findSearchOpener(), this.timing.linkTimeoutMs);
      if (!opener) return;
      opener.click();
      this.restore = async () => {
        this.#pressEscape(this.#googleDialog());
        await this.sleep(this.timing.settleMs);
      };
      await this.#waitFor(() => this.#findByLeafText('Newest'), this.timing.openTimeoutMs);
    }
    this.#hideScrims();
    await this.#chooseNewest(() => this.#findByLeafText('Newest'));
    await this.#waitFor(() => this.#reviewIds().size > 0, this.timing.openTimeoutMs);
    await this.sleep(this.timing.settleMs);
  }

  /**
   * Google dims the page with a full-viewport translucent fixed layer next to its dialog. Its class names are
   * obfuscated, so find it by what it is: a fixed, nearly viewport-sized, partly transparent layer that is not
   * the dialog (or one of its ancestors) and not ours.
   */
  #hideScrims() {
    const { innerWidth: vw, innerHeight: vh } = this.window;
    const dialog = this.#googleDialog();
    for (const el of this.document.elementsFromPoint?.(4, Math.round(vh / 2)) ?? []) {
      if (el === this.document.documentElement || el === this.document.body || el.closest(OWN_UI)) continue;
      if (dialog && (dialog.contains(el) || el.contains(dialog))) continue;
      const style = this.window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(style.backgroundColor)?.[1];
      if (style.position === 'fixed' && rect.width >= vw * 0.9 && rect.height >= vh * 0.9 && alpha !== undefined && Number(alpha) < 1 && Number(alpha) > 0) {
        el.setAttribute(SCRIM_ATTR, '');
      }
    }
  }

  #unquiet() {
    this.document.documentElement.removeAttribute(QUIET_ATTR);
    for (const el of this.document.querySelectorAll(`[${SCRIM_ATTR}]`)) el.removeAttribute(SCRIM_ATTR);
  }

  /**
   * A real link to another page. Desktop Search opens its overlay from an `<a role="button" href="#…">`; a layout where the
   * count is an ordinary link (Google's phone layout, or one we have not seen) would navigate away if clicked, so it is left alone.
   */
  #navigates(el) {
    const href = el.tagName === 'A' ? (el.getAttribute('href') ?? '') : '';
    return href !== '' && !href.startsWith('#') && !/^javascript:/i.test(href);
  }

  #findSearchOpener() {
    const candidates = [...this.document.querySelectorAll(BUTTONLIKE)].filter(
      (el) => this.#isVisible(el) && !el.closest(OWN_UI) && REVIEWS_OPENER_TEXT.test((el.textContent ?? '').trim()) && !this.#navigates(el),
    );
    return candidates.find((el) => el.closest('[data-attrid="subtitle"]')) ?? candidates[0] ?? null;
  }

  /** Google's own modal (not ours). */
  #googleDialog() {
    return (
      [...this.document.querySelectorAll('[role="dialog"]')].find((el) => this.#isVisible(el) && !el.closest(OWN_UI)) ?? null
    );
  }

  #pressEscape(target) {
    const el = target ?? this.document.body;
    for (const type of ['keydown', 'keyup']) {
      const event = new this.window.KeyboardEvent(type, {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      event.rgrSynthetic = true; // our own modal ignores this one
      el.dispatchEvent(event);
    }
  }

  // ------------------------------------------------------------------- Maps

  async #openMaps() {
    const tabs = () => [...this.document.querySelectorAll('[role="tab"]')].filter((el) => !el.closest(OWN_UI));
    // The tab strip can render a moment after the rating row the badge hangs from.
    const reviewsTab = await this.#waitFor(() => tabs().find((el) => /reviews/i.test(el.textContent ?? '')), this.timing.linkTimeoutMs);
    if (!reviewsTab) return;
    const selected = tabs().find((el) => el.getAttribute('aria-selected') === 'true') ?? null;

    if (reviewsTab !== selected) {
      reviewsTab.click();
      this.restore = async () => {
        selected?.click();
        await this.sleep(this.timing.settleMs);
      };
      await this.#waitFor(() => this.#reviewIds().size > 0, this.timing.openTimeoutMs);
    }

    const sortButton = () =>
      [...this.document.querySelectorAll('button')].find(
        (el) => this.#isVisible(el) && !el.closest(OWN_UI) && /sort/i.test(el.getAttribute('aria-label') ?? el.textContent ?? ''),
      );
    // The Overview tab already carries a few review elements, so "reviews exist" does not mean the Reviews tab has
    // rendered: wait for its Sort control, or we would skip the sort and load from the wrong order.
    await this.#waitFor(() => sortButton(), this.timing.openTimeoutMs);
    const before = this.#idSignature();
    sortButton()?.click();
    const newest = await this.#waitFor(
      () => [...this.document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find((el) => /newest/i.test(el.textContent ?? '')),
      this.timing.sortTimeoutMs,
    );
    if (newest) {
      newest.click();
      await this.#waitFor(() => this.#listReplaced(before), this.timing.sortTimeoutMs);
    }
    await this.sleep(this.timing.settleMs);
  }

  // ----------------------------------------------------------------- shared

  /** Click the "Newest" control and wait for the list to reorder (or give up quickly if it already was). */
  async #chooseNewest(find) {
    const control = find();
    if (!control) return;
    const before = this.#idSignature();
    control.click();
    await this.#waitFor(() => this.#listReplaced(before), this.timing.sortTimeoutMs);
  }

  #reviewIds() {
    return new Set(
      [...this.document.querySelectorAll('[data-review-id]')]
        .filter((el) => !el.closest(OWN_UI))
        .map((el) => el.getAttribute('data-review-id')),
    );
  }

  /** The list now holds reviews that differ from `before`: re-sorting first empties it, which must not count as done. */
  #listReplaced(before) {
    return this.#reviewIds().size > 0 && this.#idSignature() !== before;
  }

  /** Changes when the list's reviews change or reorder. */
  #idSignature() {
    return [...this.document.querySelectorAll('[data-review-id]')]
      .filter((el) => !el.closest(OWN_UI))
      .map((el) => el.getAttribute('data-review-id'))
      .join('|');
  }

  /** The scrollable container holding the review list. */
  #findScroller() {
    const markers = [...this.document.querySelectorAll('[data-review-id]')].filter((el) => !el.closest(OWN_UI));
    let node = markers[markers.length - 1] ?? null;
    while (node && node !== this.document.documentElement) {
      const { overflowY } = this.window.getComputedStyle(node);
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return this.document.scrollingElement ?? null;
  }

  #findByLeafText(text) {
    const match = [...this.document.querySelectorAll('*')].find(
      (el) => el.childElementCount === 0 && (el.textContent ?? '').trim() === text && this.#isVisible(el) && !el.closest(OWN_UI),
    );
    return match ? match.closest(BUTTONLIKE) ?? match : null;
  }

  #isVisible(el) {
    return el.getClientRects().length > 0;
  }

  #isMaps() {
    const { hostname = '', pathname = '' } = this.document.location ?? {};
    return pathname.startsWith('/maps') || hostname.startsWith('maps.');
  }

  /** Poll until `predicate()` is truthy; resolves to that value, or false on timeout. */
  async #waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() >= deadline) return false;
      await this.sleep(this.timing.pollMs);
    }
  }
}
