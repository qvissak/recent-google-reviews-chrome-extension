import { ReviewSourcePort } from '../../usecases/ports/ReviewSourcePort.js';

/**
 * Wraps the live DOM reader and remembers every review it has seen for the
 * current place — plus a clone of its card — so results survive Google
 * re-rendering or closing its list, and a view can show the exact cards.
 */
export class CachingGoogleReviewSource extends ReviewSourcePort {
  /** @param {{ dao: import('./GoogleDomReviewDao.js').GoogleDomReviewDao }} deps */
  constructor({ dao }) {
    super();
    this.dao = dao;
    /** @type {Map<string, { review: import('../../domain/entities/Review.js').Review, card: Element | null }>} */
    this.store = new Map();
    this.placeKey = null;
    this.meta = { allTimeRating: null, allTimeReviewCount: null, placeName: null };
    /** True once a load has finished for this place; until then the store is only what the page happened to show. */
    this.complete = false;
  }

  readSnapshot() {
    const live = this.dao.readSnapshot();

    if (live.placeKey && live.placeKey !== this.placeKey) {
      this.reset(); // a different place: forget the old one's reviews
      this.placeKey = live.placeKey;
    }

    for (const review of live.reviews) {
      const known = this.store.get(review.id);
      if (!known) this.store.set(review.id, { review, card: this.dao.cloneCard(review.id) });
      else if (!known.card) known.card = this.dao.cloneCard(review.id);
    }

    // The headline isn't on the page while Google's own list covers it; keep the last one seen.
    if (live.allTimeRating !== null) this.meta.allTimeRating = live.allTimeRating;
    if (live.allTimeReviewCount !== null) this.meta.allTimeReviewCount = live.allTimeReviewCount;
    if (live.placeName) this.meta.placeName = live.placeName;

    return {
      reviews: [...this.store.values()].map((entry) => entry.review),
      allTimeRating: this.meta.allTimeRating,
      allTimeReviewCount: this.meta.allTimeReviewCount,
      placeName: this.meta.placeName,
      placeKey: this.placeKey,
      complete: this.complete,
    };
  }

  markComplete() {
    this.complete = true;
  }

  reset() {
    this.store.clear();
    this.placeKey = null;
    this.complete = false;
    this.meta = { allTimeRating: null, allTimeReviewCount: null, placeName: null };
  }

  /**
   * A fresh copy of a remembered review's card (null if it was never captured).
   * @param {string} id
   * @returns {Element | null}
   */
  cardFor(id) {
    const card = this.store.get(id)?.card;
    return card ? card.cloneNode(true) : null;
  }
}
