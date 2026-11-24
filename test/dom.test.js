import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { GoogleDomReviewDao } from '../src/adapters/dao/GoogleDomReviewDao.js';
import { CachingGoogleReviewSource } from '../src/adapters/dao/CachingGoogleReviewSource.js';
import { RatingBadgePresenter } from '../src/adapters/presenters/RatingBadgePresenter.js';
import { BadgeDomRenderer } from '../src/frameworks/ui/BadgeDomRenderer.js';
import { ContentScriptController } from '../src/frameworks/content/ContentScriptController.js';
import { CalculateRecentRatingUseCase } from '../src/usecases/CalculateRecentRatingUseCase.js';
import { TREND_WINDOWS } from '../src/domain/entities/TimeWindow.js';

function makeDom(html, url) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url });
  // jsdom has no layout; pretend everything is rendered.
  dom.window.Element.prototype.getClientRects = function getClientRects() { return [{}]; };
  return dom;
}

const mapsReview = (id, stars, when, extra = '') => `
  <div class="jftiEf" data-review-id="${id}">
    <div class="d4r55">Some Person <span>Local Guide · 54 reviews</span></div>
    <span role="img" aria-label="${stars} stars"></span>
    <span class="rsqaWe">${when}</span>
    <span class="wiI7pd">Food was fine. ${extra}</span>
  </div>`;

const MAPS_HTML = `
  <div role="main" aria-label="CHA Cambridge Hospital">
    <h1>CHA Cambridge Hospital</h1>
    <div class="F7nice"><span><span aria-hidden="true">4.5</span>
      <span role="img" aria-label="4.5 stars "></span></span>
      <span><span aria-label="2,123 reviews">(2,123)</span></span></div>
    <div>General hospital</div>
    <div class="histogram"><div role="img" aria-label="5 stars, 1,534 reviews"></div></div>
    ${mapsReview('r1', 5, '2 days ago')}
    ${mapsReview('r2', 4, '3 months ago')}
    ${mapsReview('r3', 2, 'Edited 5 months ago')}
    ${mapsReview('r4', 1, 'a year ago')}
    ${mapsReview('r5', 3, 'sometime')}
  </div>`;

test('maps: reads reviews, headline rating, count; ignores histogram', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  const dao = new GoogleDomReviewDao({ document: window.document });
  const snap = dao.readSnapshot();

  assert.equal(snap.allTimeRating, 4.5);
  assert.equal(snap.allTimeReviewCount, 2123);
  assert.deepEqual(snap.reviews.map((r) => r.rating), [5, 4, 2, 1, 3]);
  assert.equal(snap.reviews[2].parsedAgeBucket.unit, 'MONTHS');
  assert.equal(snap.reviews[4].parsedAgeBucket, null);
  assert.ok(dao.locateBadgeAnchor().classList.contains('F7nice'));
});

// Search knowledge panel, shaped like the live markup: inline spans split by <br>,
// so the row's textContent is "4.01,940 Google reviews".
const kpHeadline = `
  <div data-attrid="subtitle"><div id="row">
    <span>4.0</span><span role="img" aria-label="Rated 4.0 out of 5,"><span><span></span></span></span>
    <span><span><a role="button"><span>1,940 Google reviews</span></a></span></span><br>
    <span><span>$100+</span></span><span>‧</span><span>Restaurant</span>
  </div></div>`;

// KP review snippets: stars but no dates -> must NOT count as reviews.
const kpSnippets = `<div data-attrid="kc:/collection/knowledge_panels/local_reviewable:r">
  <div><span role="img" aria-label="Rated 5.0 out of 5,"></span><p>"Great"</p></div>
  <div><span role="img" aria-label="Rated 4.0 out of 5,"></span><p>"Good"</p></div></div>`;

const SEARCH_HTML = `
  <div id="main"><div class="organic">Some Site <span role="img" aria-label="Rated 3.0 out of 5, (665) user reviews"></span><span>(665)</span></div></div>
  <div id="rhs">${kpHeadline}${kpSnippets}</div>`;

