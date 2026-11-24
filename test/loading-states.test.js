import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Review } from '../src/domain/entities/Review.js';
import { RatingSummary } from '../src/domain/entities/RatingSummary.js';
import { RelativeTimeParser } from '../src/domain/services/RelativeTimeParser.js';
import { CalculateRecentRatingUseCase } from '../src/usecases/CalculateRecentRatingUseCase.js';
import { LoadReviewsUseCase } from '../src/usecases/LoadReviewsUseCase.js';
import { ReviewsModalPresenter } from '../src/adapters/presenters/ReviewsModalPresenter.js';
import { RatingBadgePresenter } from '../src/adapters/presenters/RatingBadgePresenter.js';
import { ReviewsModalRenderer } from '../src/frameworks/ui/ReviewsModalRenderer.js';
import { ReviewsModalController } from '../src/frameworks/content/ReviewsModalController.js';
import { ContentScriptController } from '../src/frameworks/content/ContentScriptController.js';
import { BackgroundLoadController } from '../src/frameworks/content/BackgroundLoadController.js';

const parser = new RelativeTimeParser();
let n = 0;
const review = (rating, raw) => new Review({ rating, rawTimestamp: raw, parsedAgeBucket: parser.parse(raw), id: `r${(n += 1)}` });

const PAGES = () => [
  [review(5, '2 days ago'), review(4, '5 days ago')],
  [review(3, '2 weeks ago'), review(5, 'a month ago')],
  [review(4, '2 months ago'), review(2, '4 months ago')],
  [review(5, '7 months ago'), review(1, '9 months ago')], // first ones outside 6 months
  [review(5, 'a year ago')],
];

/** A world where each loadMore() reveals one more page — like Google's lazy list. */
function world({ gate, pagesData } = {}) {
  let shown = 1;
  const calls = { open: 0, loadMore: 0, close: 0 };
  const reviewSource = {
    reset: () => {},
    readSnapshot: () => ({ reviews: PAGES().slice(0, shown).flat(), allTimeRating: 4.1, allTimeReviewCount: 300, placeName: 'Place' }),
  };
  // PAGES() builds new Review objects each call, so keep one copy for stable ids
  const pages = pagesData ?? PAGES();
  reviewSource.readSnapshot = () => ({ reviews: pages.slice(0, shown).flat(), allTimeRating: 4.1, allTimeReviewCount: pages.flat().length, placeName: 'Place' });
  const reviewLoader = {
    open: async () => { calls.open += 1; shown = 1; },
    isOpen: () => true,
    loadMore: async () => {
      calls.loadMore += 1;
      if (gate) await gate();
      if (shown >= pages.length) return false;
      shown += 1;
      return true;
    },
    close: async () => { calls.close += 1; },
  };
  return { calls, reviewSource, loadUseCase: new LoadReviewsUseCase({ reviewSource, reviewLoader }) };
}

function harness({ gate, initialWindow = '6_MONTHS', pagesData } = {}) {
  const w = world({ gate, pagesData });
  const vms = [];
  const states = [];
  const settings = { timeWindow: initialWindow };
  const modal = new ReviewsModalController({
    calculateUseCase: new CalculateRecentRatingUseCase({ reviewSource: w.reviewSource }),
    loadUseCase: w.loadUseCase,
    presenter: new ReviewsModalPresenter(),
    renderer: { render: (vm) => vms.push(vm), dispose() {} },
    getTimeWindow: () => settings.timeWindow,
    setTimeWindow: async (id) => { settings.timeWindow = id; },
    onLoadStateChange: (s) => states.push(s),
  });
  return { ...w, modal, vms, states, settings };
}

const numbersShown = (vm) => vm.headline.valueText !== '' || vm.headline.countText !== '' || vm.headline.deltaText !== null || vm.reviewIds.length > 0;

test('opening: every frame is a loading frame without numbers or reviews, then one finished frame', async () => {
  const h = harness();
  await h.modal.open();

  const loadingFrames = h.vms.slice(0, -1);
  assert.ok(loadingFrames.length >= 3, 'several progress updates happened while loading');
  for (const vm of loadingFrames) {
    assert.equal(vm.state, 'loading');
    assert.equal(numbersShown(vm), false, 'no rating, count, delta or review ids while loading');
  }
  const final = h.vms.at(-1);
  assert.equal(final.state, 'ready');
  assert.notEqual(final.headline.valueText, '');
  assert.ok(final.reviewIds.length > 0);
  assert.deepEqual(h.states, ['loading', 'idle']);
});

