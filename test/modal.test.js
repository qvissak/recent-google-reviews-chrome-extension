import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Review } from '../src/domain/entities/Review.js';
import { RatingSummary } from '../src/domain/entities/RatingSummary.js';
import { RelativeTimeParser } from '../src/domain/services/RelativeTimeParser.js';
import { GoogleDomReviewDao } from '../src/adapters/dao/GoogleDomReviewDao.js';
import { CachingGoogleReviewSource } from '../src/adapters/dao/CachingGoogleReviewSource.js';
import { GoogleReviewsLoader } from '../src/adapters/dao/GoogleReviewsLoader.js';
import { ReviewsModalPresenter } from '../src/adapters/presenters/ReviewsModalPresenter.js';
import { ReviewsModalRenderer } from '../src/frameworks/ui/ReviewsModalRenderer.js';
import { ReviewsModalController } from '../src/frameworks/content/ReviewsModalController.js';
import { CalculateRecentRatingUseCase } from '../src/usecases/CalculateRecentRatingUseCase.js';
import { LoadReviewsUseCase } from '../src/usecases/LoadReviewsUseCase.js';

const parser = new RelativeTimeParser();
const TINY = { pollMs: 1, linkTimeoutMs: 15, openTimeoutMs: 60, sortTimeoutMs: 15, loadTimeoutMs: 15, settleMs: 0 };

function makeDom(url = 'https://www.google.com/search?q=krasi') {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  dom.window.Element.prototype.getClientRects = function getClientRects() { return [{}]; }; // pretend everything renders
  return dom;
}

// ------------------------------------------------------------ a Google-like Search page

const reviewCard = (id, rating, when) => `
  <div class="card"><span data-review-id="${id}"></span>
    <div class="hdr"><span role="img" aria-label="Rated ${rating}.0 out of 5,"></span><span>${when}</span></div>
    <p>Review text ${id}</p>
    <a href="https://example.com/profile" jsaction="click:x" jscontroller="y" id="dup-${id}">Author</a>
    <script>1+1</script>
  </div>`;

/**
 * A Search knowledge panel whose "N Google reviews" link opens an overlay that
 * lazy-loads one page of reviews per scroll — like Google's.
 */
function mountSearchWorld(window, pages) {
  const doc = window.document;
  doc.body.innerHTML = `<div id="rhs"><div data-attrid="title">Krasi</div>
    <div data-attrid="subtitle"><div id="row"><span role="img" aria-label="Rated 4.6 out of 5,"></span>
    <a role="button" id="opener"><span>1,238 Google reviews</span></a></div></div></div>`;
  const world = { openerClicks: 0, loadedPages: 0 };
  const render = (list) => {
    list.innerHTML = pages.slice(0, world.loadedPages).flatMap((page, p) => page.map(([rating, when], i) => reviewCard(`p${p}-${i}`, rating, when))).join('');
  };
  doc.getElementById('opener').addEventListener('click', () => {
    world.openerClicks += 1;
    world.loadedPages = 1;
    const dlg = doc.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.id = 'google-dialog';
    dlg.innerHTML = `<div id="head"><span role="img" aria-label="Rated 4.6 out of 5,"></span><span>1,238 reviews</span></div>
      <button><span>Newest</span></button>
      <div id="scroller" style="overflow-y:auto"><div id="list"></div></div>`;
    doc.body.append(dlg);
    const scroller = dlg.querySelector('#scroller');
    const list = dlg.querySelector('#list');
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 400 });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => 0,
      set: () => { if (world.loadedPages < pages.length) { world.loadedPages += 1; render(list); } },
    });
    render(list);
  });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') doc.getElementById('google-dialog')?.remove(); });
  return world;
}

const PAGES = [
  [[5, '2 days ago'], [4, '5 days ago'], [5, '2 weeks ago'], [3, '3 weeks ago']],
  [[5, 'a month ago'], [4, '2 months ago'], [5, '4 months ago']],
  [[2, '5 months ago'], [5, '7 months ago'], [3, 'a year ago']],
  [[4, '2 years ago']],
];

// ---------------------------------------------------------------------------- DAO + cache

test('DAO: reviews get stable ids; cloned cards are sanitized; place name is read', () => {
  const { window } = makeDom();
  mountSearchWorld(window, PAGES);
  window.document.getElementById('opener').click();
  const dao = new GoogleDomReviewDao({ document: window.document });
  const snap = dao.readSnapshot();

  assert.equal(snap.placeName, 'Krasi');
  assert.equal(snap.reviews[0].id, 'p0-0');
  assert.equal(snap.reviews.length, 4);

  const clone = dao.cloneCard('p0-0');
  assert.ok(clone.textContent.includes('Review text p0-0'));
  assert.equal(clone.querySelector('script'), null);
  assert.equal(clone.querySelector('[id]'), null, 'ids removed (they would duplicate)');
  assert.equal(clone.querySelector('[jsaction],[jscontroller]'), null, 'cannot reach Google handlers');
  assert.equal(clone.querySelector('[href]'), null, 'no links that navigate away');
  assert.equal(clone.querySelector('[data-review-id]'), null);
  assert.equal(dao.cloneCard('nope'), null);
  assert.ok(window.document.querySelector('#dup-p0-0'), 'the live card is untouched');
});

