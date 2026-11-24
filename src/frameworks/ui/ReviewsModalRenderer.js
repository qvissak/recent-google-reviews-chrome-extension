import { uiTheme } from './uiTheme.js';

const MODAL_ATTR = 'data-rgr-modal';
const SKELETON_CARDS = 3;
const BLEED_PADDING = 12; // px: a card root with at least this much side padding is a full-bleed card
const POINTER_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];

/**
 * The reviews modal: a stand-in for Google's own reviews dialog that lists only
 * the reviews inside the selected time window, with a dropdown to change it.
 *
 * Review cards are real (sanitized) copies of Google's cards, supplied by
 * `cloneCard(id)`, so they look exactly like Google's. This class knows nothing
 * about ratings or scraping; it just draws a view model.
 *
 * Builds nodes with createElement/textContent only (Google enforces Trusted Types).
 */
export class ReviewsModalRenderer {
  /**
   * @param {Object} deps
   * @param {Window} deps.window
   * @param {Document} deps.document
   * @param {(id: string) => Element | null} deps.cloneCard
   * @param {(windowId: string) => void} deps.onWindowChange
   * @param {() => void} deps.onClose
   * @param {() => void} [deps.onLoadMore]
   */
  constructor({ window, document, cloneCard, onWindowChange, onClose, onLoadMore = () => {} }) {
    this.window = window;
    this.document = document;
    this.cloneCard = cloneCard;
    this.onWindowChange = onWindowChange;
    this.onClose = onClose;
    this.onLoadMore = onLoadMore;

    this.root = null;
    this.previousFocus = null;
    this.reviewNodes = new Map(); // review id -> its <article> in the list
    this.optionsSignature = '';
    this.listMode = null; // 'loading' | 'empty' | 'ready': lets the loading skeleton persist without restarting its shimmer

    /**
     * Runs at window-capture, ahead of the page's own handlers. Google dismisses its
     * dialog on any click it considers "outside", and our modal is outside it, so
     * pointer events inside the modal are shielded here — and our own buttons are
     * handled here too, because a shielded event never reaches its target.
     */
    this.onPointer = (event) => {
      if (!this.root?.contains(event.target)) return;
      event.stopPropagation();
      if (event.type === 'mousedown' && event.target === this.root) this.onClose();
      if (event.type !== 'click') return;
      if (event.target.closest('.rgr-modal-close')) this.onClose();
      else if (event.target.closest('.rgr-load-more')) this.onLoadMore();
    };

    this.onKeydown = (event) => {
      if (event.rgrSynthetic) return; // our own "dismiss Google's dialog" keystroke
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        this.onClose();
      } else if (event.key === 'Tab') {
        this.#trapFocus(event);
      }
    };
  }

  get isOpen() {
    return this.root !== null;
  }

  /** @param {import('../../adapters/presenters/ReviewsModalPresenter.js').ReviewsModalViewModel} vm */
  render(vm) {
    if (!this.root) this.#open();
    this.#renderHeader(vm);
    this.#renderSummary(vm);
    this.#renderList(vm);
  }

  dispose() {
    if (!this.root) return;
    for (const type of POINTER_EVENTS) this.window.removeEventListener(type, this.onPointer, true);
    this.document.removeEventListener('keydown', this.onKeydown, true);
    this.root.remove();
    this.root = null;
    this.reviewNodes.clear();
    this.optionsSignature = '';
    this.listMode = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus?.();
    this.previousFocus = null;
  }

  // ------------------------------------------------------------------ build

  #el(tag, className, text) {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  #open() {
    this.previousFocus = this.document.activeElement;

    const backdrop = this.#el('div', 'rgr-modal');
    backdrop.setAttribute(MODAL_ATTR, '');
    backdrop.dataset.rgrTheme = uiTheme(this.window, this.document);

    const panel = this.#el('div', 'rgr-modal-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'rgr-modal-title');

    const header = this.#el('header', 'rgr-modal-header');
    const heading = this.#el('div', 'rgr-modal-heading');
    const title = this.#el('h2', 'rgr-modal-title');
    title.id = 'rgr-modal-title';
    heading.append(title, this.#el('p', 'rgr-modal-subtitle'));
    const close = this.#el('button', 'rgr-modal-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    header.append(heading);
    const closeBar = this.#el('div', 'rgr-modal-closebar'); // sticky, so it stays reachable while scrolling
    closeBar.append(close);

    const body = this.#el('div', 'rgr-modal-body');

    const summary = this.#el('section', 'rgr-summary');
    const score = this.#el('div', 'rgr-score');
    const value = this.#el('span', 'rgr-score-value');
    const stars = this.#el('span', 'rgr-score-stars', '★★★★★');
    stars.setAttribute('aria-hidden', 'true');
    score.append(value, stars, this.#el('span', 'rgr-score-count'), this.#el('span', 'rgr-score-delta'));

    const controls = this.#el('div', 'rgr-controls');
    const label = this.#el('label', 'rgr-window');
    label.append(this.#el('span', 'rgr-window-label', 'Show reviews from'));
    const select = this.#el('select', 'rgr-select');
    select.addEventListener('change', () => this.onWindowChange(select.value));
    const selectWrap = this.#el('span', 'rgr-select-wrap'); // hosts our chevron
    selectWrap.append(select);
    label.append(selectWrap);
    controls.append(label);

    const status = this.#el('div', 'rgr-status-row');
    const loadMore = this.#el('button', 'rgr-load-more', 'Load more reviews');
    loadMore.type = 'button';
    loadMore.hidden = true;
    status.append(this.#el('p', 'rgr-status'), loadMore);

    summary.append(score, this.#el('div', 'rgr-alltime'), controls, status);

    const list = this.#el('div', 'rgr-list');
    body.append(summary, list);
    panel.append(closeBar, header, body);
    backdrop.append(panel);

    backdrop.addEventListener(
      'wheel',
      (event) => {
        if (event.target === backdrop) event.preventDefault(); // don't scroll the page behind
      },
      { passive: false },
    );

    for (const type of POINTER_EVENTS) this.window.addEventListener(type, this.onPointer, true);

    this.document.body.append(backdrop);
    this.document.addEventListener('keydown', this.onKeydown, true);
    this.root = backdrop;
    close.focus();
  }

  #part(selector) {
    return this.root.querySelector(selector);
  }

  // ----------------------------------------------------------------- update

  #renderHeader(vm) {
    this.#part('.rgr-modal-title').textContent = vm.title;
    this.#part('.rgr-modal-subtitle').textContent = vm.subtitle;
  }

  #renderSummary(vm) {
    const { headline } = vm;
    const score = this.#part('.rgr-score');
    const loading = vm.state === 'loading';
    score.classList.toggle('rgr-score-loading', loading);
    score.setAttribute('aria-hidden', String(loading)); // placeholder text is not content; the status line says "Loading"
    score.dataset.rgrTone = headline.tone;
    // While loading, the real elements hold placeholder text of the final size (CSS hides the glyphs and shimmers
    // inside the same boxes), so nothing moves when the result arrives.
    const text = loading ? headline.placeholder : headline;
    this.#part('.rgr-score-value').textContent = text.valueText;
    this.#part('.rgr-score-stars').style.setProperty('--rgr-fill', `${Math.max(0, Math.min(5, headline.starFill)) * 20}%`);
    this.#part('.rgr-score-count').textContent = text.countText;
    const delta = this.#part('.rgr-score-delta');
    delta.textContent = text.deltaText ?? '';
    delta.hidden = text.deltaText === null || text.deltaText === undefined;

    const allTime = this.#part('.rgr-alltime');
    allTime.textContent = headline.allTimeText ?? '';
    allTime.hidden = headline.allTimeText === null;

    const status = this.#part('.rgr-status');
    status.textContent = vm.statusText;
    status.dataset.loading = String(vm.loadingMore);
    this.#part('.rgr-load-more').hidden = !vm.canLoadMore;

    this.#renderOptions(vm);
  }

  #renderOptions(vm) {
    const select = this.#part('.rgr-select');
    const signature = vm.windowOptions.map((o) => `${o.id}:${o.label}`).join('|');
    if (signature !== this.optionsSignature) {
      select.replaceChildren(
        ...vm.windowOptions.map((option) => {
          const node = this.#el('option', '', option.label);
          node.value = option.id;
          return node;
        }),
      );
      this.optionsSignature = signature;
    }
    if (select.value !== vm.selectedWindow) select.value = vm.selectedWindow;
  }

  #renderList(vm) {
    const list = this.#part('.rgr-list');

    if (vm.state === 'loading') {
      // Nothing from the growing review set is shown until loading is done. Build the skeleton
      // once and leave it alone, so repeated refreshes don't restart its shimmer.
      if (this.listMode !== 'loading') {
        this.reviewNodes.clear();
        list.replaceChildren(...Array.from({ length: SKELETON_CARDS }, () => this.#skeletonCard()));
        this.listMode = 'loading';
      }
      return;
    }

    if (vm.state === 'empty') {
      this.reviewNodes.clear();
      list.replaceChildren(this.#el('p', 'rgr-empty', vm.emptyText ?? 'No reviews in this window.'));
      this.listMode = 'empty';
      return;
    }
    this.listMode = 'ready';

    const ordered = [];
    for (const id of vm.reviewIds) {
      let node = this.reviewNodes.get(id);
      if (!node) {
        const card = this.cloneCard(id);
        if (!card) continue;
        node = this.#el('article', 'rgr-review');
        node.append(card);
        if (card.dataset?.rgrBg) this.#matchCards(card.dataset.rgrBg);
        this.#fitCard(node, card);
        this.reviewNodes.set(id, node);
      }
      ordered.push(node);
    }
    const wanted = new Set(vm.reviewIds);
    for (const id of [...this.reviewNodes.keys()]) if (!wanted.has(id)) this.reviewNodes.delete(id);

    list.replaceChildren(...ordered);
  }

  #skeletonCard() {
    const card = this.#el('div', 'rgr-review rgr-review-skeleton');
    card.setAttribute('aria-hidden', 'true');
    const bar = (extra) => this.#el('span', `rgr-skel-bar ${extra}`);
    const row = (extra) => {
      const node = this.#el('div', 'rgr-skel-row');
      node.append(bar(extra));
      return node;
    };
    const head = this.#el('div', 'rgr-skel-head');
    const who = this.#el('div', 'rgr-skel-meta-col');
    who.append(row('rgr-skel-name'), row('rgr-skel-meta'));
    head.append(bar('rgr-skel-avatar'), who);
    card.append(head, row('rgr-skel-rating'), row('rgr-skel-line-1'), row('rgr-skel-line-2'), row('rgr-skel-line-3'));
    return card;
  }

  /**
   * Lay a cloned card out the way its source did. Maps cards are full-bleed: the root pads its text
   * and the photo grid cancels that padding with negative margins. So such a card spans the whole
   * panel (its own padding insets the text, lining up with the header). Other cards just fill the
   * content width. The panel itself is never resized to suit the cards: it keeps exactly the size
   * the loading skeleton had, so nothing jumps when loading finishes.
   */
  #fitCard(node, card) {
    card.style.boxSizing = 'border-box';
    card.style.width = '100%';
    if ((Number(card.dataset.rgrPad) || 0) >= BLEED_PADDING) node.classList.add('rgr-review-bleed');
  }

  /**
   * The cards were captured with Google's colors frozen in, for whatever they sat on. Paint the modal with
   * that exact surface so the cards blend in. (The light/dark theme itself is not taken from here: it follows
   * the system on Search and is pinned to light on Maps, see uiTheme.)
   */
  #matchCards(background) {
    this.root.style.setProperty('--rgr-modal-bg', background);
  }

  #trapFocus(event) {
    const focusable = [...this.root.querySelectorAll('button, select')].filter((el) => !el.disabled && !el.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.document.activeElement;
    if (event.shiftKey && (active === first || !this.root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !this.root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
}