test('the rating only ever takes one value: the final one', async () => {
  const h = harness();
  await h.modal.open();
  const values = new Set(h.vms.map((vm) => vm.headline.valueText).filter((v) => v !== ''));
  assert.equal(values.size, 1, `saw ${[...values].join(', ')}`);
});

test('closing mid-load does not cancel it: the load finishes behind the scenes, the result is kept, and Google\'s page is put back once', async () => {
  const waiters = [];
  let open = false;
  const gate = () => (open ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)));
  const h = harness({ gate });
  const opening = h.modal.open();
  await new Promise((r) => setTimeout(r, 0)); // now waiting inside loadMore()
  const framesBeforeClose = h.vms.length;
  h.modal.close();
  assert.equal(h.modal.isOpen, false);
  assert.equal(h.modal.isBusy, true, 'still driving Google\'s list: nothing else may start');
  assert.equal(h.calls.close, 0, 'Google\'s page is not put back under a running load');

  open = true;
  waiters.forEach((resolve) => resolve());
  await opening;
  assert.deepEqual(h.states, ['loading', 'idle'], 'finished, not "incomplete"');
  assert.equal(h.modal.isBusy, false);
  assert.equal(h.calls.close, 1, 'put back once, after the load');
  assert.equal(h.vms.length, framesBeforeClose, 'nothing is rendered into the closed modal');
  assert.equal(h.loadUseCase.last?.reason, 'covered', 'the result is kept, so the badge can show it');
  assert.ok(h.loadUseCase.freshResult({ timeWindow: '6_MONTHS' }));
});

test('reopening the modal while its load is still running shows that load instead of starting a second one', async () => {
  const waiters = [];
  let open = false;
  const gate = () => (open ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)));
  const h = harness({ gate });
  const opening = h.modal.open();
  await new Promise((r) => setTimeout(r, 0));
  h.modal.close();
  await h.modal.open();
  assert.equal(h.modal.isOpen, true);
  assert.equal(h.vms.at(-1).state, 'loading', 'the skeleton, until the one load finishes');

  open = true;
  waiters.forEach((resolve) => resolve());
  await opening;
  assert.equal(h.calls.open, 1, 'one load only');
  assert.equal(h.vms.at(-1).state, 'ready');
  assert.equal(h.calls.close, 0, 'still open: Google\'s page stays until the modal is closed');
  assert.deepEqual(h.states, ['loading', 'idle']);
});

test('narrower window: answered instantly, no loading state; wider window: loads, then shows everything at once', async () => {
  const h = harness({ initialWindow: '1_MONTH' });
  await h.modal.open();
  assert.deepEqual(h.states, ['loading', 'idle']);
  const afterOpen = h.vms.length;

  await h.modal.changeWindow('1_WEEK');
  const narrower = h.vms.slice(afterOpen);
  assert.ok(narrower.length > 0 && narrower.every((vm) => vm.state === 'ready'), 'no skeleton flash');
  assert.deepEqual(h.states, ['loading', 'idle'], 'no new loading state announced');

  const beforeWider = h.vms.length;
  await h.modal.changeWindow('1_YEAR'); // needs "a year ago" from the last page
  const wider = h.vms.slice(beforeWider);
  assert.equal(wider.at(-1).state, 'ready');
  assert.ok(wider.slice(0, -1).length > 0, 'the wait showed a loading state');
  assert.ok(wider.slice(0, -1).every((vm) => vm.state === 'loading' && !numbersShown(vm)), 'the very first frame is already a skeleton: no number from too few reviews');
  assert.deepEqual(h.states.slice(2), ['loading', 'idle']);
});