test('CachingSource: remembers reviews + cards after Google closes its list; resets for a new place', () => {
  const { window } = makeDom();
  mountSearchWorld(window, PAGES);
  window.document.getElementById('opener').click();
  const source = new CachingGoogleReviewSource({ dao: new GoogleDomReviewDao({ document: window.document }) });

  const open = source.readSnapshot();
  assert.equal(open.reviews.length, 4);
  assert.equal(open.allTimeRating, 4.6);

  window.document.getElementById('google-dialog').remove(); // Google closes its list
  const closed = source.readSnapshot();
  assert.equal(closed.reviews.length, 4, 'still remembered');
  assert.equal(closed.allTimeRating, 4.6, 'headline remembered too');
  const card = source.cardFor('p0-1');
  assert.ok(card.textContent.includes('Review text p0-1'));
  assert.notEqual(card, source.cardFor('p0-1'), 'each call returns a fresh copy');

  window.document.querySelector('[data-attrid="title"]').textContent = 'Somewhere Else';
  assert.equal(source.readSnapshot().reviews.length, 0, 'different place: old reviews dropped');

  source.reset();
  assert.equal(source.readSnapshot().reviews.length, 0);
});

test('CachingSource: reviews are not "complete" until a load says so, and a new place starts over', () => {
  const { window } = makeDom();
  mountSearchWorld(window, PAGES);
  window.document.getElementById('opener').click();
  const source = new CachingGoogleReviewSource({ dao: new GoogleDomReviewDao({ document: window.document }) });
  assert.equal(source.readSnapshot().complete, false, 'only what the page happened to show');
  source.markComplete();
  assert.equal(source.readSnapshot().complete, true);
  window.document.querySelector('[data-attrid="title"]').textContent = 'Somewhere Else';
  assert.equal(source.readSnapshot().complete, false, 'different place: not loaded yet');
});

// ------------------------------------------------------------------------------- loader

test('Loader (Search): opens the overlay, loads page by page, and restores the page', async () => {
  const { window } = makeDom();
  const world = mountSearchWorld(window, PAGES);
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: TINY });
  const ids = () => window.document.querySelectorAll('#list [data-review-id]').length;

  await loader.open();
  assert.equal(world.openerClicks, 1);
  assert.equal(ids(), 4);
  assert.equal(await loader.loadMore(), true);
  assert.equal(ids(), 7);
  assert.equal(await loader.loadMore(), true);
  assert.equal(await loader.loadMore(), true);
  assert.equal(ids(), 11);
  assert.equal(await loader.loadMore(), false, 'nothing left');

  await loader.close();
  assert.equal(window.document.getElementById('google-dialog'), null, 'overlay dismissed');
});

test('Loader (Search): starting right as the page renders is fine: it waits for the reviews link instead of giving up', async () => {
  const { window } = makeDom();
  window.document.body.innerHTML = '<div id="rhs"><div data-attrid="subtitle"><div id="row"><span role="img" aria-label="Rated 4.6 out of 5,"></span></div></div></div>'; // the rating row, no link yet
  let world = null;
  window.setTimeout(() => { world = mountSearchWorld(window, PAGES); }, 30); // the link renders a moment later
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: { ...TINY, linkTimeoutMs: 400 } });

  await loader.open();
  assert.equal(world?.openerClicks, 1, 'found the link once it existed and opened the list');
  assert.equal(window.document.querySelectorAll('#list [data-review-id]').length, 4);
  await loader.close();
});

test('Loader (Search): no reviews link at all: gives up after linkTimeoutMs without clicking anything', async () => {
  const { window } = makeDom();
  window.document.body.innerHTML = '<div id="rhs"><div data-attrid="subtitle"><div id="row"></div></div></div>';
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: { ...TINY, linkTimeoutMs: 20 } });
  const started = Date.now();
  await loader.open();
  assert.ok(Date.now() - started < 1000, 'bounded wait');
  assert.equal(await loader.loadMore(), false);
  await loader.close();
});

test('Loader (Maps): the Reviews tab arriving after the rating row is waited for, then clicked', async () => {
  const { window } = makeDom('https://www.google.com/maps/place/Krasi');
  const doc = window.document;
  doc.body.innerHTML = '<div role="main" aria-label="Krasi"></div>';
  let clicks = 0;
  window.setTimeout(() => {
    doc.body.innerHTML = '<div role="main"><button role="tab" aria-selected="true">Overview</button><button role="tab" id="t-rev" aria-selected="false">Reviews</button></div>';
    doc.getElementById('t-rev').addEventListener('click', () => { clicks += 1; });
  }, 30);
  const loader = new GoogleReviewsLoader({ document: doc, window, timing: { ...TINY, linkTimeoutMs: 400 } });
  await loader.open();
  assert.equal(clicks, 1);
  await loader.close();
});

test('Loader (Search): leaves a list the user already opened alone', async () => {
  const { window } = makeDom();
  const world = mountSearchWorld(window, PAGES);
  window.document.getElementById('opener').click();
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: TINY });

  await loader.open();
  assert.equal(world.openerClicks, 1, 'did not click the opener again');
  await loader.close();
  assert.ok(window.document.getElementById('google-dialog'), "the user's own overlay stays open");
});

