import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { RatingSummary } from '../src/domain/entities/RatingSummary.js';
import { RatingBadgePresenter } from '../src/adapters/presenters/RatingBadgePresenter.js';
import { LoadingNoticePresenter } from '../src/adapters/presenters/LoadingNoticePresenter.js';
import { LoadingNoticeRenderer } from '../src/frameworks/ui/LoadingNoticeRenderer.js';
import { ContentScriptController } from '../src/frameworks/content/ContentScriptController.js';
import { ReviewsModalController } from '../src/frameworks/content/ReviewsModalController.js';

const vm = new LoadingNoticePresenter().present();

function makeRenderer({ url = 'https://www.google.com/search?q=krasi', dark = false } = {}) {
  const { window } = new JSDOM('<!doctype html><body><input id="q"></body>', { url });
  window.matchMedia = () => ({ matches: dark });
  const renderer = new LoadingNoticeRenderer({ window, document: window.document });
  return { window, doc: window.document, renderer };
}

// -------------------------------------------------------------------- presenter

test('presenter: says the page is paused for a few seconds and gives both reasons (no free API, bot detection)', () => {
  assert.match(vm.lead, /few seconds/i);
  assert.equal(vm.reasons.length, 2);
  assert.match(vm.reasons[0], /subscription/i, 'why not use the APIs: it would cost the user a subscription');
  assert.match(vm.reasons[1], /bot/i, 'why it scrolls the page: to not look like automation to Google');
  assert.ok(vm.title && vm.footnote);
});

// --------------------------------------------------------------------- renderer

test('renderer: an accessible dialog with the explanation; rendering again leaves the same nodes alone', () => {
  const { doc, renderer } = makeRenderer();
  renderer.render(vm);
  const root = doc.querySelector('[data-rgr-notice]');
  const panel = root.querySelector('[role="alertdialog"]');
  assert.ok(panel, 'announced as an alert dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(doc.getElementById(panel.getAttribute('aria-labelledby')).textContent, vm.title);
  assert.equal(doc.getElementById(panel.getAttribute('aria-describedby')).textContent, vm.lead);
  for (const reason of vm.reasons) assert.ok(root.textContent.includes(reason));
  assert.equal(root.querySelector('button, a, input, select, [tabindex="0"]'), null, 'nothing to operate: it cannot be dismissed');
  assert.equal(doc.activeElement, panel, 'focus moves to the dialog itself, so it is announced');

  renderer.render(vm); // called on every page update
  assert.equal(doc.querySelectorAll('[data-rgr-notice]').length, 1);
  assert.equal(doc.querySelector('[data-rgr-notice]'), root);
  renderer.dispose();
});

test('renderer: never a [role="dialog"], which the loader would mistake for Google\'s own dialog (and the loading stylesheet hides)', () => {
  const { doc, renderer } = makeRenderer();
  renderer.render(vm);
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  renderer.dispose();
});

test('renderer: every module that scans for "our own UI" knows the notice', () => {
  for (const file of [
    'src/frameworks/content/ContentScriptController.js',
    'src/adapters/dao/GoogleReviewsLoader.js',
    'src/adapters/dao/GoogleDomReviewDao.js',
  ]) {
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /\[data-rgr-notice\]/, file);
  }
});

test('renderer: clicks on it never reach the page (Google closes its dialog on an "outside" click) and do not close it', () => {
  const { window, doc, renderer } = makeRenderer();
  const reached = [];
  doc.addEventListener('click', () => reached.push('click'));
  doc.addEventListener('mousedown', () => reached.push('mousedown'));
  renderer.render(vm);

  doc.querySelector('.rgr-notice-panel').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  doc.querySelector('.rgr-notice').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // the scrim
  assert.deepEqual(reached, [], 'shielded');
  assert.equal(renderer.isShown, true, 'a click on the scrim does not dismiss it');

  doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(reached, ['click'], 'clicks outside the notice are not touched');
  renderer.dispose();
});

test('renderer: Escape is kept from Google and does not close it; our own synthetic Escape passes through; Tab goes nowhere', () => {
  const { window, doc, renderer } = makeRenderer();
  const seen = [];
  doc.body.addEventListener('keydown', (event) => seen.push(event.key));
  renderer.render(vm);

  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  doc.body.dispatchEvent(escape);
  assert.deepEqual(seen, [], 'Google never sees it (it would close its hidden dialog and break the load)');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(renderer.isShown, true, 'and it does not dismiss the notice');

  const synthetic = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  synthetic.rgrSynthetic = true; // sent by the loader when it puts Google's page back
  doc.body.dispatchEvent(synthetic);
  assert.deepEqual(seen, ['Escape'], 'it reaches the page');

  doc.getElementById('q').focus();
  const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  doc.body.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc.activeElement, doc.querySelector('.rgr-notice-panel'), 'focus stays on the notice, off the page behind it');
  renderer.dispose();
});

