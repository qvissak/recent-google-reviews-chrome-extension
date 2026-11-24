import { ReviewSourcePort } from '../../usecases/ports/ReviewSourcePort.js';
import { Review } from '../../domain/entities/Review.js';
import { RelativeTimeParser } from '../../domain/services/RelativeTimeParser.js';

/**
 * ALL knowledge of Google's DOM lives in this file.
 *
 * Google's class names are obfuscated and change often, so the strategy is:
 *   1. a "star rating" is recognised semantically, never by class name:
 *        a) role="img" + aria-label ("Rated 4.0 out of 5," on Search, "5 stars" on Maps), or
 *        b) a group of exactly five sibling <svg> stars where N of them are amber
 *           (the Search "Google reviews" overlay has NO aria-label on review stars),
 *   2. a "review" = the smallest element holding exactly one star rating plus a
 *      relative-time string ("2 months ago"), widened to the whole review card,
 *   3. the "headline" rating = a star sitting next to a review count
 *      ("1,940 Google reviews" / "(2,123)") — that's where the badge goes.
 * Known wrappers ([data-review-id]) are used only as a hint. If Google changes
 * markup, this is the only file that should need patching.
 */

export const SELECTORS = Object.freeze({
  /** Elements that may be an aria-labelled star rating. Filtered by STAR_LABEL_PATTERNS afterwards. */
  starCandidates: '[role="img"][aria-label], [aria-label^="Rated" i], [aria-label*="star" i]',
  /** Known review wrappers (hint only). */
  knownReviewContainers: '[data-review-id], .jftiEf, .gws-localreviews__google-review',
  /** Where a place's headline rating may live on Google Maps. */
  mapsPlaceContext: '[role="main"]',
  /** Where it may live on Google Search: knowledge panel, subtitle block, reviews overlay. */
  searchPlaceContext:
    '#rhs, .kp-wholepage, [data-attrid="subtitle"], [data-attrid="title"], [data-attrid*="star_score" i], [role="dialog"], [role="complementary"]',
  /** A modal on top of the page; its headline wins over the one underneath. */
  topLayer: '[role="dialog"]',
  // Set on <html> by GoogleReviewsLoader while it drives Google's (hidden) reviews dialog.
  loaderActive: 'data-rgr-quiet',
  /** Our own injected UI (badge, tooltip, modal) — never scan it. */
  ownUi: '[data-rgr-root], [data-rgr-tip], [data-rgr-modal], [data-rgr-notice]',
});

const STAR_LABEL_PATTERNS = [
  { re: /^rated\s+(\d(?:[.,]\d)?)\s+out of\s+5/i, allowReviewWord: true }, // Search: "Rated 4.0 out of 5," / "..., 1.5K reviews."
  { re: /^(\d(?:[.,]\d)?)\s+stars?\b/i, allowReviewWord: false }, // Maps: "5 stars" (histogram rows say "5 stars, 1,534 reviews")
  { re: /^(\d(?:[.,]\d)?)\s+out of\s+5/i, allowReviewWord: false },
];

/** A review count, matched against the *whole* text of a single element. */
const COUNT_TEXT_PATTERNS = [
  /^(\d[\d,.]*\s*[kK]?)\s+(?:google\s+)?(?:user\s+)?reviews?\.?$/i, // "1,940 Google reviews"
  /^\(\s*(\d[\d,.]*\s*[kK]?)\s*\)$/, // "(2,123)"
];

const SVG_STARS_PER_RATING = 5;
const MAX_CONTAINER_CLIMB = 8;
const MAX_CARD_EXPANSION = 6;
const MAX_ROW_CLIMB = 4;
const MAX_TIME_TEXT = 60;

/** Attributes that wire a cloned Google card back into Google's own event system. */
const WIRING_ATTRIBUTES = /^(on.*|js[a-z]*|ved|data-ved|data-hveid|data-ohi|href|id|data-review-id)$/i;
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME']);
/** Controls that do nothing in a read-only copy (their handlers live in Google's page). */
const INERT_TEXT = new Set(['More', 'Hover to react', 'Like', 'Share']);
/** Colors Google scopes to its own dialog/theme; frozen onto the clone so it looks the same elsewhere. */
const FROZEN_COLORS = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'];
const FROZEN_SVG_COLORS = ['fill', 'stroke'];
/** A block at least as wide as the card with side margins this negative is a full-bleed element (Maps' photo grid). */
const MIN_BLEED = 12;

