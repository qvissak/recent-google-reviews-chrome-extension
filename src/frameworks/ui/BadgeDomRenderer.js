import { uiTheme } from './uiTheme.js';

const ROOT_ATTR = 'data-rgr-root'; // the badge
const TIP_ATTR = 'data-rgr-tip'; // its tooltip (lives on <body>, see #build)
const MAX_PLACEMENT_CLIMB = 4;
const MAX_CLIP_CLIMB = 10;
const MAX_CLIP_ESCAPES = 3;
const GAP_TARGET = 8; // px between the rating row and the badge
const GAP_TOLERANCE = 4; // leave it alone unless it is this much larger
let idCounter = 0;

const SVG_NS = 'http://www.w3.org/2000/svg';
// Angular trend arrows like a stock ticker's: a jagged line that ends in an arrowhead (16x16 box).
const TREND_ICON = Object.freeze({
  up: { line: '1,13 5,7 8.5,10.5 13,3.5', head: '15,1 10.6,1.8 14.2,5.4' },
  down: { line: '1,3 5,9 8.5,5.5 13,12.5', head: '15,15 10.6,14.2 14.2,10.6' },
  flat: { line: '1,8 11,8', head: '15,8 10.6,5.4 10.6,10.6' },
});

/**
 * Renders the badge + tooltip from a presenter view model. Knows nothing about
 * reviews or ratings; it only needs to be told where the anchor is.
 *
 * - Builds nodes with createElement/textContent only (Google enforces Trusted Types).
 * - The tooltip is appended to <body>: Google's side panels clip or re-contain
 *   `position: fixed` descendants, which cut the tooltip off at the panel edge.
 */
export class BadgeDomRenderer {
  /**
   * @param {{ window: Window, document: Document, locateAnchor: () => Element | null, onActivate?: (windowId?: string) => void }} deps
   *        onActivate: called when the badge is clicked (opens the reviews modal), with the window of the cell that was clicked.
   */
  constructor({ window, document, locateAnchor, onActivate = () => {} }) {
    this.window = window;
    this.document = document;
    this.locateAnchor = locateAnchor;
    this.onActivate = onActivate;
    this.listening = false;
    /** badge root -> the anchor it was rendered for (it may have moved out of a clipping container) */
    this.anchors = new WeakMap();

    this.onDocumentClick = (event) => {
      for (const root of this.#roots()) {
        const tip = this.#tipOf(root);
        if (!root.contains(event.target) && !tip?.contains(event.target)) this.#close(root, true);
      }
    };
    this.onKeydown = (event) => {
      if (event.key === 'Escape') this.#roots().forEach((root) => this.#close(root, true));
    };
    this.onScroll = (event) => {
      if (event.target instanceof this.window.Node && event.target.closest?.(`[${TIP_ATTR}]`)) return;
      this.#roots().forEach((root) => this.#close(root, false));
    };
  }