test('search KP: finds headline + count despite concatenated text; ignores organic stars and dateless snippets', () => {
  const { window } = makeDom(SEARCH_HTML, 'https://www.google.com/search?q=ramsay');
  const dao = new GoogleDomReviewDao({ document: window.document });
  const snap = dao.readSnapshot();
  assert.equal(snap.allTimeRating, 4.0);
  assert.equal(snap.allTimeReviewCount, 1940);
  assert.equal(snap.reviews.length, 0);
  assert.equal(dao.locateBadgeAnchor().id, 'row');
});

// Search "Google reviews" overlay: review stars are bare <svg>s (no aria-label);
// filled ones are amber. Two reviews look identical on purpose.
const svgStars = (filled) =>
  '<div>' + Array.from({ length: 5 }, (_, i) =>
    `<svg><path fill="${i < filled ? '#fabb05' : '#dadce0'}" d="M6 .6"/></svg>`).join('') + '</div>';
const overlayReview = (id, filled, when) => `
  <div class="card"><span data-review-id="${id}"></span>
    <div class="hdr">${svgStars(filled)}<span><span>${when}</span></span><span>New</span></div>
    <p>Some text</p>
    <div class="owner"><span>3 weeks ago</span> Response from the owner</div></div>`;

const OVERLAY_HTML = `
  <div id="rhs">${kpHeadline}</div>
  <div role="dialog"><div id="overlay-head"><span>4.0</span>
      <span role="img" aria-label="Rated 4.0 out of 5,"></span><span>1,940 reviews</span>
      <div><a>Google policies and a long disclaimer that pushes this block well past one hundred and twenty characters of text.</a></div></div>
    <div id="list">
    ${overlayReview('a', 5, '3 weeks ago')}
    ${overlayReview('b', 5, '3 weeks ago')}
    ${overlayReview('c', 3, 'a month ago')}
    ${overlayReview('d', 4, '14 months ago'.replace('14 months', 'a year'))}
    </div></div>`;

test('search overlay: svg-star reviews, identical reviews both counted, owner reply date ignored, overlay headline wins for the numbers', () => {
  const { window } = makeDom(OVERLAY_HTML, 'https://www.google.com/search?q=ramsay');
  const dao = new GoogleDomReviewDao({ document: window.document });
  const snap = dao.readSnapshot();

  assert.deepEqual(snap.reviews.map((r) => r.rating), [5, 5, 3, 4]);
  assert.deepEqual(snap.reviews.map((r) => r.parsedAgeBucket.unit), ['WEEKS', 'WEEKS', 'MONTHS', 'YEARS']);
  assert.equal(snap.allTimeRating, 4.0);
  assert.equal(snap.allTimeReviewCount, 1940);
  assert.ok(window.document.querySelector('#rhs').contains(dao.locateBadgeAnchor()), 'but the badge is not drawn inside Google\'s dialog: it stays on the panel behind it');
});

test('search overlay: the badge is on the page whether the user opened Google\'s dialog or our loader did (hidden)', () => {
  const { window } = makeDom(OVERLAY_HTML, 'https://www.google.com/search?q=ramsay');
  const dao = new GoogleDomReviewDao({ document: window.document });
  const panel = window.document.querySelector('#rhs');
  assert.ok(panel.contains(dao.locateBadgeAnchor()), 'dialog open by the user: on the knowledge panel');
  window.document.documentElement.setAttribute('data-rgr-quiet', '');
  assert.ok(panel.contains(dao.locateBadgeAnchor()), 'dialog open by our loader: on the knowledge panel');
  window.document.documentElement.removeAttribute('data-rgr-quiet');
  assert.ok(panel.contains(dao.locateBadgeAnchor()), 'and after it closes');
});

test('search overlay: with nothing but Google\'s dialog showing a headline there is no badge, but the numbers are still read', () => {
  const dialogOnly = OVERLAY_HTML.replace(`<div id="rhs">${kpHeadline}</div>`, '');
  const { window } = makeDom(dialogOnly, 'https://www.google.com/search?q=ramsay');
  const dao = new GoogleDomReviewDao({ document: window.document });
  assert.equal(dao.locateBadgeAnchor(), null);
  const snap = dao.readSnapshot();
  assert.equal(snap.allTimeRating, 4.0);
  assert.equal(snap.allTimeReviewCount, 1940);
  assert.equal(snap.reviews.length, 4);

  // and the badge renderer takes down whatever it had drawn when the dialog is the only headline left
  const renderer = new BadgeDomRenderer({ window, document: window.document, locateAnchor: () => dao.locateBadgeAnchor() });
  renderer.render({ state: 'idle', tone: 'muted', metaText: 'x', ariaLabel: 'x', cells: [], placeholder: { cells: [] }, tooltip: { title: 't', rows: [], notes: [], hint: null } });
  assert.equal(window.document.querySelector('[data-rgr-root]'), null);
});

