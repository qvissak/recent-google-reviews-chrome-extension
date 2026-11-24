/**
 * Port: where reviews come from. Implemented by an adapter (e.g. DOM scraper).
 *
 * @typedef {Object} ReviewSnapshot
 * @property {import('../../domain/entities/Review.js').Review[]} reviews
 *           Every review currently available (loaded) from the source.
 * @property {number|null} allTimeRating       Google's all-time rating, if found.
 * @property {number|null} allTimeReviewCount  Google's total review count, if found.
 * @property {string|null} [placeName]
 * @property {string|null} [placeKey]  Identifies the place across reads (two branches of a chain share a name).
 * @property {boolean} [complete]  False while the reviews are just whatever was on the page, not a finished load.
 *           Sources that don't track this are treated as complete.
 */
export class ReviewSourcePort {
  /** @returns {ReviewSnapshot} */
  readSnapshot() {
    throw new Error('ReviewSourcePort.readSnapshot() not implemented');
  }

  /** Forget any reviews remembered from earlier reads. Optional; default is a no-op. */
  reset() {}

  /** A load just finished: the reviews held now are the full set for the selected window. Optional; default is a no-op. */
  markComplete() {}
}