test('a place with no more reviews to give: widening the window does not wait or flash a skeleton', async () => {
  // asking for a year of a place that has only two reviews: loading runs to the end ("exhausted")
  const h = harness({ initialWindow: '1_YEAR', pagesData: [[review(5, '2 days ago'), review(4, '3 weeks ago')]] });
  await h.modal.open();
  assert.deepEqual(h.states, ['loading', 'idle']);
  const loads = h.calls.loadMore;
  assert.ok(loads >= 1, 'it did try to find more');

  await h.modal.changeWindow('1_WEEK');
  const before = h.vms.length;
  await h.modal.changeWindow('1_YEAR'); // not covered, but nothing more exists: don't wait again
  assert.equal(h.calls.loadMore, loads, 'did not try to load what does not exist');
  assert.ok(h.vms.slice(before).every((vm) => vm.state === 'ready'));
  assert.deepEqual(h.states, ['loading', 'idle']);
});

// ----------------------------------------------------------------- the views

function summaryWith(matched, overrides = {}) {
  return new RatingSummary({
    recentAverage: 4.5, sampleCount: matched.length, totalScanned: 10, allTimeRating: 4.1, delta: 0.4,
    timeWindow: '6_MONTHS', timeWindowLabel: '~6 months', allTimeReviewCount: 300, placeName: 'Place', matchedReviews: matched, ...overrides,
  });
}

test('modal renderer: loading shows headline + list skeletons that persist (no restarting shimmer); results replace them', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const doc = window.document;
  const renderer = new ReviewsModalRenderer({
    window, document: doc,
    cloneCard: (id) => { const el = doc.createElement('div'); el.textContent = id; return el; },
    onWindowChange() {}, onClose() {},
  });
  const presenter = new ReviewsModalPresenter();
  const matched = [review(5, '1 day ago'), review(4, '2 days ago')];

  renderer.render(presenter.present(summaryWith(matched), { loading: true }));
  assert.ok(doc.querySelector('.rgr-score').classList.contains('rgr-score-loading'));
  // The real elements hold placeholder text of the final size (shimmering, glyphs hidden), never a real number.
  assert.equal(doc.querySelector('.rgr-score-value').textContent, '0.0', 'a placeholder, not 4.5');
  assert.equal(doc.querySelector('.rgr-score-count').textContent, '00 reviews');
  assert.equal(doc.querySelector('.rgr-score-delta').textContent, '−0.0 vs all-time');
  assert.equal(doc.querySelector('.rgr-score-stars').textContent, '★★★★★', 'the real stars, so the skeleton is exactly their size');
  assert.equal(doc.querySelector('.rgr-score').getAttribute('aria-hidden'), 'true');
  assert.ok(!doc.querySelector('.rgr-score').textContent.includes('4.5'), 'no real number anywhere');
  assert.equal(doc.querySelectorAll('article.rgr-review').length, 0, 'no review cards while loading');
  const skeleton = doc.querySelector('.rgr-review-skeleton');
  assert.ok(skeleton);

  renderer.render(presenter.present(summaryWith(matched), { loading: true })); // another progress tick
  assert.equal(doc.querySelector('.rgr-review-skeleton'), skeleton, 'same element: the shimmer is not restarted');

  renderer.render(presenter.present(summaryWith(matched)));
  assert.ok(!doc.querySelector('.rgr-score').classList.contains('rgr-score-loading'));
  assert.equal(doc.querySelector('.rgr-score-value').textContent, '4.5');
  assert.equal(doc.querySelector('.rgr-score').getAttribute('aria-hidden'), 'false');
  assert.equal(doc.querySelectorAll('article.rgr-review').length, 2);
  assert.equal(doc.querySelector('.rgr-review-skeleton'), null);
  renderer.dispose();
});

test('badge: pending means skeleton even when reviews are on the page', () => {
  const presenter = new RatingBadgePresenter();
  const summary = summaryWith([review(5, '1 day ago')]);
  const done = presenter.present(summary);
  assert.equal(done.state, 'ready');

  const pending = presenter.present(summary, { pending: true });
  assert.equal(pending.state, 'loading');
  assert.equal(pending.valueText, '');
  assert.equal(pending.deltaShort, null);
  assert.equal(pending.tone, 'muted');
  assert.equal(pending.tooltip.hint, 'Loading reviews…');
  assert.ok(pending.tooltip.notes[0].startsWith('Loading the reviews'));
});