test('no place on page -> no anchor, empty snapshot', () => {
  const { window } = makeDom('<div id="main"><p>hello</p></div>', 'https://www.google.com/search?q=x');
  const dao = new GoogleDomReviewDao({ document: window.document });
  assert.equal(dao.locateBadgeAnchor(), null);
  assert.deepEqual(dao.readSnapshot(), { reviews: [], allTimeRating: null, allTimeReviewCount: null, placeName: null, placeKey: null });
});

test('duplicate reviews (same data-review-id) are counted once', () => {
  const html = `<div role="main">
    <div class="F7nice"><span role="img" aria-label="4.0 stars"></span>(10)</div>
    ${mapsReview('same', 5, '1 day ago')}${mapsReview('same', 5, '1 day ago')}</div>`;
  const { window } = makeDom(html, 'https://www.google.com/maps/place/x');
  assert.equal(new GoogleDomReviewDao({ document: window.document }).readSnapshot().reviews.length, 1);
});

// ------------------------------------------------------------------ renderer

function wire(window, { timeWindow = '6_MONTHS', onActivate } = {}) {
  const dao = new GoogleDomReviewDao({ document: window.document });
  const renderer = new BadgeDomRenderer({ window, document: window.document, locateAnchor: () => dao.locateBadgeAnchor(), onActivate });
  const calculateUseCase = new CalculateRecentRatingUseCase({ reviewSource: dao });
  const presenter = new RatingBadgePresenter();
  const run = () =>
    renderer.render(
      presenter.present(calculateUseCase.execute({ timeWindow }), {
        windows: calculateUseCase.executeAll({ timeWindows: TREND_WINDOWS }),
      }),
    );
  return { dao, renderer, run };
}

test('renderer: injects exactly one badge, updates in place, tooltip toggles', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  let activations = 0;
  const { run, renderer } = wire(window, { onActivate: () => { activations += 1; } });

  run();
  run();
  run();
  const roots = window.document.querySelectorAll('[data-rgr-root]');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].previousElementSibling.className, 'F7nice');
  // The strip: 1M | 3M | 6M, shortest first, each with its rating and a ticker arrow against the all-time rating.
  assert.deepEqual([...roots[0].querySelectorAll('.rgr-cell')].map((c) => c.dataset.rgrWindow), ['1_MONTH', '3_MONTHS', '6_MONTHS']);
  assert.deepEqual([...roots[0].querySelectorAll('.rgr-cell-label')].map((l) => l.textContent), ['1M', '3M', '6M']);
  const sixMonths = roots[0].querySelector('.rgr-cell[data-rgr-window="6_MONTHS"]');
  assert.equal(sixMonths.querySelector('.rgr-cell-value').textContent, '3.7'); // (5+4+2)/3 = 3.67
  assert.equal(sixMonths.querySelector('.rgr-cell-n').textContent, 'n=3');
  assert.equal(sixMonths.dataset.rgrDir, 'down');
  assert.equal(sixMonths.querySelector('.rgr-cell-delta').textContent, '0.8', 'magnitude only: the arrow says which way');
  assert.ok(sixMonths.querySelector('.rgr-cell-delta svg.rgr-trend-icon polyline'), 'angular arrow icon');
  assert.ok(roots[0].querySelector('.rgr-lead svg'), 'overall direction icon');
  assert.equal(window.document.querySelector('.F7nice span[aria-hidden]').textContent, '4.5', 'all-time rating untouched');

  const badge = roots[0].querySelector('.rgr-badge');
  const tip = window.document.querySelector('.rgr-tooltip');
  assert.equal(tip.parentElement, window.document.body, 'tooltip lives on <body> so panels cannot clip it');
  assert.equal(tip.hidden, true);
  roots[0].dispatchEvent(new window.MouseEvent('mouseenter')); // hover shows the breakdown
  assert.equal(tip.hidden, false);
  assert.equal(badge.getAttribute('aria-expanded'), 'true');
  assert.ok(tip.textContent.includes('Click to see the reviews behind these numbers.'));
  roots[0].dispatchEvent(new window.MouseEvent('mouseleave'));
  assert.equal(tip.hidden, true);

  badge.click(); // clicking opens the reviews modal
  assert.equal(activations, 1);
  assert.equal(tip.hidden, true, 'tooltip gets out of the way');

  renderer.dispose();
  assert.equal(window.document.querySelectorAll('[data-rgr-root], [data-rgr-tip]').length, 0, 'badge and tooltip fully removed');
});

