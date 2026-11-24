# Recent Reviews for Google Search & Maps

A Chrome (Manifest V3) extension that adds a **recent-reviews average** next to Google's all-time rating on Google Search and Google Maps place panels — it only *adds* a badge; Google's own rating and layout are untouched.

```
4.5 ★★★★☆ (2,123)
[ 4.9 ★ (~6m, n=10)  +0.4 ]      <- added by the extension; hover/click for the breakdown
```

The tooltip shows: recent average, the filter rule, sample size (`n` matched out of N reviews loaded on the page), the all-time rating and review count, the difference, and a reminder to sort by **Newest** / scroll for a bigger sample.

## Load it (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open a place on Google Maps, or search for a business on Google Search.
5. **Open the reviews** — Maps: the *Reviews* tab; Search: click "N Google reviews". Sort by **Newest** and scroll for a larger sample.

After editing code, click the reload icon on the extension's card in `chrome://extensions`, then refresh the Google tab.

The toolbar popup switches the extension on/off and picks the time window (last week / month / 3 months / **6 months (default)** / year).

## What the badge shows

- **Skeleton (shimmering placeholder)** — the recent rating is being calculated. Skeletons are the finished elements' own boxes (same text size, the real star glyphs shimmering until they are coloured in), so nothing moves when the result arrives. About two seconds after a place page settles, the extension loads the reviews by itself (see below) and the skeleton resolves into the number, with no click. The number appears once, when loading is done: it never shows a partial result, and never one computed from the 2–3 review snippets Google Maps puts on its Overview tab (that would give something like `4.5, n=2`).
- **`🖥 Recent-only rating · open on desktop`** — Google is serving its phone layout (it picks it from the user agent, so it shows up in DevTools device emulation, not in a narrow desktop window). There reviews open on a separate page instead of an overlay, which the extension can't read in the background, so it shows this note and does nothing else. Chrome on a real phone can't run extensions.
- **`★ Recent rating · click to calculate`** — nothing was calculated and nothing is about to be: the automatic load already ran for this place and ended without a finished result (Google stopped giving reviews, or something failed). Click it to try again.
- **The trend strip: `[↘] | 1M 3.9 ↘0.7 | 3M 4.1 ↘0.5 | 6M 4.3 ↘0.3`** — the average of the last month, 3 months and 6 months side by side, shortest first (like a stock chart's ranges), so a restaurant that is sliding (or climbing) is obvious without opening anything. Each cell shows the number of reviews (`n=9`) and a ticker-style jagged arrow with how far that window is from the all-time rating Google shows: green ↗ above it, red ↘ below it, → level. The icon at the left is the overall direction: the newest window with at least 3 reviews against the 6-month average (or against the all-time rating when only 6M has enough). A difference of 0.1 or less counts as steady. A window with fewer than 3 reviews is shown dimmed and never decides the trend; an empty one shows a dash. Click a cell to open the reviews modal on that window. Hover for the numbers in words.
Try all three without Google: serve the repo (`python3 -m http.server`) and open `/dev/demo.html` — a demo page driven by the real controller, DAO, presenter and renderer.

## The reviews modal

Click the badge and a stand-in for Google's reviews dialog opens, showing **only the reviews that went into the number**, with a dropdown (Last week · Last month · Last 3 months · **Last 6 months** · Last year). Changing it re-filters the list and recalculates the rating instantly; the badge on the page follows the same setting.

![Search, last 6 months](docs/examples/modal-search-last-6-months.jpg)
![Search, last week](docs/examples/modal-search-last-week.jpg)
![Maps, last 6 months](docs/examples/modal-maps-last-6-months.jpg)

How it works:

1. The extension drives Google's own UI to load the reviews: on **Search** it opens the "N Google reviews" overlay, on **Maps** it selects the *Reviews* tab, then sorts by **Newest**. It does this once per place, automatically in the background (Google's dialog and its dimming layer are hidden meanwhile; Maps flips to the Reviews tab and back for a few seconds), or when you click the badge before that has happened. If the badge already has its result, clicking it opens the modal instantly with nothing to reload.
2. It scrolls Google's list page by page until a review older than your window shows up (reviews are newest-first, so everything inside the window has been seen). It stops at 12 pages; if it stopped early the modal says so and offers **Load more reviews**.
3. The cards you see are real copies of Google's cards (photos, owner responses and all), with Google's colors frozen in so they look the same in light or dark mode. They are read-only.

Light/dark: on Google Search the badge, tooltip and modal follow your system setting (as Search itself does); on Google Maps they are always light, because Maps has no dark mode on the web.
4. Closing the modal puts Google's page back (dismisses its overlay / returns to the tab you were on). A load cannot be cancelled: if you close the modal while it is still loading, the load finishes in the background and then puts the page back, and the badge shows its result. The result is remembered, so the badge doesn't fall back to a skeleton after a completed load.