test('Loader (Maps): selects Reviews, sorts by Newest, and goes back to the previous tab', async () => {
  const { window } = makeDom('https://www.google.com/maps/place/Krasi');
  const doc = window.document;
  doc.body.innerHTML = `<div role="main" aria-label="Krasi">
    <button role="tab" id="t-over" aria-selected="true">Overview</button>
    <button role="tab" id="t-rev" aria-selected="false">Reviews</button>
    <div id="snippets"><span data-review-id="snippet-1"></span></div>
    <div id="panel"></div></div>`; // like Maps: the Overview tab already has a review element before the Reviews tab renders
  const state = { sorted: false };
  const tabs = [...doc.querySelectorAll('[role=tab]')];
  const select = (tab) => tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  doc.getElementById('t-rev').addEventListener('click', () => {
    select(doc.getElementById('t-rev'));
    // the Reviews tab renders a little later than the click
    window.setTimeout(() => {
      doc.getElementById('snippets').remove(); // the Reviews tab replaces the Overview's snippets
      doc.getElementById('panel').innerHTML = `<button aria-label="Sort reviews">Sort</button><div id="menu"></div>
        <div class="cards"><span data-review-id="m1"></span></div>`;
      doc.querySelector('[aria-label="Sort reviews"]').addEventListener('click', () => {
        doc.getElementById('menu').innerHTML = '<div role="menuitemradio" id="newest">Newest</div>';
        doc.getElementById('newest').addEventListener('click', () => {
          state.sorted = true;
          doc.querySelector('.cards').innerHTML = ''; // Maps empties the list while the new sort loads...
          window.setTimeout(() => { doc.querySelector('.cards').innerHTML = '<span data-review-id="m2"></span><span data-review-id="m3"></span>'; }, 25); // ...then refills it
        });
      });
    }, 15);
  });
  doc.getElementById('t-over').addEventListener('click', () => select(doc.getElementById('t-over')));

  const loader = new GoogleReviewsLoader({ document: doc, window, timing: { ...TINY, openTimeoutMs: 300, sortTimeoutMs: 300 } });
  await loader.open();
  assert.equal(doc.getElementById('t-rev').getAttribute('aria-selected'), 'true');
  assert.equal(state.sorted, true, 'it waited for the Sort control instead of moving on');
  assert.ok(doc.querySelectorAll('.cards [data-review-id]').length > 0, 'and for the re-sorted list to come back, not just to change');
  await loader.close();
  assert.equal(doc.getElementById('t-over').getAttribute('aria-selected'), 'true', 'back where the user was');
});

test('Loader: loadMore waits for an emptied list (a sort loading) to fill, and does not scroll while there is nothing to scroll', async () => {
  const { window } = makeDom('https://www.google.com/maps/place/Krasi');
  const doc = window.document;
  doc.body.innerHTML = '<div role="main"><div id="list"></div></div>';
  window.setTimeout(() => { doc.getElementById('list').innerHTML = '<span data-review-id="a"></span><span data-review-id="b"></span>'; }, 30);
  const loader = new GoogleReviewsLoader({ document: doc, window, timing: { ...TINY, loadTimeoutMs: 200 } });
  assert.equal(await loader.loadMore(), true, 'reviews appeared where there were none: that is growth');

  doc.getElementById('list').innerHTML = '';
  assert.equal(await new GoogleReviewsLoader({ document: doc, window, timing: TINY }).loadMore(), false, 'a list that never appears is not growth');
});

// ---------------------------------------------------------------------- modal presenter

function summary(overrides = {}) {
  const reviews = [new Review({ rating: 5, rawTimestamp: '2 days ago', parsedAgeBucket: parser.parse('2 days ago'), id: 'a' })];
  return new RatingSummary({
    recentAverage: 4.8, sampleCount: 1, totalScanned: 4, allTimeRating: 4.6, delta: 0.2,
    timeWindow: '6_MONTHS', timeWindowLabel: '~6 months', allTimeReviewCount: 1078,
    placeName: 'Little Sister', matchedReviews: reviews, ...overrides,
  });
}

test('ReviewsModalPresenter: headline, dropdown and status follow the summary', () => {
  const vm = new ReviewsModalPresenter().present(summary());
  assert.equal(vm.title, 'Little Sister');
  assert.equal(vm.subtitle, 'Only reviews from the last 6 months');
  assert.deepEqual(vm.windowOptions.map((o) => o.label), ['Last week', 'Last month', ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `Last ${n} months`)]);
  assert.equal(vm.windowOptions.find((o) => o.selected).id, '6_MONTHS');
  assert.equal(vm.state, 'ready');
  assert.equal(vm.headline.valueText, '4.8');
  assert.equal(vm.headline.countText, '1 review');
  assert.equal(vm.headline.allTimeText, 'All-time 4.6 ★ · 1,078 reviews');
  assert.equal(vm.headline.deltaText, '+0.2 vs all-time');
  assert.deepEqual(vm.reviewIds, ['a']);
  assert.equal(vm.statusText, 'Based on 1 of 4 loaded reviews');

  const loading = new ReviewsModalPresenter().present(summary({ sampleCount: 0, recentAverage: null, delta: null, totalScanned: 0, matchedReviews: [] }), { loading: true });
  assert.equal(loading.state, 'loading');
  const empty = new ReviewsModalPresenter().present(summary({ sampleCount: 0, recentAverage: null, delta: null, matchedReviews: [], timeWindow: '1_WEEK' }));
  assert.equal(empty.state, 'empty');
  assert.match(empty.emptyText, /None of the 4 loaded reviews are from the last week\. Try a wider window\./);
  assert.match(new ReviewsModalPresenter().present(summary(), { partial: true }).statusText, /stopped early/);
  assert.match(new ReviewsModalPresenter().present(summary(), { loading: true }).statusText, /Loading reviews… 4 loaded so far/);
});

// ---------------------------------------------------------------------- modal renderer

