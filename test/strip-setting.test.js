import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { RatingSummary } from '../src/domain/entities/RatingSummary.js';
import { ContentScriptController } from '../src/frameworks/content/ContentScriptController.js';

const summary = (timeWindow) =>
  new RatingSummary({
    recentAverage: 4.5, sampleCount: 9, totalScanned: 40, allTimeRating: 4.1, delta: 0.4,
    timeWindow, timeWindowLabel: timeWindow, allTimeReviewCount: 300, placeName: 'Place', matchedReviews: [],
  });

/** A page whose settings can change under it, recording which windows it asked for and handed to the badge. */
async function page(initial) {
  const { window } = new JSDOM('<!doctype html><body></body>');
  let settings = { searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS', maxMonths: 6, ...initial };
  let notify = () => {};
  const asked = [];
  const shown = [];
  const controller = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: {
      getSettings: async () => settings,
      subscribe: (callback) => { notify = () => callback(settings); return () => {}; },
    },
    calculateUseCase: {
      execute: ({ timeWindow }) => summary(timeWindow),
      executeAll: ({ timeWindows }) => { asked.push(timeWindows); return timeWindows.map(summary); },
    },
    presenter: { present: (selected, options) => { shown.push(options.windows.map((w) => w.timeWindow)); return {}; } },
    renderer: { render() {}, remove() {}, dispose() {} },
  });
  await controller.start();
  return {
    controller, asked, shown,
    change: (next) => { settings = { ...settings, ...next }; notify(); },
  };
}

test('page: the badge strip follows the saved longest window', async () => {
  const p = await page({ maxMonths: 4 });
  assert.deepEqual(p.shown.at(-1), ['1_MONTH', '2_MONTHS', '4_MONTHS']);
  p.controller.stop();

  const week = await page({ maxMonths: 2 });
  assert.deepEqual(week.shown.at(-1), ['1_WEEK', '1_MONTH', '2_MONTHS']);
  week.controller.stop();
});

test('page: one read of the reviews answers the selected window and the strip, whatever the longest window is', async () => {
  const p = await page({ maxMonths: 9, timeWindow: '3_MONTHS' });
  assert.deepEqual(p.asked.at(-1), ['3_MONTHS', '1_MONTH', '5_MONTHS', '9_MONTHS']);
  p.controller.stop();
});

test('page: changing the setting in the popup redraws the strip at once, without reloading the page', async () => {
  const p = await page({ maxMonths: 6 });
  assert.deepEqual(p.shown.at(-1), ['1_MONTH', '3_MONTHS', '6_MONTHS']);
  p.change({ maxMonths: 11 });
  await new Promise((resolve) => setTimeout(resolve, 20)); // the page update is scheduled, not synchronous
  assert.deepEqual(p.shown.at(-1), ['1_MONTH', '6_MONTHS', '11_MONTHS']);
  p.controller.stop();
});

// ---- one setting per kind of page

async function surfaceHarness(url, settings) {
  const { window } = new JSDOM('<!doctype html><body><div data-rgr-root></div></body>', { url });
  const calls = { render: 0, remove: 0 };
  let current = { timeWindow: '6_MONTHS', maxMonths: 6, ...settings };
  let notify = () => {};
  const controller = new ContentScriptController({
    window, document: window.document,
    settingsUseCase: { getSettings: async () => current, subscribe: (cb) => { notify = () => cb(current); return () => {}; } },
    calculateUseCase: { execute: ({ timeWindow }) => summary(timeWindow), executeAll: ({ timeWindows }) => timeWindows.map(summary) },
    presenter: { present: () => ({}) },
    renderer: { render: () => { calls.render += 1; }, remove: () => { calls.remove += 1; }, dispose() {} },
  });
  await controller.start();
  return { controller, calls, change: (next) => { current = { ...current, ...next }; notify(); } };
}

test('page: the Search setting governs Google Search and the Maps setting governs Google Maps', async () => {
  const cases = [
    ['https://www.google.com/search?q=krasi', { searchEnabled: true, mapsEnabled: false }, true],
    ['https://www.google.com/search?q=krasi', { searchEnabled: false, mapsEnabled: true }, false],
    ['https://www.google.com/maps/place/Krasi', { searchEnabled: false, mapsEnabled: true }, true],
    ['https://www.google.com/maps/place/Krasi', { searchEnabled: true, mapsEnabled: false }, false],
    ['https://maps.google.com/?q=krasi', { searchEnabled: true, mapsEnabled: false }, false],
    ['https://www.google.com/', { searchEnabled: true, mapsEnabled: false }, true],
  ];
  for (const [url, settings, shown] of cases) {
    const h = await surfaceHarness(url, settings);
    assert.equal(h.calls.render > 0, shown, `${url} with ${JSON.stringify(settings)}`);
    assert.equal(h.calls.remove > 0, !shown, `${url}: taken down when off`);
    h.controller.stop();
  }
});

test('page: switching the setting for the page you are on takes the badge down at once, and the other one changes nothing', async () => {
  const h = await surfaceHarness('https://www.google.com/maps/place/Krasi', { searchEnabled: true, mapsEnabled: true });
  assert.ok(h.calls.render > 0);

  const rendered = h.calls.render;
  h.change({ searchEnabled: false }); // not the page we are on
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls.remove, 0, 'Maps page ignores the Search switch');
  assert.ok(h.calls.render > rendered);

  h.change({ mapsEnabled: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(h.calls.remove > 0, 'the Maps switch takes it down');
  h.controller.stop();
});