test('page controller: the badge is pending only while a load runs; a failed load leaves nothing calculated', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const pendings = [];
  const summary = summaryWith([review(5, '1 day ago')]);
  const controller = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: { getSettings: async () => ({ searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS' }), subscribe: () => () => {} },
    calculateUseCase: { execute: () => summary, executeAll: ({ timeWindows }) => timeWindows.map(() => summary) },
    presenter: { present: (s, options) => { pendings.push(options?.pending ?? false); return {}; } },
    renderer: { render() {}, remove() {}, dispose() {} },
  });
  await controller.start();
  assert.equal(pendings.at(-1), false, 'idle: shows the result');

  controller.setLoadState('loading');
  assert.equal(pendings.at(-1), true);
  controller.setLoadState('idle');
  assert.equal(pendings.at(-1), false);
  controller.setLoadState('loading');
  controller.setLoadState('incomplete');
  assert.equal(pendings.at(-1), false, 'failed: not loading any more (the discarded set makes the badge idle, not stuck)');
  controller.stop();
});

// ------------------------------------------------- a result only comes from a finished load

test('use cases + source: reviews are "complete" only after a load finished (not for a cancelled one)', async () => {
  let complete = false;
  const reviewSource = {
    reset: () => { complete = false; },
    markComplete: () => { complete = true; },
    readSnapshot: () => ({ reviews: [review(5, '2 days ago'), review(4, '8 months ago')], allTimeRating: 4.1, allTimeReviewCount: 50, placeName: 'P', complete }),
  };
  const reviewLoader = { open: async () => {}, loadMore: async () => false, close: async () => {} };
  const calculate = new CalculateRecentRatingUseCase({ reviewSource });
  const load = new LoadReviewsUseCase({ reviewSource, reviewLoader });

  assert.equal(calculate.execute({ timeWindow: '6_MONTHS' }).complete, false, 'what the page showed on its own');

  await load.execute({ timeWindow: '6_MONTHS', isCancelled: () => true });
  assert.equal(calculate.execute({ timeWindow: '6_MONTHS' }).complete, false, 'cancelled mid-way: still not a result');

  await load.execute({ timeWindow: '6_MONTHS' });
  assert.equal(calculate.execute({ timeWindow: '6_MONTHS' }).complete, true);

  const bare = new CalculateRecentRatingUseCase({
    reviewSource: { readSnapshot: () => ({ reviews: [], allTimeRating: null, allTimeReviewCount: null }) },
  });
  assert.equal(bare.execute().complete, true, 'sources that do not track completeness are trusted');
});

// ------------------------------------------------------------- automatic calculation

/** A fake clock: the countdown never runs by itself, the test fires it. No real waiting anywhere. */
function fakeClockWindow() {
  const clock = { pending: null, scheduled: 0, delays: [] };
  return {
    clock,
    window: {
      setTimeout: (fn, ms) => { clock.pending = fn; clock.scheduled += 1; clock.delays.push(ms); return clock.scheduled; },
      clearTimeout: () => { clock.pending = null; },
    },
    fire: () => { const fn = clock.pending; clock.pending = null; fn?.(); },
  };
}

function autoWorld({ placeNames = ['Place'], placeKeys = null, nameHiddenWhileLoading = false } = {}) {
  const states = [];
  let place = 0;
  let complete = false;
  let gate = Promise.resolve();
  let cancelledSeen = false;
  let hidden = false;
  let tabHidden = false;
  let maxRoundsSeen = null;
  const loads = { execute: 0, release: 0, discard: 0 };
  const loadUseCase = {
    execute: async ({ isCancelled, maxRounds }) => {
      loads.execute += 1;
      maxRoundsSeen = maxRounds;
      await gate;
      hidden = nameHiddenWhileLoading; // e.g. Maps' Reviews tab has no readable place name
      if (isCancelled()) { cancelledSeen = true; return { reason: 'cancelled', rounds: 0 }; }
      complete = true;
      return { reason: 'covered', rounds: 1 };
    },
    release: async () => { loads.release += 1; },
    discard: () => { loads.discard += 1; complete = false; },
  };
  const readSummary = () => summaryWith([review(5, '1 day ago')], { placeName: hidden ? null : placeNames[place], placeKey: placeKeys ? placeKeys[place] : null, complete });
  const time = fakeClockWindow();
  const auto = new BackgroundLoadController({
    window: time.window,
    loadUseCase,
    readSummary,
    getTimeWindow: () => '6_MONTHS',
    isModalOpen: () => false,
    isPageHidden: () => tabHidden,
    onLoadStateChange: (state) => states.push(state),
  });
  return {
    auto, states, loads, readSummary, time,
    setTabHidden: (value) => { tabHidden = value; },
    setGate: (g) => { gate = g; },
    cancelledSeen: () => cancelledSeen,
    maxRounds: () => maxRoundsSeen,
    nextPlace: () => { place += 1; complete = false; },
    movePlaceDuringLoad: () => { place += 1; },
  };
}

