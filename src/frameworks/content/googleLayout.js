// What: Tells what kind of Google page this is: its phone layout (reviews open on a separate page, not in an overlay) and Google Maps vs Search.
// Who calls it / when: ContentScriptController, once per update: the phone layout switches the badge to a "larger screen" note, and the page kind picks which on/off setting applies.
// Gotchas: Google picks the layout from the user agent, not the window width, so a narrow desktop window still gets the
//          desktop layout this extension supports. Chrome on a phone cannot run extensions: this only happens in
//          DevTools device emulation (or another browser that does).

/**
 * @param {{ userAgent?: string, userAgentData?: { mobile?: boolean } }} navigator
 * @returns {boolean}  True for a phone user agent ("Mobile" in the string, or the client hint says so).
 * @example isMobileLayout(window.navigator) // true in DevTools "Pixel 9" emulation, false in a normal desktop window
 */
export function isMobileLayout(navigator) {
  if (navigator?.userAgentData?.mobile === true) return true;
  return /\bMobi/i.test(navigator?.userAgent ?? '');
}

/**
 * @param {{ hostname?: string, pathname?: string } | null | undefined} location
 * @returns {boolean}  True on Google Maps (google.com/maps/..., or a maps.* host); everything else is treated as Search.
 * @example isMapsPage(window.location) // true on https://www.google.com/maps/place/..., false on https://www.google.com/search?q=...
 */
export function isMapsPage(location) {
  const { hostname = '', pathname = '' } = location ?? {};
  return pathname.startsWith('/maps') || hostname.startsWith('maps.');
}
