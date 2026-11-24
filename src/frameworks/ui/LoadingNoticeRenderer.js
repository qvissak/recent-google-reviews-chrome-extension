// What: Draws the "this page is paused for a few seconds, and why" notice over Google Search / Maps.
// Who calls it / when: ContentScriptController.syncNotice, on every update while the badge is calculating.
// Gotchas: The user cannot dismiss it: it has no control, and clicks, Escape and Tab do nothing. Whoever owns the calculation
//          takes it down (when the calculation ends, or after a timeout). While we drive Google's reviews list its (hidden)
//          dialog is still open, and Google closes it on any click or Escape it considers "outside" it. This notice is
//          outside it, so pointer events and Escape are caught at window-capture and stopped here, like ReviewsModalRenderer,
//          or one click would break the load. Our own synthetic Escape (rgrSynthetic, sent when the loader restores the
//          page) must pass through. Uses role="alertdialog", not "dialog": the loader treats any other [role="dialog"] as
//          Google's dialog, and the stylesheet hides those while it loads. The data-rgr-notice attribute keeps it out of
//          every "own UI" scan.
import { uiTheme } from './uiTheme.js';

const NOTICE_ATTR = 'data-rgr-notice';
const POINTER_EVENTS = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];

/**
 * Builds nodes with createElement/textContent only (Google enforces Trusted Types). Draws a view model and knows
 * nothing about loading: whoever owns the load decides when to call render() and dispose().
 */
export class LoadingNoticeRenderer {
  /**
   * @param {Object} deps
   * @param {Window} deps.window
   * @param {Document} deps.document
   * @example new LoadingNoticeRenderer({ window, document })
   */
  constructor({ window, document }) {
    this.window = window;
    this.document = document;
    this.root = null;
    this.previousFocus = null;

    this.onPointer = (event) => {
      if (this.root?.contains(event.target)) event.stopPropagation();
    };

    this.onKeydown = (event) => {
      if (event.rgrSynthetic) return;
      if (event.key === 'Escape') {
        event.stopPropagation(); // Google would close its (hidden) dialog, and the load with it
        event.preventDefault();
      } else if (event.key === 'Tab') {
        event.preventDefault(); // nothing to reach: keep focus off the page it covers
        this.root?.querySelector('.rgr-notice-panel')?.focus();
      }
    };
  }

  get isShown() {
    return this.root !== null;
  }

  /**
   * Shows the notice, or does nothing when it is already up (called on every page update).
   * @param {import('../../adapters/presenters/LoadingNoticePresenter.js').LoadingNoticeViewModel} vm
   */
  render(vm) {
    if (this.root) return;
    this.previousFocus = this.document.activeElement;

    const backdrop = this.#el('div', 'rgr-notice');
    backdrop.setAttribute(NOTICE_ATTR, '');
    backdrop.dataset.rgrTheme = uiTheme(this.window, this.document);

    const panel = this.#el('div', 'rgr-notice-panel');
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'rgr-notice-title');
    panel.setAttribute('aria-describedby', 'rgr-notice-lead');
    panel.tabIndex = -1; // focusable by script only: it holds focus so a screen reader reads the dialog

    const title = this.#el('h2', 'rgr-notice-title', vm.title);
    title.id = 'rgr-notice-title';
    const lead = this.#el('p', 'rgr-notice-lead', vm.lead);
    lead.id = 'rgr-notice-lead';
    const progress = this.#el('div', 'rgr-notice-progress'); // indeterminate: we cannot know how many reviews there are to read
    progress.setAttribute('aria-hidden', 'true');

    panel.append(
      title,
      lead,
      progress,
      this.#el('h3', 'rgr-notice-why', vm.whyTitle),
      ...vm.reasons.map((text) => this.#el('p', 'rgr-notice-reason', text)),
      this.#el('p', 'rgr-notice-footnote', vm.footnote),
    );
    backdrop.append(panel);

    for (const type of POINTER_EVENTS) this.window.addEventListener(type, this.onPointer, true);
    this.document.addEventListener('keydown', this.onKeydown, true);
    this.document.body.append(backdrop);
    this.root = backdrop;
    panel.focus();
  }

  dispose() {
    if (!this.root) return;
    for (const type of POINTER_EVENTS) this.window.removeEventListener(type, this.onPointer, true);
    this.document.removeEventListener('keydown', this.onKeydown, true);
    this.root.remove();
    this.root = null;
    if (this.previousFocus?.isConnected) this.previousFocus.focus?.();
    this.previousFocus = null;
  }

  #el(tag, className, text) {
    const node = this.document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
}