test('ReviewsModalRenderer: draws the view model, reuses cards, and reports interactions', () => {
  const { window } = makeDom();
  const doc = window.document;
  const events = [];
  const renderer = new ReviewsModalRenderer({
    window, document: doc,
    cloneCard: (id) => { const el = doc.createElement('div'); el.textContent = `card ${id}`; return el; },
    onWindowChange: (id) => events.push(['window', id]),
    onClose: () => events.push(['close']),
  });
  const presenter = new ReviewsModalPresenter();
  const ids = (...list) => list.map((id) => new Review({ rating: 5, rawTimestamp: '1 day ago', parsedAgeBucket: parser.parse('1 day ago'), id }));

  renderer.render(presenter.present(summary({ sampleCount: 0, recentAverage: null, delta: null, totalScanned: 0, matchedReviews: [] }), { loading: true }));
  assert.ok(doc.querySelector('[data-rgr-modal] .rgr-review-skeleton'), 'skeleton cards while loading');

  renderer.render(presenter.present(summary({ matchedReviews: ids('a', 'b'), sampleCount: 2 })));
  assert.equal(doc.querySelector('.rgr-modal-title').textContent, 'Little Sister');
  assert.equal(doc.querySelector('.rgr-score-value').textContent, '4.8');
  assert.equal(doc.querySelectorAll('.rgr-select option').length, 12);
  assert.equal(doc.querySelector('.rgr-select').value, '6_MONTHS');
  const first = doc.querySelectorAll('article.rgr-review');
  assert.deepEqual([...first].map((n) => n.textContent), ['card a', 'card b']);
  assert.equal(doc.querySelector('.rgr-score-stars').style.getPropertyValue('--rgr-fill'), '96%');

  renderer.render(presenter.present(summary({ matchedReviews: ids('a', 'b', 'c'), sampleCount: 3 })));
  const second = doc.querySelectorAll('article.rgr-review');
  assert.equal(second.length, 3);
  assert.equal(second[0], first[0], 'existing cards are reused, not rebuilt');

  renderer.render(presenter.present(summary({ matchedReviews: [], sampleCount: 0, recentAverage: null, delta: null, timeWindow: '1_WEEK' })));
  assert.ok(doc.querySelector('.rgr-empty').textContent.includes('Try a wider window'));

  const select = doc.querySelector('.rgr-select');
  select.value = '3_MONTHS';
  select.dispatchEvent(new window.Event('change'));
  assert.deepEqual(events.pop(), ['window', '3_MONTHS']);

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(events.pop(), ['close']);
  const synthetic = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  synthetic.rgrSynthetic = true;
  doc.dispatchEvent(synthetic);
  assert.equal(events.length, 0, "ignores the loader's own Escape");

  doc.querySelector('.rgr-modal-close').click();
  assert.deepEqual(events.pop(), ['close']);
  doc.querySelector('.rgr-modal').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.deepEqual(events.pop(), ['close'], 'clicking the backdrop closes');

  renderer.dispose();
  assert.equal(doc.querySelector('[data-rgr-modal]'), null);
});

// -------------------------------------------------------------------- end to end (jsdom)

function composeStack(window, { initialWindow }) {
  const document = window.document;
  const dao = new GoogleDomReviewDao({ document });
  const source = new CachingGoogleReviewSource({ dao });
  const loader = new GoogleReviewsLoader({ document, window, timing: TINY });
  let loadMoreCalls = 0;
  const realLoadMore = loader.loadMore.bind(loader);
  loader.loadMore = async () => { loadMoreCalls += 1; return realLoadMore(); };

  const calculateUseCase = new CalculateRecentRatingUseCase({ reviewSource: source });
  const loadUseCase = new LoadReviewsUseCase({ reviewSource: source, reviewLoader: loader });
  const settings = { timeWindow: initialWindow };
  let modal;
  const renderer = new ReviewsModalRenderer({
    window, document,
    cloneCard: (id) => source.cardFor(id),
    onWindowChange: (id) => modal.changeWindow(id),
    onClose: () => modal.close(),
  });
  modal = new ReviewsModalController({
    calculateUseCase, loadUseCase, presenter: new ReviewsModalPresenter(), renderer,
    getTimeWindow: () => settings.timeWindow,
    setTimeWindow: async (id) => { settings.timeWindow = id; },
  });
  return { modal, settings, source, loadMoreCalls: () => loadMoreCalls };
}

test('end to end: badge click -> modal loads reviews behind it -> dropdown re-filters and re-rates -> close restores Google', async () => {
  const { window } = makeDom();
  const world = mountSearchWorld(window, PAGES);
  const doc = window.document;
  const { modal, loadMoreCalls } = composeStack(window, { initialWindow: '1_MONTH' });

  const shown = () => [...doc.querySelectorAll('[data-rgr-modal] article.rgr-review')].map((n) => n.textContent.match(/Review text (\S+)/)[1]);
  const score = () => doc.querySelector('.rgr-score-value').textContent;
  const select = (id) => {
    const el = doc.querySelector('.rgr-select');
    el.value = id;
    el.dispatchEvent(new window.Event('change'));
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  const opening = modal.open();
  assert.ok(doc.querySelector('[data-rgr-modal]'), 'modal appears immediately');
  assert.ok(doc.querySelector('.rgr-review-skeleton'), 'skeleton while Google loads behind it');
  await opening;
  assert.equal(world.openerClicks, 1);

  // Last month: 2d, 5d, 2w, 3w, a month ago => 5,4,5,3,5
  assert.deepEqual(shown(), ['p0-0', 'p0-1', 'p0-2', 'p0-3', 'p1-0']);
  assert.equal(score(), '4.4');
  assert.equal(doc.querySelector('.rgr-modal-subtitle').textContent, 'Only reviews from the last month');
  assert.equal(loadMoreCalls(), 1, 'stopped as soon as "2 months ago" proved the window covered');

  select('1_WEEK'); // narrower: answered instantly from what is loaded
  await settle();
  assert.deepEqual(shown(), ['p0-0', 'p0-1']);
  assert.equal(score(), '4.5');
  assert.equal(loadMoreCalls(), 1, 'no extra loading for a narrower window');

  select('11_MONTHS'); // wider: loads more until a year-old review shows up
  await settle();
  await settle();
  assert.equal(shown().length, 9, 'everything under a year, newest first');
  assert.equal(shown()[0], 'p0-0');
  assert.equal(shown().includes('p2-2'), false, '"a year ago" is outside "last year"');
  assert.equal(score(), '4.2'); // (5+4+5+3+5+4+5+2+5) / 9 = 4.22
  assert.ok(loadMoreCalls() >= 2);

  modal.close();
  assert.equal(doc.querySelector('[data-rgr-modal]'), null, 'modal removed');
  await settle();
  assert.equal(doc.getElementById('google-dialog'), null, "Google's own overlay was put away");
});

test('ReviewsModalController: ignores results that arrive after the modal was closed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const renders = [];
  const modal = new ReviewsModalController({
    calculateUseCase: { execute: () => summary() },
    loadUseCase: { execute: async () => { await gate; return { reason: 'covered', rounds: 0 }; }, extend: async () => ({ reason: 'covered', rounds: 0 }), release: async () => {}, freshResult: () => null, discard() {} },
    presenter: { present: (s, p) => ({ ...p, s }) },
    renderer: { render: (vm) => renders.push(vm), dispose: () => {} },
    getTimeWindow: () => '6_MONTHS',
    setTimeWindow: async () => {},
  });
  const opening = modal.open();
  modal.close();
  const before = renders.length;
  release();
  await opening;
  assert.equal(renders.length, before, 'no render after close');
});