  /** @param {import('../../usecases/ports/RatingBadgePresenterPort.js').BadgeViewModel} viewModel */
  render(viewModel) {
    const anchor = this.locateAnchor();
    if (!anchor) {
      this.remove();
      return;
    }

    const target = this.#placement(anchor);
    const roots = this.#roots();
    const existing = roots.find((r) => this.anchors.get(r) === anchor);
    roots.filter((r) => r !== existing).forEach((r) => this.#discard(r)); // never more than one badge
    this.#sweepTips();

    const signature = JSON.stringify(viewModel);
    if (existing?.getAttribute('data-rgr-sig') === signature) {
      // Nothing to redraw, but Google's layout may have settled since we placed the badge (fonts, images): re-check the gap.
      this.#tightenGap(existing, anchor);
      return;
    }

    const wasLoading = existing?.dataset.rgrState === 'loading';
    const wasOpen = existing?.classList.contains('rgr-open') ?? false;
    const wasPinned = existing?.classList.contains('rgr-pinned') ?? false;
    const fresh = this.#build(viewModel, signature, uiTheme(this.window, this.document));
    if (wasLoading && viewModel.state !== 'loading') fresh.classList.add('rgr-enter'); // skeleton -> result
    if (existing) {
      this.#tipOf(existing)?.remove();
      existing.replaceWith(fresh);
    } else if (target.mode === 'inside') {
      target.ref.appendChild(fresh);
    } else {
      target.ref.insertAdjacentElement('afterend', fresh);
    }
    this.anchors.set(fresh, anchor);
    this.#escapeClipping(fresh);
    this.#tightenGap(fresh, anchor);
    if (wasOpen) this.#open(fresh, wasPinned);
    this.#listen();
  }

  remove() {
    this.#roots().forEach((r) => this.#discard(r));
    this.#sweepTips();
  }

  dispose() {
    this.remove();
    if (!this.listening) return;
    this.document.removeEventListener('click', this.onDocumentClick, true);
    this.document.removeEventListener('keydown', this.onKeydown, true);
    this.window.removeEventListener('scroll', this.onScroll, true);
    this.listening = false;
  }

  // ---------------------------------------------------------------- private

  #roots() {
    return [...this.document.querySelectorAll(`[${ROOT_ATTR}]`)];
  }