test('renderer: dispose removes it, stops listening and gives focus back', () => {
  const { window, doc, renderer } = makeRenderer();
  const input = doc.getElementById('q');
  input.focus();
  renderer.render(vm);
  renderer.dispose();
  assert.equal(doc.querySelector('[data-rgr-notice]'), null);
  assert.equal(renderer.isShown, false);
  assert.equal(doc.activeElement, input);

  const seen = [];
  doc.body.addEventListener('keydown', (event) => seen.push(event.key));
  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(seen, ['Escape'], 'no listener left behind: the page gets its keys again');
  renderer.dispose(); // harmless twice
});

test('renderer: follows the system theme on Search and is always light on Maps', () => {
  const search = makeRenderer({ dark: true });
  search.renderer.render(vm);
  assert.equal(search.doc.querySelector('.rgr-notice').dataset.rgrTheme, 'dark');
  search.renderer.dispose();

  const maps = makeRenderer({ url: 'https://www.google.com/maps/place/Krasi', dark: true });
  maps.renderer.render(vm);
  assert.equal(maps.doc.querySelector('.rgr-notice').dataset.rgrTheme, 'light');
  maps.renderer.dispose();
});

// ------------------------------------------------------------------- controller

const SUMMARY = new RatingSummary({
  recentAverage: 4.5, sampleCount: 1, totalScanned: 10, allTimeRating: 4.1, delta: 0.4,
  timeWindow: '6_MONTHS', timeWindowLabel: '~6 months', allTimeReviewCount: 300, placeName: 'Place', matchedReviews: [],
});

const NOTICE_TIMEOUT = 4321; // distinctive, so the harness can tell the notice's timer from the page's own

const UNCALCULATED = new RatingSummary({
  recentAverage: null, sampleCount: 0, totalScanned: 3, allTimeRating: 4.1, delta: null,
  timeWindow: '6_MONTHS', timeWindowLabel: '~6 months', allTimeReviewCount: 300, placeName: 'Place', matchedReviews: [], complete: false,
});

/**
 * The real badge presenter decides "calculating" (the notice follows it). `badge: false` is a page with no place on it;
 * `autoLoad` stands in for the background controller's countdown, which has not started the load yet.
 */
async function pageHarness({ isEnabled = true, supported = true, modal = null, badge = true, autoLoad = null, summary = SUMMARY } = {}) {
  const { window } = new JSDOM('<!doctype html><body></body>');
  // A fake clock for the notice's timeout only: the test fires it, nothing waits. (The page's own debounce timers keep real time.)
  const noticeTimers = [];
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms) => {
    if (ms !== NOTICE_TIMEOUT) return realSetTimeout(fn, ms);
    const timer = { fn, cleared: false };
    noticeTimers.push(timer);
    return timer;
  };
  window.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
    else realClearTimeout(handle);
  };
  if (badge) {
    const root = window.document.createElement('div');
    root.setAttribute('data-rgr-root', '');
    window.document.body.append(root);
  }
  const calls = [];
  const notice = {
    presenter: { present: () => vm },
    renderer: { render: () => calls.push('show'), dispose: () => calls.push('hide') },
  };
  const controller = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: { getSettings: async () => ({ searchEnabled: isEnabled, mapsEnabled: isEnabled, timeWindow: '6_MONTHS' }), subscribe: () => () => {} },
    calculateUseCase: { execute: () => summary, executeAll: ({ timeWindows }) => timeWindows.map(() => summary) },
    presenter: new RatingBadgePresenter(),
    renderer: { render() {}, remove() {}, dispose() {} },
    notice,
    autoLoad,
    noticeTimeoutMs: NOTICE_TIMEOUT,
    isSupported: () => supported,
    modal,
  });
  await controller.start();
  const lastCall = () => calls.at(-1);
  const expire = () => noticeTimers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); });
  return { controller, calls, lastCall, noticeTimers, expire };
}

test('page controller: the notice is up exactly while the badge is calculating, however the load was started', async () => {
  const { controller, calls, lastCall } = await pageHarness();
  assert.deepEqual(calls, ['hide'], 'nothing calculating: nothing drawn');

  controller.setLoadState('loading');
  assert.equal(lastCall(), 'show');
  controller.setLoadState('idle');
  assert.equal(lastCall(), 'hide');

  controller.setLoadState('loading');
  controller.setLoadState('incomplete');
  assert.equal(lastCall(), 'hide', 'a failed load also ends it: no notice stuck on the page');
  controller.stop();
});