// ------------------------------------------------- cloned cards keep Google's look

test('DAO clone: freezes theme colors that Google scopes to its dialog, and drops dead controls', () => {
  const { window } = makeDom();
  window.document.head.innerHTML = '<style>.card .name { color: rgb(255, 0, 0); background-color: rgb(1, 2, 3); }</style>';
  window.document.body.innerHTML = `<div role="dialog"><div class="card"><span data-review-id="x"></span>
    <div class="hdr"><span role="img" aria-label="Rated 5.0 out of 5,"></span><span>2 days ago</span></div>
    <span class="name">Mukkie</span>
    <a role="button"><span>More</span></a>
    <button><span>Hover to react</span></button>
    <p>Great food</p></div></div>`;
  const dao = new GoogleDomReviewDao({ document: window.document });
  dao.readSnapshot();

  const clone = dao.cloneCard('x');
  const name = clone.querySelector('.name');
  assert.equal(name.style.color, 'rgb(255, 0, 0)', 'colour that depended on the original\'s ancestors is now inline');
  assert.equal(name.style.backgroundColor, 'rgb(1, 2, 3)');
  assert.ok(!clone.textContent.includes('More'));
  assert.ok(!clone.textContent.includes('Hover to react'));
  assert.ok(clone.textContent.includes('Great food'));
  assert.ok(window.document.body.textContent.includes('Hover to react'), 'the live card keeps its controls');
});

// -------------------------------------------------------------- theme + load more

test('Modal renderer: Search follows the system theme, Maps is pinned to light; and offers "Load more" when asked', () => {
  const themeFor = (url, systemDark) => {
    const { window } = makeDom(url);
    window.matchMedia = () => ({ matches: systemDark });
    window.document.body.style.backgroundColor = systemDark ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'; // page colors must not matter
    const renderer = new ReviewsModalRenderer({ window, document: window.document, cloneCard: () => null, onWindowChange() {}, onClose() {} });
    renderer.render(new ReviewsModalPresenter().present(summary()));
    const theme = window.document.querySelector('[data-rgr-modal]').dataset.rgrTheme;
    renderer.dispose();
    return theme;
  };
  assert.equal(themeFor('https://www.google.com/search?q=x', true), 'dark');
  assert.equal(themeFor('https://www.google.com/search?q=x', false), 'light');
  assert.equal(themeFor('https://www.google.com/maps/place/Foo', true), 'light', 'Maps has no dark mode on the web');
  assert.equal(themeFor('https://www.google.com/maps/place/Foo', false), 'light');

  const { window } = makeDom();
  let loadMoreClicks = 0;
  const renderer = new ReviewsModalRenderer({
    window, document: window.document, cloneCard: () => null, onWindowChange() {}, onClose() {},
    onLoadMore: () => { loadMoreClicks += 1; },
  });
  const presenter = new ReviewsModalPresenter();
  renderer.render(presenter.present(summary()));
  const button = window.document.querySelector('.rgr-load-more');
  assert.equal(button.hidden, true, 'hidden normally');
  renderer.render(presenter.present(summary(), { partial: true }));
  assert.equal(button.hidden, false);
  button.click();
  assert.equal(loadMoreClicks, 1);
  renderer.render(presenter.present(summary(), { partial: true, loading: true }));
  assert.equal(button.hidden, true, 'not while loading');
  renderer.dispose();
});

test('ReviewsModalController: hitting the round cap offers load-more, which extends the same session', async () => {
  const calls = [];
  const renders = [];
  const modal = new ReviewsModalController({
    calculateUseCase: { execute: () => summary() },
    loadUseCase: {
      execute: async () => { calls.push('execute'); return { reason: 'max-rounds', rounds: 12 }; },
      extend: async () => { calls.push('extend'); return { reason: 'covered', rounds: 3 }; },
      release: async () => {},
      freshResult: () => null,
      discard() {},
    },
    presenter: new ReviewsModalPresenter(),
    renderer: { render: (vm) => renders.push(vm), dispose() {} },
    getTimeWindow: () => '6_MONTHS',
    setTimeWindow: async () => {},
  });
  await modal.open();
  assert.equal(renders.at(-1).canLoadMore, true);
  assert.match(renders.at(-1).statusText, /stopped early/);

  await modal.loadMore();
  assert.deepEqual(calls, ['execute', 'extend'], 'continues, does not restart');
  assert.equal(renders.at(-1).canLoadMore, false);
});