test('renderer: badge removed when the place panel disappears (SPA navigation)', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  const { run } = wire(window);
  run();
  assert.equal(window.document.querySelectorAll('[data-rgr-root]').length, 1);
  window.document.querySelector('[role="main"]').remove();
  run();
  assert.equal(window.document.querySelectorAll('[data-rgr-root], [data-rgr-tip]').length, 0);
});

test('renderer: climbs out of flex rows and puts the badge on its own line', () => {
  const html = `<div role="main"><div id="outer"><div id="flexrow" style="display:flex;flex-direction:row">
    <div class="F7nice"><span role="img" aria-label="4.5 stars "></span><span>(2,123)</span></div></div></div></div>`;
  const { window } = makeDom(html, 'https://www.google.com/maps/place/CHA');
  wire(window).run();
  const root = window.document.querySelector('[data-rgr-root]');
  assert.equal(root.previousElementSibling.id, 'flexrow', 'badge follows the whole flex row, not inside it');
  assert.equal(window.document.querySelector('.F7nice [data-rgr-root]'), null);
});

test('renderer: falls back to appending inside when every nearby ancestor is a row layout', () => {
  const row = (inner) => `<div style="display:flex;flex-direction:row">${inner}</div>`;
  const html = `<div role="main" style="display:flex;flex-direction:row">${row(row(row(row(
    '<div class="F7nice"><span role="img" aria-label="4.5 stars "></span><span>(2,123)</span></div>'))))}</div>`;
  const { window } = makeDom(html, 'https://www.google.com/maps/place/CHA');
  wire(window).run();
  assert.ok(window.document.querySelector('.F7nice > [data-rgr-root]'));
});

test('renderer: hops out of a fixed-height overflow:hidden header, and stays a single badge', () => {
  const html = `<div role="main"><div id="clip" style="overflow-y:hidden">
    <div class="F7nice"><span role="img" aria-label="4.5 stars "></span><span>(2,123)</span></div></div>
    <div id="after">next section</div></div>`;
  const { window } = makeDom(html, 'https://www.google.com/maps/place/CHA');
  // jsdom has no layout: fake one where the badge is taller than the clipping header.
  window.Element.prototype.getBoundingClientRect = function rect() {
    if (this.hasAttribute('data-rgr-root')) return { bottom: 100, height: 20 };
    if (this.id === 'clip') return { bottom: 60, height: 40 };
    return { bottom: 0, height: 0 };
  };
  const { run } = wire(window);
  run();
  run();
  const roots = window.document.querySelectorAll('[data-rgr-root]');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].previousElementSibling.id, 'clip', 'moved to just after the clipping ancestor');
  assert.equal(window.document.querySelectorAll('[data-rgr-tip]').length, 1);
});

test('renderer: skeleton <-> result transitions (e.g. Google swaps the review list)', () => {
  const { window } = makeDom(MAPS_HTML.replace(/<div class="jftiEf"[\s\S]*<\/div>\s*<\/div>$/, '</div>'), 'https://www.google.com/maps/place/CHA');
  const { dao, renderer } = wire(window);
  const uc = new CalculateRecentRatingUseCase({ reviewSource: dao });
  const pr = new RatingBadgePresenter();
  const draw = () => renderer.render(pr.present(uc.execute({ timeWindow: '6_MONTHS' })));
  const root = () => window.document.querySelector('[data-rgr-root]');
  const main = window.document.querySelector('[role="main"]');

  draw();
  assert.equal(root().dataset.rgrState, 'loading');
  assert.ok(!root().classList.contains('rgr-enter'));

  main.insertAdjacentHTML('beforeend', mapsReview('a', 5, '1 day ago'));
  draw();
  assert.equal(root().dataset.rgrState, 'ready');
  assert.ok(root().classList.contains('rgr-enter'), 'result fades in after a skeleton');

  main.querySelector('.jftiEf').remove(); // list swapped: reviews vanish while the new ones load
  draw();
  assert.equal(root().dataset.rgrState, 'loading');
  assert.ok(root().querySelector('.rgr-skeleton'));

  main.insertAdjacentHTML('beforeend', mapsReview('b', 3, '2 days ago'));
  draw();
  assert.equal(root().querySelector('.rgr-cell[data-rgr-window="6_MONTHS"] .rgr-cell-value').textContent, '3.0');
  assert.equal(window.document.querySelectorAll('[data-rgr-root]').length, 1);
  assert.equal(window.document.querySelectorAll('[data-rgr-tip]').length, 1);
});

