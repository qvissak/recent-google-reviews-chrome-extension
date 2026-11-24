/**
 * A single review as seen on the page.
 *
 * `parsedAgeBucket` is null when the timestamp could not be parsed; such a
 * review is still a valid Review (it counts toward "scanned", never toward the
 * recent sample).
 *
 * `id` is an opaque, stable key from the source (used to de-duplicate reviews
 * and to look the original card up again); null when the source has none.
 */
export class Review {
  /**
   * @param {Object} props
   * @param {number} props.rating  1–5 inclusive.
   * @param {string|null} [props.rawTimestamp]
   * @param {import('../services/RelativeTimeParser.js').AgeBucket|null} [props.parsedAgeBucket]
   * @param {string|null} [props.id]
   */
  constructor({ rating, rawTimestamp = null, parsedAgeBucket = null, id = null }) {
    if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      throw new RangeError(`Review rating must be a number between 1 and 5, got: ${rating}`);
    }
    this.rating = rating;
    this.rawTimestamp = rawTimestamp;
    this.parsedAgeBucket = parsedAgeBucket;
    this.id = id;
    Object.freeze(this);
  }
}