/**
 * Copy the *computed* colors of a live card onto its clone, element by element.
 * Google's dark/light theme rules hang off ancestors of its dialog, which a clone
 * leaves behind (dark text on a dark panel); the computed values are theme-correct.
 */
function freezeColors(source, clone, view) {
  if (!view?.getComputedStyle) return 0;
  const from = [source, ...source.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  const count = Math.min(from.length, to.length);
  const cardBox = source.getBoundingClientRect();
  const laidOut = cardBox.height > 0;
  let bleed = 0;
  for (let i = 0; i < count; i += 1) {
    const style = to[i].style;
    if (!style) continue;
    const computed = view.getComputedStyle(from[i]);
    if (laidOut) {
      dropCardEdgeBorders(from[i], computed, style, cardBox);
      bleed = Math.max(bleed, bleedOf(from[i], computed, cardBox));
    }
    for (const property of FROZEN_COLORS) if (computed[property]) style[property] = computed[property];
    if (view.SVGElement && from[i] instanceof view.SVGElement) {
      for (const property of FROZEN_SVG_COLORS) {
        const value = computed[property];
        if (value && value !== 'none') style[property] = value;
      }
    }
  }
  return bleed;
}

/** How far (px) this element bleeds out of the card on both sides, or 0. Ignores small things like icon hit-areas. */
function bleedOf(element, computed, cardBox) {
  const left = -(Number.parseFloat(computed.marginLeft) || 0);
  const right = -(Number.parseFloat(computed.marginRight) || 0);
  const bleed = Math.min(left, right);
  if (bleed < MIN_BLEED) return 0;
  return element.getBoundingClientRect().width >= cardBox.width - 1 ? bleed : 0;
}

/** The first opaque background behind `el` (what the card is actually drawn on), as "rgb(r, g, b)". */
function backgroundBehind(el, view) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const match = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?/.exec(view.getComputedStyle(node).backgroundColor ?? '');
    if (match && (match[4] === undefined || Number(match[4]) > 0.9)) return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
  }
  return null;
}

/**
 * A border sitting on the card's top or bottom edge is Google's separator between cards.
 * The modal draws its own, so drop these or every review gets a double line.
 */
function dropCardEdgeBorders(element, computed, cloneStyle, cardBox) {
  const hasBottom = Number.parseFloat(computed.borderBottomWidth) > 0;
  const hasTop = Number.parseFloat(computed.borderTopWidth) > 0;
  if (!hasBottom && !hasTop) return;
  const box = element.getBoundingClientRect();
  if (hasBottom && Math.abs(box.bottom - cardBox.bottom) <= 1.5) cloneStyle.borderBottomWidth = '0px';
  if (hasTop && Math.abs(box.top - cardBox.top) <= 1.5) cloneStyle.borderTopWidth = '0px';
}

function removeInertControls(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (el.childElementCount === 0 && INERT_TEXT.has((el.textContent ?? '').trim())) {
      (el.closest('a, button, [role="button"]') ?? el).remove();
    }
  }
}

/**
 * Make a deep clone of a Google review card safe to show elsewhere: no scripts,
 * no ids (they'd duplicate), no jsaction/jscontroller (clicks would reach Google's handlers),
 * no links that navigate away.
 */
function sanitizeClone(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (DROP_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const { name } of [...el.attributes]) if (WIRING_ATTRIBUTES.test(name)) el.removeAttribute(name);
  }
  for (const { name } of [...root.attributes]) if (WIRING_ATTRIBUTES.test(name)) root.removeAttribute(name);
  return root;
}

/** Small stable hash for reviews that carry no id of their own. */
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** @typedef {{ el: Element, rating: number }} Star */

export class GoogleDomReviewDao extends ReviewSourcePort {
  /**
   * @param {{ document: Document, parser?: RelativeTimeParser }} deps
   */
  constructor({ document, parser = new RelativeTimeParser() }) {
    super();
    this.document = document;
    this.parser = parser;
    /** review id -> { root: its live card element, inner: an element inside it }, as of the last readSnapshot() */
    this.liveCards = new Map();
  }