// ------------------------------------------- don't let Google see clicks inside our modal

test('Modal renderer: clicks inside it never reach the page (Google would dismiss its own dialog)', () => {
  const { window } = makeDom();
  const doc = window.document;
  const seen = [];
  for (const type of ['click', 'mousedown', 'pointerdown']) doc.addEventListener(type, () => seen.push(type)); // "Google's" outside-click handler
  const events = [];
  const renderer = new ReviewsModalRenderer({
    window, document: doc, cloneCard: () => null,
    onWindowChange: (id) => events.push(id), onClose: () => events.push('close'), onLoadMore: () => events.push('more'),
  });
  renderer.render(new ReviewsModalPresenter().present(summary(), { partial: true }));

  doc.querySelector('.rgr-load-more').click();
  doc.querySelector('.rgr-select').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  doc.querySelector('.rgr-modal-title').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
  assert.deepEqual(events, ['more'], 'our own handlers still ran');
  assert.deepEqual(seen, [], 'but the page-level handlers saw nothing');

  doc.body.click();
  assert.deepEqual(seen, ['click'], 'clicks outside the modal are untouched');
  renderer.dispose();
});

test('LoadReviews + Loader: extend() starts over if Google closed its list; the loader reports it', async () => {
  const { window } = makeDom();
  const world = mountSearchWorld(window, PAGES);
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: TINY });
  assert.equal(loader.isOpen(), false, 'nothing open yet');
  await loader.open();
  assert.equal(loader.isOpen(), true);
  window.document.getElementById('google-dialog').remove(); // dismissed by a stray click
  assert.equal(loader.isOpen(), false);

  const source = new CachingGoogleReviewSource({ dao: new GoogleDomReviewDao({ document: window.document }) });
  const useCase = new LoadReviewsUseCase({ reviewSource: source, reviewLoader: loader });
  const result = await useCase.extend({ timeWindow: '1_MONTH' });
  assert.equal(result.reason, 'covered');
  assert.equal(world.openerClicks, 2, 'reopened Google\'s list');
  assert.ok(source.readSnapshot().reviews.length >= 5);
  await useCase.release();
});

// ------------------------------------------------------- cards decide the modal's theme

test('DAO clone: records the card\'s native width/padding and what it sat on', () => {
  const { window } = makeDom();
  window.document.body.innerHTML = `<div role="dialog" style="background-color: rgb(255, 255, 255)"><div class="card" style="padding: 0 24px"><span data-review-id="x"></span>
    <div class="hdr"><span role="img" aria-label="Rated 5.0 out of 5,"></span><span>2 days ago</span></div><p>Great food</p></div>
    <div class="card"><span data-review-id="y"></span><div class="hdr"><span role="img" aria-label="Rated 4.0 out of 5,"></span><span>3 days ago</span></div></div></div>`;
  window.Element.prototype.getBoundingClientRect = function rect() { return { width: 402.4, height: 100, top: 0, bottom: 100, left: 0, right: 402 }; };
  const dao = new GoogleDomReviewDao({ document: window.document });
  dao.readSnapshot();
  const clone = dao.cloneCard('x');
  assert.equal(clone.dataset.rgrBg, 'rgb(255, 255, 255)');
  assert.equal(clone.dataset.rgrWidth, '402');
  assert.equal(clone.dataset.rgrPad, '24');
  assert.equal(clone.style.width, '', 'no inline width: the view decides the layout');
  assert.equal(dao.cloneCard('y').dataset.rgrPad, undefined, 'unpadded card: no padding recorded');
});

test('DAO clone: records a full-bleed child (Maps\' photo grid) but ignores small negative-margin hit areas', () => {
  const { window } = makeDom();
  window.document.body.innerHTML = `<div role="dialog"><div class="card"><span data-review-id="x"></span>
      <div class="hdr"><span role="img" aria-label="Rated 5.0 out of 5,"></span><span>2 days ago</span></div>
      <button class="icon" style="margin: -5px -8px"></button>
      <div class="photos" style="margin: 15px -24px 0"></div></div>
    <div class="card"><span data-review-id="y"></span><div class="hdr"><span role="img" aria-label="Rated 4.0 out of 5,"></span><span>3 days ago</span></div></div></div>`;
  window.Element.prototype.getBoundingClientRect = function rect() {
    const w = this.classList?.contains('photos') ? 402 : this.classList?.contains('icon') ? 48 : 354;
    return { width: w, height: 100, top: 0, bottom: 100, left: 0, right: w };
  };
  const dao = new GoogleDomReviewDao({ document: window.document });
  dao.readSnapshot();
  const clone = dao.cloneCard('x');
  assert.equal(clone.dataset.rgrBleed, '24', 'the 402px-wide block with -24px side margins');
  assert.equal(clone.dataset.rgrWidth, '354');
  assert.equal(dao.cloneCard('y').dataset.rgrBleed, undefined, 'no bleed child: nothing recorded');
});

test('DAO clone: drops Google\'s own separator on the card edge (the modal draws its own) but keeps inner borders', () => {
  const { window } = makeDom();
  window.document.body.innerHTML = `<div role="dialog"><div class="card"><span data-review-id="x"></span>
      <div class="hdr"><span role="img" aria-label="Rated 5.0 out of 5,"></span><span>2 days ago</span></div>
      <div class="mid" style="border-bottom: 1px solid red">middle</div>
      <div class="sep" style="border-bottom: 1px solid red"></div></div>
    <div class="card"><span data-review-id="y"></span><div class="hdr"><span role="img" aria-label="Rated 4.0 out of 5,"></span><span>3 days ago</span></div></div></div>`;
  const rects = { card: [0, 100], mid: [40, 60], sep: [98, 100] };
  window.Element.prototype.getBoundingClientRect = function rect() {
    const key = ['card', 'mid', 'sep'].find((k) => this.classList?.contains(k));
    const [top, bottom] = rects[key] ?? [0, 0];
    return { top, bottom, height: bottom - top, width: 300, left: 0, right: 300 };
  };
  const dao = new GoogleDomReviewDao({ document: window.document });
  dao.readSnapshot();
  const clone = dao.cloneCard('x');
  assert.equal(clone.querySelector('.sep').style.borderBottomWidth, '0px', 'edge separator removed');
  assert.notEqual(clone.querySelector('.mid').style.borderBottomWidth, '0px', 'a border in the middle of the card stays');
});