// ---------------------------------------------------------------- controller

test('controller: renders, reacts to DOM mutations without feedback loops, respects disabled setting', async () => {
  const { window } = makeDom(MAPS_HTML.replace(/<div class="jftiEf"[\s\S]*<\/div>\s*<\/div>$/, '</div>'), 'https://www.google.com/maps/place/CHA');
  const { dao, renderer } = wire(window);
  let settings = { searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS' };
  let notify = () => {};
  let renders = 0;
  const realRender = renderer.render.bind(renderer);
  renderer.render = (vm) => { renders += 1; realRender(vm); };

  const controller = new ContentScriptController({
    window,
    document: window.document,
    settingsUseCase: { getSettings: async () => settings, subscribe: (cb) => { notify = () => cb(settings); return () => {}; } },
    calculateUseCase: new CalculateRecentRatingUseCase({ reviewSource: dao }),
    presenter: new RatingBadgePresenter(),
    renderer,
    debounceMs: 10,
    maxWaitMs: 50,
  });
  await controller.start();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // No reviews on the page yet: a skeleton, not "n=0".
  const skeleton = window.document.querySelector('.rgr-badge.rgr-skeleton');
  assert.ok(skeleton, 'skeleton shown while waiting');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  // The skeleton is the finished strip's own elements with placeholder text, so it has the same size: the same three
  // cells, nothing real in them, every text part a shimmering placeholder.
  assert.equal(skeleton.querySelectorAll('.rgr-cell').length, 3);
  assert.ok([...skeleton.querySelectorAll('.rgr-cell-value, .rgr-cell-n')].every((el) => el.classList.contains('rgr-skel-text')));
  assert.equal(skeleton.querySelector('.rgr-cell-value').textContent, '0.0');
  assert.equal(skeleton.querySelector('.rgr-cell-n').textContent, 'n=00');
  assert.ok(skeleton.querySelector('.rgr-lead.rgr-skel-icon'), 'the lead slot is reserved too');
  await sleep(60);
  assert.equal(renders, 1, 'own injection must not retrigger rendering');

  // Lazy-loaded review arrives -> skeleton resolves into the calculated badge.
  window.document.querySelector('[role="main"]').insertAdjacentHTML('beforeend', mapsReview('late', 5, '1 day ago'));
  await sleep(60);
  assert.equal(window.document.querySelector('.rgr-skeleton'), null, 'skeleton gone');
  assert.equal(window.document.querySelector('.rgr-cell[data-rgr-window="6_MONTHS"] .rgr-cell-n').textContent, 'n=1');
  assert.ok(window.document.querySelector('.rgr-root').classList.contains('rgr-enter'), 'fades in where the skeleton was');
  assert.equal(window.document.querySelectorAll('[data-rgr-root]').length, 1);

  // Disabled -> removed.
  settings = { searchEnabled: false, mapsEnabled: false, timeWindow: '6_MONTHS' };
  notify();
  await sleep(30);
  assert.equal(window.document.querySelectorAll('[data-rgr-root]').length, 0);

  controller.stop();
});

test('renderer: pulls the badge up when Google leaves a big empty gap under the rating row, but never pushes it down', () => {
  const html = `<div role="main"><div class="F7nice"><span role="img" aria-label="4.5 stars "></span><span>(2,123)</span></div></div>`;
  const place = (rowBottom, badgeTop) => {
    const { window } = makeDom(html, 'https://www.google.com/maps/place/CHA');
    window.Element.prototype.getBoundingClientRect = function rect() {
      if (this.hasAttribute('data-rgr-root')) return { top: badgeTop, bottom: badgeTop + 28, height: 28 };
      if (this.classList.contains('F7nice')) return { top: rowBottom - 20, bottom: rowBottom, height: 20 };
      return { top: 0, bottom: 0, height: 0 };
    };
    wire(window).run();
    return window.document.querySelector('[data-rgr-root]').style.marginTop;
  };
  // (jsdom loads no stylesheet, so the badge's own margin is 0 here)
  assert.equal(place(100, 148), '-40px', '48px gap, 8px wanted: pulled up by the 40px excess');
  assert.equal(place(100, 112), '', 'already close: untouched');
  assert.equal(place(100, 108), '', 'at the target: untouched');
});

test('renderer: badge and tooltip follow the system on Search and are pinned to light on Maps', () => {
  const themeOn = (html, url, systemDark) => {
    const { window } = makeDom(html, url);
    window.matchMedia = () => ({ matches: systemDark });
    const { run } = wire(window);
    run();
    return {
      badge: window.document.querySelector('[data-rgr-root]').dataset.rgrTheme,
      tip: window.document.querySelector('[data-rgr-tip]').dataset.rgrTheme,
    };
  };
  assert.deepEqual(themeOn(MAPS_HTML, 'https://www.google.com/maps/place/CHA', true), { badge: 'light', tip: 'light' });
  assert.deepEqual(themeOn(SEARCH_HTML, 'https://www.google.com/search?q=krasi', true), { badge: 'dark', tip: 'dark' });
  assert.deepEqual(themeOn(SEARCH_HTML, 'https://www.google.com/search?q=krasi', false), { badge: 'light', tip: 'light' });
});

test('renderer: clicking a cell reports its window (the modal opens there); clicking elsewhere on the badge reports none', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  const activations = [];
  const { run } = wire(window, { onActivate: (windowId) => activations.push(windowId) });
  run();
  const root = window.document.querySelector('[data-rgr-root]');
  root.querySelector('.rgr-cell[data-rgr-window="3_MONTHS"] .rgr-cell-value').click(); // a click on a child bubbles to the badge
  root.querySelector('.rgr-lead').click();
  assert.deepEqual(activations, ['3_MONTHS', undefined]);
});