  #tipOf(root) {
    const id = root.getAttribute('data-rgr-tip-id');
    return id ? this.document.getElementById(id) : null;
  }

  #discard(root) {
    this.#tipOf(root)?.remove();
    root.remove();
  }

  /** Remove tooltips whose badge Google's re-render dropped from the page. */
  #sweepTips() {
    const liveIds = new Set(this.#roots().map((r) => r.getAttribute('data-rgr-tip-id')));
    for (const tip of this.document.querySelectorAll(`[${TIP_ATTR}]`)) {
      if (!liveIds.has(tip.id)) tip.remove();
    }
  }

  #listen() {
    if (this.listening) return;
    this.document.addEventListener('click', this.onDocumentClick, true);
    this.document.addEventListener('keydown', this.onKeydown, true);
    this.window.addEventListener('scroll', this.onScroll, true);
    this.listening = true;
  }

  /**
   * Where the badge goes: on its own line after the rating row. If the row sits
   * in flex/grid rows (a sibling would land beside it and squeeze or stretch it),
   * climb out until the parent is normal block flow. If every ancestor within
   * reach is a row layout, fall back to appending inside the anchor.
   */
  #placement(anchor) {
    let node = anchor;
    for (let i = 0; i < MAX_PLACEMENT_CLIMB; i += 1) {
      const parent = node.parentElement;
      if (!parent || !this.#isRowLayout(parent)) return { ref: node, mode: 'after' };
      node = parent;
    }
    return { ref: anchor, mode: 'inside' };
  }

  /**
   * Some Google headers are fixed-height with overflow:hidden, which would clip
   * a badge added inside them. If the badge ends up below a clipping ancestor's
   * visible box, move it to just after that ancestor (repeat if needed).
   */
  #escapeClipping(root) {
    for (let i = 0; i < MAX_CLIP_ESCAPES; i += 1) {
      const rect = root.getBoundingClientRect();
      if (rect.height === 0) return; // not laid out (hidden, or no layout engine)
      const clipper = this.#findClipper(root, rect);
      if (!clipper) return;
      clipper.insertAdjacentElement('afterend', root);
    }
  }

  /**
   * Google's header blocks often reserve empty space under the rating row, so a badge
   * placed after the block floats well below it. Measure the gap and pull the badge
   * up to a consistent distance (never pushes it down).
   */
  #tightenGap(root, anchor) {
    const badge = root.getBoundingClientRect();
    if (badge.height === 0) return; // not laid out
    const gap = badge.top - anchor.getBoundingClientRect().bottom;
    if (gap <= GAP_TARGET + GAP_TOLERANCE) return;
    const margin = Number.parseFloat(this.window.getComputedStyle(root).marginTop) || 0;
    root.style.marginTop = `${Math.round(margin - (gap - GAP_TARGET))}px`;
  }

  #findClipper(root, rect) {
    let node = root.parentElement;
    for (let depth = 0; node && node !== this.document.body && depth < MAX_CLIP_CLIMB; depth += 1, node = node.parentElement) {
      const { overflowY } = this.window.getComputedStyle(node);
      if ((overflowY === 'hidden' || overflowY === 'clip') && node.getBoundingClientRect().bottom < rect.bottom - 1) {
        return node;
      }
    }
    return null;
  }

  #isRowLayout(parent) {
    if (!parent) return false;
    const style = this.window.getComputedStyle(parent);
    if (style.display === 'grid' || style.display === 'inline-grid') return true;
    if (style.display === 'flex' || style.display === 'inline-flex') {
      return style.flexDirection.startsWith('row');
    }
    return false;
  }

  /** The overall direction, as one bigger icon in a fixed-width slot (so the skeleton and the result are the same size). */
  #lead(direction, skeleton) {
    const lead = this.#el('span', skeleton ? 'rgr-lead rgr-skel-icon' : 'rgr-lead');
    lead.dataset.rgrDir = direction;
    if (direction !== 'none') lead.append(this.#icon(direction));
    return lead;
  }

  /** One cell per window: label + sample size on top, rating + ticker arrow with the difference below. */
  #cells(vm, skeleton) {
    const wrap = this.#el('span', 'rgr-cells');
    for (const c of skeleton ? vm.placeholder.cells : vm.cells) {
      const cell = this.#el('span', ['rgr-cell', c.dim && 'rgr-dim', c.partial && 'rgr-partial'].filter(Boolean).join(' '));
      cell.dataset.rgrWindow = c.windowId;
      cell.dataset.rgrDir = skeleton ? 'none' : c.direction;
      const head = this.#el('span', 'rgr-cell-head');
      head.append(
        this.#el('span', 'rgr-cell-label', c.label),
        this.#el('span', skeleton ? 'rgr-cell-n rgr-skel-text' : 'rgr-cell-n', c.sampleText),
      );
      const main = this.#el('span', 'rgr-cell-main');
      const delta = this.#el('span', 'rgr-cell-delta');
      if (skeleton) delta.append(this.#icon('flat', 'rgr-skel-icon'), this.#el('span', 'rgr-skel-text', c.deltaText));
      else if (c.deltaText) delta.append(this.#icon(c.direction), this.#el('span', '', c.deltaText));
      main.append(this.#el('span', skeleton ? 'rgr-cell-value rgr-skel-text' : 'rgr-cell-value', c.valueText), delta);
      cell.append(head, main);
      wrap.append(cell);
    }
    return wrap;
  }

  /** A small desktop-monitor icon: "this needs a computer". */
  #screenIcon() {
    const svg = this.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'rgr-screen-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attrs] of [
      ['rect', { x: '1.5', y: '2.5', width: '13', height: '8', rx: '1.5' }],
      ['line', { x1: '5.5', y1: '13.5', x2: '10.5', y2: '13.5' }],
      ['line', { x1: '8', y1: '10.5', x2: '8', y2: '13.5' }],
    ]) {
      const node = this.document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '1.5');
      svg.append(node);
    }
    return svg;
  }

  #icon(direction, extraClass = '') {
    const { line, head } = TREND_ICON[direction] ?? TREND_ICON.flat;
    const svg = this.document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', `rgr-trend-icon ${extraClass}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const polyline = this.document.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('points', line);
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', 'currentColor');
    polyline.setAttribute('stroke-width', '2');
    polyline.setAttribute('stroke-linejoin', 'miter');
    const polygon = this.document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', head);
    polygon.setAttribute('fill', 'currentColor');
    svg.append(polyline, polygon);
    return svg;
  }

  #el(tag, className, text) {
    const node = this.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  #build(vm, signature, theme) {
    const tipId = `rgr-tip-${(idCounter += 1)}`;

    const root = this.#el('span', 'rgr-root');
    root.setAttribute(ROOT_ATTR, '');
    root.setAttribute('data-rgr-sig', signature);
    root.setAttribute('data-rgr-tip-id', tipId);
    root.dataset.rgrTone = vm.tone;
    root.dataset.rgrState = vm.state;
    root.dataset.rgrTheme = theme;

    const loading = vm.state === 'loading';
    const badge = this.#el('button', loading ? 'rgr-badge rgr-skeleton' : 'rgr-badge');
    badge.type = 'button';
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-describedby', tipId);
    badge.setAttribute('aria-label', vm.ariaLabel);
    if (vm.state === 'unsupported') {
      // A note, not a control: it says why there are no numbers and does nothing when pressed.
      badge.setAttribute('aria-disabled', 'true');
      badge.append(this.#screenIcon(), this.#el('span', 'rgr-meta', vm.metaText));
    } else if (vm.state === 'idle') {
      // Nothing is loading and nothing is calculated: a plain call to action, not a placeholder that looks stuck.
      badge.append(this.#el('span', 'rgr-star', '★'), this.#el('span', 'rgr-meta', vm.metaText));
    } else {
      // The skeleton is the finished strip's own elements holding placeholder text of the final size, so nothing shifts.
      if (loading) badge.setAttribute('aria-busy', 'true');
      badge.append(this.#lead(loading ? 'flat' : vm.trend, loading), this.#cells(vm, loading));
    }
    root.append(badge);

    const tip = this.#el('div', 'rgr-tooltip');
    tip.id = tipId;
    tip.dataset.rgrTheme = theme; // the tooltip lives on <body>, so it needs its own copy
    tip.setAttribute(TIP_ATTR, tipId);
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    tip.append(this.#el('div', 'rgr-tip-title', vm.tooltip.title));

    const list = this.#el('dl', 'rgr-tip-rows');
    for (const { label, value } of vm.tooltip.rows) {
      const row = this.#el('div', 'rgr-tip-row');
      row.append(this.#el('dt', '', label), this.#el('dd', '', value));
      list.append(row);
    }
    tip.append(list);

    if (vm.tooltip.notes.length > 0) {
      const notes = this.#el('ul', 'rgr-tip-notes');
      for (const note of vm.tooltip.notes) notes.append(this.#el('li', '', note));
      tip.append(notes);
    }
    if (vm.tooltip.hint) tip.append(this.#el('div', 'rgr-tip-hint', vm.tooltip.hint));
    this.document.body.append(tip);

    root.addEventListener('mouseenter', () => this.#open(root, false));
    root.addEventListener('mouseleave', () => this.#close(root, false));
    badge.addEventListener('focus', () => this.#open(root, false));
    badge.addEventListener('blur', () => this.#close(root, false));
    badge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation(); // don't trigger Google's own click handlers on the row
      this.#close(root, true);
      if (vm.state === 'unsupported') return;
      this.onActivate(event.target.closest?.('[data-rgr-window]')?.dataset.rgrWindow); // the cell that was clicked, if any
    });
    return root;
  }

  #open(root, pin) {
    const badge = root.querySelector('.rgr-badge');
    const tip = this.#tipOf(root);
    if (!badge || !tip) return;
    if (pin) root.classList.add('rgr-pinned');
    root.classList.add('rgr-open');
    badge.setAttribute('aria-expanded', 'true');
    tip.hidden = false;
    this.#position(badge, tip);
  }

  /** @param {boolean} force also un-pins */
  #close(root, force) {
    if (!force && root.classList.contains('rgr-pinned')) return;
    root.classList.remove('rgr-open', 'rgr-pinned');
    root.querySelector('.rgr-badge')?.setAttribute('aria-expanded', 'false');
    const tip = this.#tipOf(root);
    if (tip) tip.hidden = true;
  }

  #position(badge, tip) {
    const margin = 8;
    const rect = badge.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, this.window.innerWidth - width - margin));
    let top = rect.bottom + 6;
    if (top + height > this.window.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
}