  /** @returns {import('../../usecases/ports/ReviewSourcePort.js').ReviewSnapshot & { placeKey: string | null }} */
  readSnapshot() {
    const scan = this.#scan();
    this.liveCards = new Map();
    const placeName = this.#readPlaceName();
    const count = scan.headline?.count ?? null;
    return {
      reviews: this.#toReviews(scan.cards),
      allTimeRating: scan.headline?.rating ?? null,
      allTimeReviewCount: count,
      placeName,
      // Identifies the place. On Maps the place id in the URL comes first: two branches of one chain share a name, and
      // the id also survives the Reviews tab, which has no readable name. Not the map position, which changes while
      // panning. The review count is only a last fallback: Google shows a different count in its reviews dialog than on
      // the page (329 vs 328), so a key that included it would call the same place "new" when the dialog closes and
      // discard everything loaded.
      placeKey: this.#readPlaceId() ?? placeName ?? (count !== null ? `|${count}` : null),
    };
  }

  /**
   * A sanitized deep copy of a review's card as it is currently on the page, or
   * null if that review is no longer rendered.
   * @param {string} id
   * @returns {Element | null}
   */
  cloneCard(id) {
    const entry = this.liveCards.get(id);
    if (!entry) return null;
    const { root, inner } = entry;
    const clone = root.cloneNode(true);
    const view = this.document.defaultView;
    const bleed = freezeColors(root, clone, view); // before sanitizing: both trees must still line up
    removeInertControls(sanitizeClone(clone));

    // Hand the view the card's native geometry: Maps cards are full-bleed blocks (their root has
    // horizontal padding that their photo grid cancels with negative margins), so the view needs to
    // know the width and padding to lay them out the way Maps does. Also remember what the card
    // sat on so the view can pick a matching light/dark theme.
    const { width } = root.getBoundingClientRect();
    if (width > 0) clone.dataset.rgrWidth = String(Math.round(width));
    const rootStyle = view?.getComputedStyle?.(root);
    const padding = rootStyle
      ? Math.min(Number.parseFloat(rootStyle.paddingLeft) || 0, Number.parseFloat(rootStyle.paddingRight) || 0)
      : 0;
    if (padding > 0) clone.dataset.rgrPad = String(Math.round(padding));
    if (bleed > 0) clone.dataset.rgrBleed = String(Math.round(bleed));
    const background = view?.getComputedStyle ? backgroundBehind(inner, view) : null;
    if (background) clone.dataset.rgrBg = background;
    return clone;
  }

  /**
   * Element after which the badge should be inserted: the block holding the
   * headline rating ("4.0 ★★★★☆ 1,940 Google reviews"), or null when the page
   * is not showing a place.
   * @returns {Element | null}
   */
  locateBadgeAnchor() {
    return this.#scan().headline?.row ?? null;
  }

  // ------------------------------------------------------------------- scan

  #scan() {
    const stars = this.#collectStars();
    const inside = (root) => stars.filter((s) => root.contains(s.el));

    // Stars that sit next to a review count are headline ratings, not reviews.
    const annotated = stars.map((star) => {
      const row = this.#climbToRow(star, inside);
      return { ...star, row, count: this.#findCount(row) };
    });
    const reviewStars = annotated.filter((s) => s.count === null);

    const cards = [];
    const seen = new Set();
    for (const star of reviewStars) {
      const card = this.#reviewCardFor(star, inside);
      if (!card || seen.has(card.root)) continue;
      seen.add(card.root);
      cards.push(card);
    }

    return { cards, headline: this.#pickHeadline(annotated, cards) };
  }

  /** @returns {Star[]} in document order */
  #collectStars() {
    const stars = [];
    for (const el of this.document.querySelectorAll(SELECTORS.starCandidates)) {
      if (el.closest(SELECTORS.ownUi)) continue;
      const rating = this.#parseStarLabel(el.getAttribute('aria-label'));
      if (rating !== null) stars.push({ el, rating });
    }
    stars.push(...this.#collectSvgStarGroups());
    return stars.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & 4 /* b follows a */ ? -1 : 1,
    );
  }

  /** Five sibling <svg> stars; rating = how many are amber. */
  #collectSvgStarGroups() {
    const counts = new Map();
    for (const svg of this.document.querySelectorAll('svg')) {
      const parent = svg.parentElement;
      if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    const groups = [];
    for (const [parent, n] of counts) {
      if (n !== SVG_STARS_PER_RATING || parent.children.length !== SVG_STARS_PER_RATING) continue;
      if (parent.closest(SELECTORS.ownUi)) continue;
      const filled = [...parent.children].filter((svg) => this.#isAmber(svg.querySelector('path') ?? svg)).length;
      if (filled >= 1) groups.push({ el: parent, rating: filled });
    }
    return groups;
  }

  #isAmber(node) {
    const view = this.document.defaultView;
    const computed = view?.getComputedStyle?.(node)?.fill ?? '';
    const rgb = this.#parseColor(computed.startsWith('rgb') ? computed : node.getAttribute?.('fill'));
    if (!rgb) return false;
    const [r, g, b] = rgb;
    return r >= 200 && g >= 120 && b <= 120; // amber/yellow vs. grey
  }