test('Modal renderer: the cards\' own surface colors the modal, but never changes its light/dark theme', () => {
  const { window } = makeDom('https://www.google.com/search?q=x');
  window.matchMedia = () => ({ matches: true }); // system: dark
  const lightCard = (id) => { const el = window.document.createElement('div'); el.textContent = id; el.dataset.rgrBg = 'rgb(255, 255, 255)'; return el; };
  const renderer = new ReviewsModalRenderer({ window, document: window.document, cloneCard: lightCard, onWindowChange() {}, onClose() {} });
  const presenter = new ReviewsModalPresenter();
  const modal = () => window.document.querySelector('[data-rgr-modal]');

  renderer.render(presenter.present(summary({ sampleCount: 0, recentAverage: null, delta: null, totalScanned: 0, matchedReviews: [] }), { loading: true }));
  assert.equal(modal().dataset.rgrTheme, 'dark', 'follows the system on Search');

  const reviews = ['a'].map((id) => new Review({ rating: 5, rawTimestamp: '1 day ago', parsedAgeBucket: parser.parse('1 day ago'), id }));
  renderer.render(presenter.present(summary({ matchedReviews: reviews, sampleCount: 1 })));
  assert.equal(modal().dataset.rgrTheme, 'dark', 'still the system theme once cards arrive: no flip');
  assert.equal(modal().style.getPropertyValue('--rgr-modal-bg'), 'rgb(255, 255, 255)');
  renderer.dispose();
});


// ------------------------------------------------------ card layout + scrolling

test('Modal renderer: Maps-style (padded, full-bleed) cards span the panel; other cards fill the content width', () => {
  const build = (props) => {
    const { window } = makeDom();
    const card = (id) => { const el = window.document.createElement('div'); el.textContent = id; Object.assign(el.dataset, props); return el; };
    const renderer = new ReviewsModalRenderer({ window, document: window.document, cloneCard: card, onWindowChange() {}, onClose() {} });
    const reviews = ['a'].map((id) => new Review({ rating: 5, rawTimestamp: '1 day ago', parsedAgeBucket: parser.parse('1 day ago'), id }));
    renderer.render(new ReviewsModalPresenter().present(summary({ matchedReviews: reviews, sampleCount: 1 })));
    const doc = window.document;
    return {
      article: doc.querySelector('article.rgr-review'),
      card: doc.querySelector('article.rgr-review > div'),
      panelWidth: doc.querySelector('.rgr-modal-panel').style.width,
      renderer,
    };
  };

  const maps = build({ rgrWidth: '402', rgrPad: '24' });
  assert.ok(maps.article.classList.contains('rgr-review-bleed'));
  assert.equal(maps.card.style.width, '100%');
  assert.equal(maps.card.style.boxSizing, 'border-box');
  assert.equal(maps.panelWidth, '', 'the panel keeps the size the loading skeleton had');

  // Maps' actual shape: root 354px wide, no padding, a photo block bleeding 24px out of each side
  const bleedChild = build({ rgrWidth: '354', rgrBleed: '24' });
  assert.ok(!bleedChild.article.classList.contains('rgr-review-bleed'), 'root stays inside the panel padding');
  assert.equal(bleedChild.panelWidth, '', 'still the skeleton\'s size, whatever the card natively measured');
  assert.equal(build({ rgrWidth: '700', rgrPad: '24' }).panelWidth, '');

  const search = build({ rgrWidth: '540' });
  assert.ok(!search.article.classList.contains('rgr-review-bleed'));
  assert.equal(search.card.style.width, '100%');
  assert.equal(search.panelWidth, '');
});

test('Modal renderer + CSS: one scroll area, no visible scrollbar, close button stays reachable', () => {
  const { window } = makeDom();
  const renderer = new ReviewsModalRenderer({ window, document: window.document, cloneCard: () => null, onWindowChange() {}, onClose() {} });
  renderer.render(new ReviewsModalPresenter().present(summary()));
  const panel = window.document.querySelector('.rgr-modal-panel');
  assert.ok(panel.firstElementChild.classList.contains('rgr-modal-closebar'));
  assert.ok(panel.firstElementChild.querySelector('.rgr-modal-close'));
  assert.equal(panel.querySelector('.rgr-modal-header .rgr-modal-close'), null);
  renderer.dispose();

  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));
  assert.match(rule('.rgr-modal-panel'), /overflow-y:\s*auto/);
  assert.match(rule('.rgr-modal-panel'), /scrollbar-width:\s*none/);
  assert.match(rule('.rgr-modal-panel'), /(?<![-\w])height:\s*min\(/, 'one fixed height, so the loaded modal is exactly the skeleton\'s size');
  assert.doesNotMatch(rule('.rgr-modal-panel'), /max-height/);
  assert.match(rule('.rgr-modal-panel::-webkit-scrollbar'), /display:\s*none/);
  assert.doesNotMatch(rule('.rgr-modal-body'), /overflow/, 'the body must not be a second scroller');
});