test('renderer: a gap that appears after the badge was placed (Google\'s layout settling) is closed on the next update', () => {
  const html = `<div role="main"><div class="F7nice"><span role="img" aria-label="4.5 stars "></span><span>(2,123)</span></div></div>`;
  const { window } = makeDom(html, 'https://www.google.com/maps/place/CHA');
  let badgeTop = 108; // placed fine at first
  window.Element.prototype.getBoundingClientRect = function rect() {
    if (this.hasAttribute('data-rgr-root')) return { top: badgeTop, bottom: badgeTop + 28, height: 28 };
    if (this.classList.contains('F7nice')) return { top: 80, bottom: 100, height: 20 };
    return { top: 0, bottom: 0, height: 0 };
  };
  const { run } = wire(window);
  run();
  const root = () => window.document.querySelector('[data-rgr-root]');
  assert.equal(root().style.marginTop, '', 'at the target: untouched');
  badgeTop = 148; // the page re-laid out and left a 48px gap
  run(); // same view model: nothing is redrawn, the gap is still re-checked
  assert.equal(root().style.marginTop, '-40px');
});

test('renderer: the "larger screen" note is a quiet, non-interactive pill (no cells, nothing opens when it is pressed)', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  const activations = [];
  const dao = new GoogleDomReviewDao({ document: window.document });
  const renderer = new BadgeDomRenderer({ window, document: window.document, locateAnchor: () => dao.locateBadgeAnchor(), onActivate: (id) => activations.push(id) });
  const presenter = new RatingBadgePresenter();
  const summary = new CalculateRecentRatingUseCase({ reviewSource: dao }).execute({ timeWindow: '6_MONTHS' });
  renderer.render(presenter.present(summary, { unsupported: true }));

  const root = window.document.querySelector('[data-rgr-root]');
  const badge = root.querySelector('.rgr-badge');
  assert.equal(root.dataset.rgrState, 'unsupported');
  assert.equal(badge.textContent, 'Recent-only rating · open on desktop');
  assert.equal(badge.getAttribute('aria-disabled'), 'true');
  assert.equal(root.querySelectorAll('.rgr-cell').length, 0);
  assert.ok(badge.querySelector('svg.rgr-screen-icon'));
  badge.click();
  assert.deepEqual(activations, [], 'pressing it does nothing');
});