  #parseColor(value) {
    if (!value) return null;
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!hex) return null;
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  // ---------------------------------------------------------------- reviews

  /**
   * @returns {{ root: Element, timeRoot: Element, rating: number } | null}
   *   root: the whole review card (identity / dedupe); timeRoot: smallest
   *   element holding this review's star + its own date.
   */
  #reviewCardFor(star, inside) {
    const known = star.el.closest(SELECTORS.knownReviewContainers);
    if (known && inside(known).length === 1) {
      return { root: known, timeRoot: known, rating: star.rating };
    }

    let timeRoot = null;
    let node = star.el.parentElement;
    for (let depth = 0; node && depth < MAX_CONTAINER_CLIMB; depth += 1, node = node.parentElement) {
      if (inside(node).length > 1) return null; // wandered into a list of reviews
      if (this.#findTimeText(node)) {
        timeRoot = node;
        break;
      }
    }
    if (!timeRoot) return null;

    let root = timeRoot;
    for (let i = 0; i < MAX_CARD_EXPANSION; i += 1) {
      const parent = root.parentElement;
      if (!parent || inside(parent).length !== 1) break;
      root = parent;
    }
    return { root, timeRoot, rating: star.rating };
  }

  #toReviews(cards) {
    const seenIds = new Set();
    const reviews = [];
    for (const { root, timeRoot, rating } of cards) {
      const id =
        root.getAttribute('data-review-id') ??
        root.closest('[data-review-id]')?.getAttribute('data-review-id') ??
        root.querySelector('[data-review-id]')?.getAttribute('data-review-id') ??
        `rgr:${hashText(`${rating}|${(root.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)}`)}`;
      if (seenIds.has(id)) continue; // same review rendered twice
      seenIds.add(id);
      this.liveCards.set(id, { root, inner: timeRoot });
      const time = this.#findTimeText(timeRoot);
      try {
        reviews.push(
          new Review({
            rating,
            rawTimestamp: time?.raw ?? null,
            parsedAgeBucket: time?.bucket ?? null,
            id,
          }),
        );
      } catch {
        // Misread rating: skip rather than poison the average.
      }
    }
    return reviews;
  }

  // --------------------------------------------------------------- headline

  /**
   * The current place's headline rating: a star next to a review count,
   * inside a place context, visible, and not part of a review. A modal's
   * headline (Search reviews overlay) beats the one underneath it for the
   * numbers, but the badge is never anchored inside Google's dialog: `row`
   * is the place panel behind it, or null when there is none.
   */
  #pickHeadline(annotated, cards) {
    const context = this.#isMaps() ? SELECTORS.mapsPlaceContext : SELECTORS.searchPlaceContext;
    const candidates = annotated.filter(
      (s) =>
        s.count !== null &&
        !cards.some((c) => c.root.contains(s.el)) &&
        s.el.closest(context) &&
        this.#isVisible(s.el),
    );
    // The numbers come from the dialog's headline when Google's own list is open (its count is the list's own count)
    // but while our loader has that dialog open they come from the page, which is what the rest of the load was built on.
    const loaderActive = this.document.documentElement.hasAttribute(SELECTORS.loaderActive);
    const inDialog = (s) => Boolean(s.el.closest(SELECTORS.topLayer));
    const best = (loaderActive ? candidates.find((s) => !inDialog(s)) : candidates.find(inDialog)) ?? candidates[0];
    if (!best) return this.#fallbackHeadline(annotated, cards, context);
    // The badge stays off Google's dialog (it is Google's own reviews view, not our page): on the place panel behind it,
    // or nowhere when the dialog is the only place showing a headline.
    const onPage = inDialog(best) ? candidates.find((s) => !inDialog(s)) : best;
    return { rating: best.rating, count: best.count, row: onPage?.row ?? null };
  }

  /** No review count found next to any star: fall back to the first plain star in a place context. */
  #fallbackHeadline(annotated, cards, context) {
    const star = annotated.find(
      (s) => !cards.some((c) => c.root.contains(s.el)) && s.el.closest(context) && this.#isVisible(s.el),
    );
    return star ? { rating: star.rating, count: null, row: star.el.closest(SELECTORS.topLayer) ? null : star.row } : null;
  }

  /**
   * Climb from the star to the smallest nearby block that also holds the review
   * count. Stops before a block that holds a relative date or a second star:
   * that is a review (or a list), not the headline row.
   */
  #climbToRow(star, inside) {
    let row = star.el;
    for (let i = 0; i < MAX_ROW_CLIMB; i += 1) {
      if (this.#findCount(row) !== null) break;
      const parent = row.parentElement;
      if (!parent || inside(parent).length > 1 || this.#findTimeText(parent)) break;
      row = parent;
    }
    return row;
  }

  /** @returns {number | null} review count found inside `root`, e.g. 1940 */
  #findCount(root) {
    const label = root.getAttribute?.('aria-label');
    const candidates = [label ?? ''];
    for (const el of root.querySelectorAll('*')) {
      candidates.push(el.getAttribute('aria-label') ?? '');
      if (el.childElementCount === 0) candidates.push((el.textContent ?? '').trim());
    }
    // "Rated 4.6 out of 5, 1.5K reviews." — count embedded in the star label itself
    const inStarLabel = /out of 5,?\s*\(?(\d[\d,.]*\s*[kK]?)\)?\s+(?:user\s+)?reviews?/i.exec(label ?? '');
    if (inStarLabel) return this.#parseCount(inStarLabel[1]);

    for (const text of candidates) {
      if (!text || text.length > 40) continue;
      for (const re of COUNT_TEXT_PATTERNS) {
        const m = re.exec(text);
        if (m) return this.#parseCount(m[1]);
      }
    }
    return null;
  }

  // --------------------------------------------------------------- helpers

  /** The place's name: Maps' main panel label / heading, or Search's knowledge-panel title. */
  /** Maps' place id (`0x…:0x…`) from the URL, which is the same for every tab of one place and different per branch. */
  #readPlaceId() {
    if (!this.#isMaps()) return null;
    return /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(this.document.location?.href ?? '')?.[1] ?? null;
  }

  #readPlaceName() {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim() || null;
    if (this.#isMaps()) {
      const main = this.document.querySelector('[role="main"][aria-label]');
      return main?.getAttribute('aria-label')?.trim() || text(this.document.querySelector('h1'));
    }
    const title = [...this.document.querySelectorAll('[data-attrid="title"]')].find((el) => this.#isVisible(el));
    return text(title);
  }

  #isMaps() {
    const { hostname = '', pathname = '' } = this.document.location ?? {};
    return pathname.startsWith('/maps') || hostname.startsWith('maps.');
  }

  #isVisible(el) {
    return el.getClientRects().length > 0;
  }

  #parseStarLabel(label) {
    if (!label) return null;
    const trimmed = label.trim();
    for (const { re, allowReviewWord } of STAR_LABEL_PATTERNS) {
      const m = re.exec(trimmed);
      if (!m) continue;
      if (!allowReviewWord && /review/i.test(trimmed)) return null;
      const value = Number(m[1].replace(',', '.'));
      return value >= 0 && value <= 5 ? value : null;
    }
    return null;
  }

  /**
   * First element under `root` whose whole text is a relative timestamp.
   * Leaves first (cheap, precise), then short non-leaf wrappers
   * (e.g. "2 months ago on <span>Google</span>").
   * @returns {{ raw: string, bucket: import('../../domain/services/RelativeTimeParser.js').AgeBucket } | null}
   */
  #findTimeText(root) {
    const elements = root.querySelectorAll('*');
    for (const wantLeaf of [true, false]) {
      for (const el of elements) {
        if ((el.childElementCount === 0) !== wantLeaf) continue;
        const text = el.textContent ?? '';
        if (text.length === 0 || text.length > MAX_TIME_TEXT) continue;
        const bucket = this.parser.parse(text);
        if (bucket) return { raw: text.trim(), bucket };
      }
    }
    return null;
  }

  #parseCount(raw) {
    const s = raw.replace(/\s+/g, '');
    const k = /k$/i.test(s);
    const n = Number(s.replace(/k$/i, '').replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    return Math.round(k ? n * 1000 : n);
  }
}
