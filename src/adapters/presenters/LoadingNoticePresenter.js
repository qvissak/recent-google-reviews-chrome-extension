// What: The wording of the notice shown while the extension reads the reviews and the page is paused.
// Who calls it / when: ContentScriptController, whenever a load is running and the reviews modal is not on screen.
// Gotchas: The two reasons are the product's real constraints, not marketing: keep them true if the loader ever changes
//          (e.g. if it starts calling an API, the "no free API" reason goes away). It promises "a few seconds", so it must
//          never be shown for anything that can run for minutes.

/**
 * @typedef {Object} LoadingNoticeViewModel
 * @property {string} title
 * @property {string} lead  What is happening and that it ends by itself.
 * @property {string} whyTitle
 * @property {string[]} reasons  Why it has to be done this way, one paragraph each.
 * @property {string} footnote
 */

export class LoadingNoticePresenter {
  /**
   * @returns {LoadingNoticeViewModel}
   * @example new LoadingNoticePresenter().present().reasons.length // 2
   */
  present() {
    return {
      title: 'Calculating recent ratings…',
      lead: 'This page is paused for a few seconds while the extension reads the latest reviews. You can use it again as soon as the numbers appear.',
      whyTitle: 'Why does this take a moment?',
      reasons: [
        'Google has no free way to get reviews by date. Paid review APIs exist, but using one would mean charging you a subscription for an extension that is free.',
        'So the extension scrolls through the reviews already on this page, a batch at a time, the way you would. Fetching them faster, or from outside the page, could look like a bot to Google and get your searches CAPTCHA-checked or blocked.',
      ],
      footnote: 'This message closes by itself.',
    };
  }
}