test('Loader (Search): keeps Google\'s dialog and its dimming scrim hidden while it drives them, and un-hides on close', async () => {
  const { window } = makeDom();
  mountSearchWorld(window, PAGES);
  const doc = window.document;
  const root = doc.documentElement;
  // Google dims the page with a full-viewport translucent fixed layer next to the dialog (obfuscated class names)
  const scrim = doc.createElement('div');
  scrim.id = 'scrim';
  scrim.style.cssText = 'position: fixed; background-color: rgba(0, 0, 0, 0.6)';
  doc.body.append(scrim);
  const innocent = doc.createElement('div'); // not a scrim: fixed but opaque
  innocent.style.cssText = 'position: fixed; background-color: rgb(255, 255, 255)';
  doc.body.append(innocent);
  const { innerWidth: vw, innerHeight: vh } = window;
  window.Element.prototype.getBoundingClientRect = function () { return { width: vw, height: vh, top: 0, left: 0, right: vw, bottom: vh }; };
  doc.elementsFromPoint = () => [scrim, innocent, doc.body, root];

  const loader = new GoogleReviewsLoader({ document: doc, window, timing: TINY });
  assert.equal(root.hasAttribute('data-rgr-quiet'), false);
  await loader.open();
  assert.equal(root.hasAttribute('data-rgr-quiet'), true, 'set before the dialog could show');
  assert.equal(scrim.hasAttribute('data-rgr-quiet-hide'), true, 'the dimming scrim is hidden too');
  assert.equal(innocent.hasAttribute('data-rgr-quiet-hide'), false, 'but not other fixed elements');
  await loader.close();
  assert.equal(root.hasAttribute('data-rgr-quiet'), false);
  assert.equal(scrim.hasAttribute('data-rgr-quiet-hide'), false, 'everything is put back');

  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
  const rule = css.slice(css.indexOf('html[data-rgr-quiet]'), css.indexOf('}', css.indexOf('html[data-rgr-quiet]')));
  assert.match(rule, /\[role="dialog"\]:not\(\.rgr-modal-panel\)/, 'never hides our own dialog');
  assert.match(rule, /\[data-rgr-quiet-hide\]/);
  assert.match(rule, /opacity:\s*0/);
  assert.doesNotMatch(rule, /display:\s*none|visibility/, 'must stay laid out so the loader can keep scrolling it');
});


test('DAO: the place key survives Google showing a different review count in its dialog than on the page', () => {
  const { window } = makeDom();
  mountSearchWorld(window, PAGES);
  const dao = new GoogleDomReviewDao({ document: window.document });
  const onPage = dao.readSnapshot().placeKey;
  window.document.getElementById('opener').click();
  window.document.querySelector('#google-dialog #head span:last-child').textContent = '1,239 reviews'; // the page said 1,238
  const inDialog = dao.readSnapshot();
  assert.notEqual(inDialog.allTimeReviewCount, 1238, 'the count really differs');
  assert.equal(inDialog.placeKey, onPage, 'still the same place');
  assert.equal(onPage, 'Krasi');
});

test('CSS: skeletons are the real elements\' own boxes (no fixed-size placeholder bars that could drift from the result)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');
  const ruleFrom = (start) => css.slice(css.indexOf(start), css.indexOf('}', css.indexOf(start)));
  const skelText = ruleFrom('.rgr-skel-text,');
  assert.match(skelText, /color:\s*transparent/, 'the glyphs are hidden, the box stays');
  assert.doesNotMatch(skelText, /(?<![-\w])(width|height):/, 'size comes from the placeholder text, never from a fixed number');
  assert.doesNotMatch(css, /rgr-score-skel/, 'no separate headline skeleton bars');
  assert.match(ruleFrom('.rgr-score-loading .rgr-score-stars {'), /background-clip:\s*text/, 'the real star glyphs shimmer');
});

test('Loader (Search): a re-sort landing late (same number of reviews, different ones) counts as growth, not as the end of the list', async () => {
  const { window } = makeDom();
  const doc = window.document;
  doc.body.innerHTML = '<div role="dialog" id="dlg"><div id="scroller" style="overflow-y: auto"><div id="list"></div></div></div>';
  const list = doc.getElementById('list');
  const draw = (ids) => { list.innerHTML = ids.map((id) => `<div data-review-id="${id}">x</div>`).join(''); };
  draw(['old-1', 'old-2', 'old-3']);
  const scroller = doc.getElementById('scroller');
  Object.defineProperty(scroller, 'scrollHeight', { value: 1000 });
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => 0,
    set: () => { window.setTimeout(() => draw(['new-1', 'new-2', 'new-3']), 5); }, // the Newest sort arrives late and swaps the list
  });
  const loader = new GoogleReviewsLoader({ document: doc, window, timing: TINY });
  assert.equal(await loader.loadMore(), true, 'new reviews appeared, so the load is not over');
});

test('Loader (Search): never clicks a review count that is a real link (a layout that would navigate away)', async () => {
  const { window } = makeDom();
  window.document.body.innerHTML = '<div data-attrid="subtitle"><a role="button" href="/search?q=place+reviews">1,940 Google reviews</a></div>';
  let clicks = 0;
  window.document.querySelector('a').addEventListener('click', (e) => { clicks += 1; e.preventDefault(); });
  const loader = new GoogleReviewsLoader({ document: window.document, window, timing: TINY });
  await loader.open();
  assert.equal(clicks, 0);

  window.document.body.innerHTML = '<div data-attrid="subtitle"><a role="button" href="#">1,940 Google reviews</a></div>'; // desktop Search
  window.document.querySelector('a').addEventListener('click', (e) => { clicks += 1; e.preventDefault(); });
  await loader.open();
  assert.equal(clicks, 1, 'the overlay opener (a hash link) is still clicked');
});