test('background calculation: starts by itself once a badge has settled, loads once, and puts Google back', async () => {
  const w = autoWorld();
  assert.equal(w.auto.expects(w.readSummary()), true, 'skeleton while it is about to run');
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.auto.consider(w.readSummary(), { badgeShown: true }); // repeated updates must not start a second countdown
  assert.equal(w.time.clock.scheduled, 1);
  w.time.fire();
  await w.auto.running;
  assert.deepEqual(w.states, ['loading', 'idle']);
  assert.deepEqual(w.loads, { execute: 1, release: 1, discard: 0 });
  assert.equal(w.auto.expects(w.readSummary()), false, 'complete: nothing more to do');
  w.auto.consider(w.readSummary(), { badgeShown: true });
  assert.equal(w.time.clock.pending, null, 'never again for a finished place');
});

test('background calculation: starts with no delay of its own (the loader waits for Google\'s link); a background tab is looked at again slowly', async () => {
  const w = autoWorld();
  w.auto.consider(w.readSummary(), { badgeShown: true });
  assert.deepEqual(w.time.clock.delays, [0], 'no fixed wait before starting');

  w.setTabHidden(true);
  w.time.fire(); // the countdown ends, but the tab is in the background
  assert.equal(w.loads.execute, 0, 'nothing is driven in a throttled tab');
  assert.deepEqual(w.time.clock.delays, [0, 2000], 'and it does not spin: it looks again every couple of seconds');

  w.setTabHidden(false);
  w.time.fire();
  await w.auto.running;
  assert.equal(w.loads.execute, 1);
  assert.deepEqual(w.states, ['loading', 'idle']);
});

test('background calculation: no badge, no run', async () => {
  const none = autoWorld();
  none.auto.consider(none.readSummary(), { badgeShown: false });
  assert.equal(none.time.clock.pending, null, 'no countdown without a badge');
});

test('background calculation: stop() hands over to the modal, waits for the run to unwind, and does not start again', async () => {
  const w = autoWorld();
  let release;
  w.setGate(new Promise((resolve) => { release = resolve; }));
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.time.fire(); // running, blocked on the gate
  assert.equal(w.auto.expects(w.readSummary()), true, 'running counts as expected');
  const stopped = w.auto.stop();
  release();
  await stopped;
  assert.equal(w.cancelledSeen(), true);
  assert.deepEqual(w.states, ['loading'], 'the modal reports the state from here on, not the background run');
  assert.equal(w.loads.release, 1);
  w.auto.consider(w.readSummary(), { badgeShown: true });
  assert.equal(w.time.clock.pending, null, 'the user took over: no automatic retry');
});

test('background calculation: a new place gets its own attempt', async () => {
  const w = autoWorld({ placeNames: ['A', 'B'] });
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.time.fire();
  await w.auto.running;
  assert.equal(w.loads.execute, 1);
  w.nextPlace();
  assert.equal(w.auto.expects(w.readSummary()), true);
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.time.fire();
  await w.auto.running;
  assert.equal(w.loads.execute, 2);
});

test('LoadReviews: freshResult() lets a view skip loading when a finished load already covers the window', async () => {
  const w = world();
  assert.equal(w.loadUseCase.freshResult({ timeWindow: '6_MONTHS' }), null, 'nothing loaded yet');
  await w.loadUseCase.execute({ timeWindow: '6_MONTHS' });
  assert.equal(w.loadUseCase.freshResult({ timeWindow: '6_MONTHS' })?.reason, 'covered');
  w.loadUseCase.discard();
  assert.equal(w.loadUseCase.freshResult({ timeWindow: '6_MONTHS' }), null, 'abandoned: not a result');
});

