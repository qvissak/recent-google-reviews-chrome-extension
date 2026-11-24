/**
 * Port: turns a RatingSummary into a display-ready view model.
 *
 * @typedef {Object} BadgeViewModel
 * @property {'ready'|'empty'|'loading'} state  loading = no reviews on the page yet (render a skeleton)
 * @property {'positive'|'negative'|'neutral'|'muted'} tone
 * @property {string} badgeText      Full one-line text, e.g. "4.3 ★ (~6m, n=24)".
 * @property {string} valueText      "4.3", "–", or "" while loading.
 * @property {string} metaText       "(~6m, n=24)".
 * @property {string|null} deltaShort  "+0.2" or null.
 * @property {string} ariaLabel
 * @property {{title: string, rows: {label: string, value: string}[], notes: string[], hint: string}} tooltip
 */
export class RatingBadgePresenterPort {
  /** @param {import('../../domain/entities/RatingSummary.js').RatingSummary} summary
   *  @param {{ pending?: boolean }} [options]  pending = reviews still loading: present a loading state
   *  @returns {BadgeViewModel} */
  present(summary, options) { // eslint-disable-line no-unused-vars
    throw new Error('RatingBadgePresenterPort.present() not implemented');
  }
}