Choosing a wider window than what's loaded loads more automatically; choosing a narrower one is instant.

## Important limitations

- **Only loaded reviews count.** Google loads ~10 reviews at a time and exposes no dates other than the relative ones on the page. The extension scrolls the list for you (newest first) until your window is covered, up to 12 pages at a time; `n` and the status line say how many reviews were used. Busy places can exceed that for the longer windows — use **Load more reviews**.
- **Coarse windows.** Google says "a week ago" / "a month ago", not exact dates, so each window is an inclusive cut-off on that wording (e.g. "Last month" includes "a month ago").
- **It drives Google's UI.** While the modal is open, Google's own reviews overlay (Search) or Reviews tab (Maps) is open behind it, and the extension scrolls it. If Google changes how those controls look, the loader (`GoogleReviewsLoader.js`) is the file to adjust.
- **Relative dates only, English only.** Dates like "3 weeks ago" are parsed; absolute dates and other languages are counted as "skipped (date not recognized)".
- **Google domains.** Matches google.com, google.co.uk, google.ca, google.com.au, google.co.nz and google.ie (the English-language ones; only google.com has been tried on a live page). For other TLDs add them to `content_scripts[0].matches` and `web_accessible_resources[0].matches` in `manifest.json`.
- **Busy places.** The automatic load reads up to 30 pages. If a place has even more reviews than that inside six months, the windows it did not reach the end of are shown with a dotted underline (and "partial" in the tooltip) and never decide the trend arrow: their numbers are for the newest reviews only. Click the badge and use **Load more reviews** to go further.
- **Dates in other languages** cannot be read; when every loaded review has one, the tooltip says so instead of claiming none are recent.
- **Google changes its markup.** All DOM knowledge is in one file, [`GoogleDomReviewDao.js`](src/adapters/dao/GoogleDomReviewDao.js) (see `SELECTORS`). It avoids obfuscated class names — stars are recognised by `aria-label` or by five amber `<svg>` icons, reviews by "one star rating + one relative date", the headline by "a star next to a review count" — so it should survive most redesigns.

## Tests

```bash
npm install
npm test
```

Covers the parser and time-window boundaries, the use cases, the presenter, the Chrome-storage adapter, the DOM adapter/renderer/controller against jsdom fixtures modeled on real Search and Maps markup, and an architecture guard that fails if `domain/` or `usecases/` touch `document`/`window`/`chrome.*` or if any import points outward.

## Architecture (Clean Architecture — dependencies point inward only)

```
src/
  domain/                         Enterprise rules (pure JS, no deps)
    entities/Review.js              rating 1–5 validation, parsedAgeBucket
    entities/RatingSummary.js       value object
    entities/TimeWindow.js          "6_MONTHS" / "1_YEAR" inclusion rules
    services/RelativeTimeParser.js  "42 weeks ago" -> age bucket
  usecases/                       Application rules (depends on domain only)
    CalculateRecentRatingUseCase.js
    LoadReviewsUseCase.js           load reviews until the window is covered
    ManageExtensionSettingsUseCase.js
    ports/ReviewSourcePort.js  ReviewLoaderPort.js  SettingsRepositoryPort.js  RatingBadgePresenterPort.js
  adapters/                       Gateways & presenters (implement the ports)
    dao/GoogleDomReviewDao.js       all Google DOM scraping + card cloning
    dao/CachingGoogleReviewSource.js remembers reviews + card copies per place
    dao/GoogleReviewsLoader.js      opens/sorts/scrolls Google's reviews list
    dao/ChromeStorageSettingsDao.js chrome.storage.sync
    presenters/RatingBadgePresenter.js  RatingSummary -> badge view model
    presenters/ReviewsModalPresenter.js RatingSummary -> modal view model
  frameworks/                     UI, entry points, Chrome APIs
    content/loader.js               classic script; dynamic-imports the ES-module entry
    content/ContentScriptController.js  composition root + debounced MutationObserver
    content/ReviewsModalController.js  open/close/load/dropdown orchestration
    ui/BadgeDomRenderer.js          badge + tooltip from a view model
    ui/ReviewsModalRenderer.js      the reviews modal from a view model
    popup/ (popup.html, styles.css, PopupController.js, popupMain.js)
manifest.json  styles.css
```

Chrome can't load ES modules straight from `content_scripts`, so `loader.js` (a tiny classic script) does `import(chrome.runtime.getURL(...))`; every module under `src/` is listed in `web_accessible_resources`. No build step is needed.

Two extras beyond the brief: `TimeWindow.js` (the "what is recent" rule belongs in the domain, not the use case) and `popupMain.js` (so `PopupController` has no import-time side effects).