test('ReviewsModalController: opens instantly when the background calculation already finished; otherwise stops it first, then loads', async () => {
  const build = (fresh) => {
    const log = [];
    const vms = [];
    const modal = new ReviewsModalController({
      calculateUseCase: { execute: () => summaryWith([review(5, '1 day ago')]) },
      loadUseCase: {
        freshResult: () => fresh,
        execute: async () => { log.push('execute'); return { reason: 'covered', rounds: 1 }; },
        extend: async () => ({ reason: 'covered', rounds: 0 }),
        release: async () => {},
        discard() { log.push('discard'); },
      },
      presenter: new ReviewsModalPresenter(),
      renderer: { render: (vm) => vms.push(vm.state), dispose() {} },
      getTimeWindow: () => '6_MONTHS',
      setTimeWindow: async () => {},
      onLoadStateChange: (s) => log.push(`state:${s}`),
      stopBackground: async () => { log.push('stopBackground'); },
    });
    return { modal, log, vms };
  };

  const instant = build({ reason: 'covered', rounds: 2 });
  await instant.modal.open();
  assert.deepEqual(instant.log, [], 'no loading, no state changes, Google untouched');
  assert.deepEqual(instant.vms, ['ready'], 'the first paint is already the result');

  const slow = build(null);
  await slow.modal.open();
  assert.deepEqual(slow.log, ['state:loading', 'stopBackground', 'execute', 'state:idle']);
  assert.equal(slow.vms[0], 'loading');
  assert.equal(slow.vms.at(-1), 'ready');

  const capped = build({ reason: 'max-rounds', rounds: 12 });
  await capped.modal.open();
  assert.equal(capped.modal.partial, true, 'a capped background run still offers "Load more reviews"');
});

test('background calculation: a missing place name (Maps\' Reviews tab) is not "another place", but a different name is', async () => {
  const hiddenName = autoWorld({ nameHiddenWhileLoading: true });
  hiddenName.auto.consider(hiddenName.readSummary(), { badgeShown: true });
  hiddenName.time.fire();
  await hiddenName.auto.running;
  assert.equal(hiddenName.cancelledSeen(), false, 'the run carried on');
  assert.deepEqual(hiddenName.states, ['loading', 'idle']);

  const moved = autoWorld({ placeNames: ['A', 'B'] });
  let release;
  moved.setGate(new Promise((resolve) => { release = resolve; }));
  moved.auto.consider(moved.readSummary(), { badgeShown: true });
  moved.time.fire();
  moved.movePlaceDuringLoad();
  release();
  await moved.auto.running;
  assert.equal(moved.cancelledSeen(), true, 'the SPA went to a different place: stop');
});

test('background calculation: a branch with the same name but another place key is another place (no skip, cancel mid-load)', async () => {
  const w = autoWorld({ placeNames: ['Starbucks', 'Starbucks'], placeKeys: ['0xA', '0xB'] });
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.time.fire();
  await w.auto.running;
  assert.equal(w.loads.execute, 1);
  w.nextPlace();
  assert.equal(w.auto.expects(w.readSummary()), true, 'the other branch has not been tried: it will be calculated too');

  const moved = autoWorld({ placeNames: ['Starbucks', 'Starbucks'], placeKeys: ['0xA', '0xB'] });
  let release;
  moved.setGate(new Promise((resolve) => { release = resolve; }));
  moved.auto.consider(moved.readSummary(), { badgeShown: true });
  moved.time.fire();
  moved.movePlaceDuringLoad();
  release();
  await moved.auto.running;
  assert.equal(moved.cancelledSeen(), true, 'same name, different place key: stop');
});