// ---------------------------------------------------------------- two branches of one chain

const BRANCH_A = 'https://www.google.com/maps/place/Starbucks/@42.3,-71.0,17z/data=!4m6!3m5!1s0x89e37ba3e4c0cfd9:0xb0f6eda17d372f7c!8m2!3d42.3!4d-71.0';
const BRANCH_B = 'https://www.google.com/maps/place/Starbucks/@42.4,-71.1,17z/data=!4m6!3m5!1s0x89e37ba3e4c0cfd9:0x1111111111111111!8m2!3d42.4!4d-71.1';
const REVIEWS_TAB_A = 'https://www.google.com/maps/place/Starbucks/@42.3,-71.0,17z/data=!4m16!1m9!3m8!1s0x89e37ba3e4c0cfd9:0xb0f6eda17d372f7c!2sStarbucks!9m1!1b1';

test('maps: two branches with the same name are different places; one branch keeps its key across tabs and without a name', () => {
  const { window } = makeDom(MAPS_HTML.replaceAll('CHA Cambridge Hospital', 'Starbucks'), BRANCH_A);
  const dao = new GoogleDomReviewDao({ document: window.document });
  const a = dao.readSnapshot().placeKey;
  assert.equal(a, '0x89e37ba3e4c0cfd9:0xb0f6eda17d372f7c');

  window.history.pushState({}, '', REVIEWS_TAB_A);
  window.document.querySelector('h1').remove();
  window.document.querySelector('[role="main"]').removeAttribute('aria-label'); // the Reviews tab has no readable name
  assert.equal(dao.readSnapshot().placeName, null);
  assert.equal(dao.readSnapshot().placeKey, a, 'same branch: same place, whatever the tab or the name');

  window.history.pushState({}, '', BRANCH_B);
  assert.notEqual(dao.readSnapshot().placeKey, a, 'another branch of the chain is another place');
});

test('caching source: moving to another branch of the same chain forgets the first branch\'s reviews and result', () => {
  const { window } = makeDom(MAPS_HTML.replaceAll('CHA Cambridge Hospital', 'Starbucks'), BRANCH_A);
  const source = new CachingGoogleReviewSource({ dao: new GoogleDomReviewDao({ document: window.document }) });
  assert.equal(source.readSnapshot().reviews.length, 5);
  source.markComplete();
  assert.equal(source.readSnapshot().complete, true);

  window.history.pushState({}, '', BRANCH_B);
  window.document.querySelectorAll('[data-review-id]').forEach((n) => n.remove()); // branch B's page has loaded no reviews yet
  const afterMove = source.readSnapshot();
  assert.equal(afterMove.reviews.length, 0, 'branch A\'s reviews are not branch B\'s');
  assert.equal(afterMove.complete, false, 'and neither is its finished result');
  assert.match(afterMove.placeKey, /0x1111111111111111$/);
});

test('renderer: a partial window gets the underline class and nothing else changes (no width change, so no shift)', () => {
  const { window } = makeDom(MAPS_HTML, 'https://www.google.com/maps/place/CHA');
  window.document.querySelector('[data-review-id="r4"]').remove(); // the year-old review is what made every window reachable
  const dao = new GoogleDomReviewDao({ document: window.document });
  const renderer = new BadgeDomRenderer({ window, document: window.document, locateAnchor: () => dao.locateBadgeAnchor() });
  const presenter = new RatingBadgePresenter();
  const windows = new CalculateRecentRatingUseCase({ reviewSource: dao }).executeAll({ timeWindows: TREND_WINDOWS });
  renderer.render(presenter.present(windows[2], { windows }));
  const cells = [...window.document.querySelectorAll('.rgr-cell')];
  assert.equal(cells.length, 3);
  // 4 of 2,123 reviews, the oldest 5 months: older than 1M and 3M, but still inside 6M, so only 6M is not reached
  assert.deepEqual(cells.map((c) => c.classList.contains('rgr-partial')), windows.map((w) => !w.covered));
  assert.ok(cells.some((c) => c.classList.contains('rgr-partial')), 'this fixture really has uncovered windows');
});
