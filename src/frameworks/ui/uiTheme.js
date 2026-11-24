// What: Decides whether our UI (badge, tooltip, modal) is light or dark.
// Who calls it / when: BadgeDomRenderer when it builds the badge, ReviewsModalRenderer when it opens.
// Gotchas: Google Search follows the system light/dark setting, so we do too. Google Maps on the web has no dark mode
//          (only its apps do), so it is pinned to light whatever the system says. Do not infer the theme from the page's
//          background: Maps' body is dark behind the map while its panels are light.

/**
 * @param {Window} window
 * @param {Document} document
 * @returns {'dark' | 'light'}  Always 'light' on Google Maps; otherwise the system setting.
 * @example uiTheme(window, document) // 'dark' on Google Search with a dark system theme, 'light' on Google Maps
 */
export function uiTheme(window, document) {
  const { hostname = '', pathname = '' } = document.location ?? {};
  if (pathname.startsWith('/maps') || hostname.startsWith('maps.')) return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