test('ReviewsModalController: loads as far back as the strip needs (getLoadWindow), not just the shown window', async () => {
  const seen = [];
  const modal = new ReviewsModalController({
    calculateUseCase: { execute: () => summaryWith([review(5, '1 day ago')]) },
    loadUseCase: {
      freshResult: ({ timeWindow }) => { seen.push(`fresh:${timeWindow}`); return null; },
      execute: async ({ timeWindow }) => { seen.push(`load:${typeof timeWindow === 'function' ? timeWindow() : timeWindow}`); return { reason: 'covered', rounds: 0 }; },
      extend: async () => ({ reason: 'covered', rounds: 0 }),
      release: async () => {},
      discard() {},
    },
    presenter: new ReviewsModalPresenter(),
    renderer: { render() {}, dispose() {} },
    getTimeWindow: () => '1_WEEK', // what the modal shows
    getLoadWindow: () => '6_MONTHS', // what the strip's cells need
    setTimeWindow: async () => {},
  });
  await modal.open();
  assert.deepEqual(seen, ['fresh:6_MONTHS', 'load:6_MONTHS'], 'the 3M and 6M cells are filled even when the selected window is a week');
});

test('background calculation: waits while the tab is in the background, then runs once it is visible', async () => {
  const states = [];
  let hidden = true;
  let executed = 0;
  const time = fakeClockWindow();
  const loadUseCase = {
    execute: async () => { executed += 1; return { reason: 'covered', rounds: 1 }; },
    release: async () => {},
    discard() {},
  };
  const auto = new BackgroundLoadController({
    window: time.window,
    loadUseCase,
    readSummary: () => summaryWith([review(5, '1 day ago')], { complete: false }),
    getTimeWindow: () => '6_MONTHS',
    isModalOpen: () => false,
    isPageHidden: () => hidden,
    onLoadStateChange: (s) => states.push(s),
  });
  auto.consider(summaryWith([review(5, '1 day ago')], { complete: false }), { badgeShown: true });
  time.fire();
  assert.equal(executed, 0, 'hidden tab: nothing is driven');
  assert.equal(auto.running, null);
  assert.ok(time.clock.pending, 'it will look again shortly');
  assert.equal(auto.attemptedKey, null, 'waiting is not an attempt');

  hidden = false;
  time.fire();
  await auto.running;
  assert.equal(executed, 1, 'visible now: it ran');
  assert.deepEqual(states, ['loading', 'idle']);
});

test('ReviewsModalController: a stalled load leaves the partial list with "Load more reviews", not a finished result', async () => {
  const vms = [];
  const modal = new ReviewsModalController({
    calculateUseCase: { execute: () => summaryWith([review(5, '1 day ago')]) },
    loadUseCase: { freshResult: () => null, execute: async () => ({ reason: 'stalled', rounds: 0 }), extend: async () => ({ reason: 'covered', rounds: 0 }), release: async () => {}, discard() {} },
    presenter: new ReviewsModalPresenter(),
    renderer: { render: (vm) => vms.push(vm), dispose() {} },
    getTimeWindow: () => '6_MONTHS',
    setTimeWindow: async () => {},
  });
  await modal.open();
  assert.equal(vms.at(-1).canLoadMore, true);
  assert.match(vms.at(-1).statusText, /stopped early/);
});

test('page controller: on an unsupported layout it shows the note and never starts the background load', async () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const calls = { present: [], consider: 0 };
  const summary = summaryWith([review(5, '1 day ago')]);
  const controller = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: { getSettings: async () => ({ searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS' }), subscribe: () => () => {} },
    calculateUseCase: { execute: () => summary, executeAll: ({ timeWindows }) => timeWindows.map(() => summary) },
    presenter: { present: (s, options) => { calls.present.push(options.unsupported); return {}; } },
    renderer: { render() {}, remove() {}, dispose() {} },
    autoLoad: { expects: () => true, consider: () => { calls.consider += 1; }, dispose() {} },
    isSupported: () => false,
  });
  await controller.start();
  assert.deepEqual(calls.present, [true]);
  assert.equal(calls.consider, 0, 'driving Google\'s page on a layout we cannot read would only navigate the user away');
  controller.stop();
});

test('background calculation: reads further back than the modal\'s default, so a busy place is not cut at ~120 reviews', async () => {
  const w = autoWorld();
  w.auto.consider(w.readSummary(), { badgeShown: true });
  w.time.fire();
  await w.auto.running;
  assert.ok(w.maxRounds() > 12, `asked for ${w.maxRounds()} rounds`);
});