test('page controller: up as soon as the calculation is expected, before the background load has reached the Google page', async () => {
  const auto = { expectsNow: true, expects() { return this.expectsNow; }, consider() {}, dispose() {} };
  const { controller, calls, lastCall } = await pageHarness({ autoLoad: auto, summary: UNCALCULATED });
  assert.equal(calls[0], 'show', 'the first paint of the badge skeleton already explains itself');
  assert.equal(controller.loadState, 'idle', 'no load has begun');

  auto.expectsNow = false; // tried and gave up: the badge becomes a click-to-calculate pill, nothing is paused
  controller.update();
  assert.equal(lastCall(), 'hide');
  controller.stop();
});

test('page controller: the notice cannot be dismissed; it closes by itself after the timeout, for that calculation only', async () => {
  const { controller, lastCall, expire } = await pageHarness();
  assert.equal(controller.dismissNotice, undefined, 'no way to dismiss it from outside');
  controller.setLoadState('loading');
  assert.equal(lastCall(), 'show');

  controller.update(); // the page changes while the load goes on
  assert.equal(lastCall(), 'show', 'still up');

  expire(); // the timeout backstop
  assert.equal(lastCall(), 'hide');
  controller.update();
  assert.equal(lastCall(), 'hide', 'and it does not come back for the same calculation');

  controller.setLoadState('idle');
  controller.setLoadState('loading');
  assert.equal(lastCall(), 'show', 'the next calculation explains itself again');
  controller.stop();
});

test('page controller: the timeout starts once per calculation and is cancelled when the calculation ends first', async () => {
  const { controller, noticeTimers, lastCall, expire } = await pageHarness();
  controller.setLoadState('loading');
  controller.update();
  controller.update();
  assert.equal(noticeTimers.length, 1, 'repeated page updates do not restart the clock');

  controller.setLoadState('idle'); // finished before the timeout
  assert.equal(noticeTimers[0].cleared, true);
  assert.equal(lastCall(), 'hide');
  expire(); // a stale timer must never fire
  controller.setLoadState('loading');
  assert.equal(noticeTimers.length, 2, 'a fresh clock for the next calculation');
  assert.equal(lastCall(), 'show');
  controller.stop();
  assert.equal(noticeTimers[1].cleared, true, 'stop() clears it too');
});

test('page controller: steps aside while the reviews modal is open, and returns if the modal is closed mid-load', async () => {
  const modal = { isOpen: false, refresh() {}, close() {} };
  const { controller, lastCall } = await pageHarness({ modal });
  controller.setLoadState('loading');
  assert.equal(lastCall(), 'show');

  modal.isOpen = true;
  controller.syncNotice();
  assert.equal(lastCall(), 'hide', 'the modal has its own skeleton');

  modal.isOpen = false; // closed while the load runs on in the background
  controller.syncNotice();
  assert.equal(lastCall(), 'show');
  controller.stop();
});

test('page controller: no notice on a layout we do not load on, with the extension off, or on a page with no badge', async () => {
  for (const options of [{ supported: false }, { isEnabled: false }, { badge: false }]) {
    const { controller, calls } = await pageHarness(options);
    controller.setLoadState('loading');
    assert.ok(!calls.includes('show'), JSON.stringify(options));
    controller.stop();
  }
});

test('page controller: stop() takes the notice down; one without a notice configured just works', async () => {
  const { controller, lastCall } = await pageHarness();
  controller.setLoadState('loading');
  controller.stop();
  assert.equal(lastCall(), 'hide');

  const { window } = new JSDOM('<!doctype html><body></body>');
  const bare = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: { getSettings: async () => ({ searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS' }), subscribe: () => () => {} },
    calculateUseCase: { execute: () => SUMMARY, executeAll: ({ timeWindows }) => timeWindows.map(() => SUMMARY) },
    presenter: { present: () => ({}) },
    renderer: { render() {}, remove() {}, dispose() {} },
  });
  await bare.start();
  bare.setLoadState('loading');
  bare.stop();
});

// ------------------------------------------------------------- modal reports visibility

test('modal controller: tells the page when it opens and closes, including closing mid-load (the page is then paused again)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  let modal;
  modal = new ReviewsModalController({
    calculateUseCase: { execute: () => SUMMARY },
    loadUseCase: {
      freshResult: () => null,
      execute: async () => { await gate; return { reason: 'covered', rounds: 0 }; },
      release: async () => {},
      discard() {},
      needsMore: () => false,
    },
    presenter: { present: () => ({}) },
    renderer: { render() {}, dispose() {} },
    getTimeWindow: () => '6_MONTHS',
    setTimeWindow: async () => {},
    onVisibilityChange: () => seen.push({ isOpen: modal.isOpen, isBusy: modal.isBusy }),
  });

  const opening = modal.open();
  modal.close(); // mid-load
  assert.deepEqual(seen, [{ isOpen: true, isBusy: true }, { isOpen: false, isBusy: true }]);

  release();
  await opening;
  await modal.open();
  modal.close();
  assert.deepEqual(seen.slice(2), [{ isOpen: true, isBusy: true }, { isOpen: false, isBusy: false }]);
});
