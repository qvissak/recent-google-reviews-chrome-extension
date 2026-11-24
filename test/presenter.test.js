import test from 'node:test';
import assert from 'node:assert/strict';
import { RatingSummary } from '../src/domain/entities/RatingSummary.js';
import { RatingBadgePresenter, overallTrend } from '../src/adapters/presenters/RatingBadgePresenter.js';

const presenter = new RatingBadgePresenter();
const base = {
  recentAverage: 4.3,
  sampleCount: 24,
  totalScanned: 31,
  allTimeRating: 4.1,
  delta: 0.2,
  timeWindow: '6_MONTHS',
  timeWindowLabel: '~6 months',
  unparsedCount: 0,
  allTimeReviewCount: 2123,
};

test('ready state formats badge, delta and tooltip', () => {
  const vm = presenter.present(new RatingSummary(base));
  assert.equal(vm.badgeText, '4.3 ★ (~6m, n=24)');
  assert.equal(vm.deltaShort, '+0.2');
  assert.equal(vm.tone, 'positive');
  assert.equal(vm.state, 'ready');
  const rows = Object.fromEntries(vm.tooltip.rows.map((r) => [r.label, r.value]));
  assert.equal(rows['~6 months'], '4.3 ★ · n=24 · +0.2');
  assert.equal(rows['Loaded on this page'], '31 reviews');
  assert.equal(rows['All-time rating'], '4.1 ★');
  assert.equal(rows['All-time reviews'], '2,123');
  assert.ok(vm.tooltip.notes.some((n) => /newest first/i.test(n)), 'sample-size hint present');
  assert.equal(vm.tooltip.hint, 'Click to see the reviews behind these numbers.');
});

test('negative delta uses a true minus sign', () => {
  const vm = presenter.present(new RatingSummary({ ...base, delta: -0.3, recentAverage: 3.8 }));
  assert.equal(vm.deltaShort, '−0.3');
  assert.equal(vm.tone, 'negative');
});

test('no reviews on the page yet -> loading state (skeleton), never "n=0"', () => {
  const vm = presenter.present(
    new RatingSummary({ ...base, recentAverage: null, sampleCount: 0, delta: null, totalScanned: 0 }),
  );
  assert.equal(vm.state, 'loading');
  assert.equal(vm.badgeText, 'Calculating recent rating…');
  assert.equal(vm.valueText, '');
  assert.equal(vm.metaText, '');
  assert.ok(!vm.badgeText.includes('n=0'));
  assert.equal(vm.deltaShort, null);
  assert.equal(vm.tone, 'muted');
  assert.equal(vm.tooltip.title, 'Calculating recent rating…');
  assert.ok(vm.tooltip.notes[0].includes('automatically'));
  assert.equal(vm.tooltip.hint, 'Click to load the reviews and calculate.');
  assert.ok(vm.ariaLabel.startsWith('Calculating recent rating'));
});

test('reviews loaded but none recent: n=0 of N', () => {
  const vm = presenter.present(
    new RatingSummary({ ...base, recentAverage: null, sampleCount: 0, delta: null, totalScanned: 10 }),
  );
  assert.equal(vm.state, 'empty');
  assert.equal(vm.badgeText, '\u2013 \u2605 (~6m, n=0 of 10)');
  assert.ok(vm.tooltip.notes[0].includes('None of the 10 loaded reviews'));
});

test('eleven-month window label (a stored 1_YEAR is the same window), small sample, unparsed dates', () => {
  const vm = presenter.present(
    new RatingSummary({
      ...base,
      timeWindow: '1_YEAR',
      timeWindowLabel: '< 1 year',
      sampleCount: 2,
      unparsedCount: 3,
      allTimeRating: null,
      delta: null,
    }),
  );
  assert.match(vm.badgeText, /\(11m, n=2\)/);
  assert.ok(vm.tooltip.notes.some((n) => /Small sample/.test(n)));
  assert.ok(vm.tooltip.notes.some((n) => /3 reviews skipped/.test(n)));
  assert.equal(vm.tooltip.rows.find((r) => r.label === 'All-time rating').value, 'not found on page');
});

test('a handful of reviews that are not a finished load (e.g. Maps\' Overview snippets) never produce a number', () => {
  const vm = presenter.present(
    new RatingSummary({ ...base, recentAverage: 4.5, sampleCount: 2, totalScanned: 3, delta: 0.4, complete: false }),
  );
  assert.equal(vm.state, 'loading', 'skeleton, not 4.5 (n=2)');
  assert.equal(vm.valueText, '');
  assert.equal(vm.deltaShort, null);
  assert.equal(vm.tooltip.hint, 'Click to load the reviews and calculate.');
  assert.ok(!vm.ariaLabel.includes('4.5'));

  const done = presenter.present(new RatingSummary({ ...base, sampleCount: 2, totalScanned: 3, complete: true }));
  assert.equal(done.state, 'ready', 'the same reviews, once loading has finished, are a result');
});

test('not calculated and nothing is going to calculate it: a click-to-calculate pill, not a skeleton that looks stuck', () => {
  const none = new RatingSummary({ ...base, recentAverage: null, sampleCount: 0, delta: null, totalScanned: 0 });
  const idle = presenter.present(none, { willCalculate: false });
  assert.equal(idle.state, 'idle');
  assert.equal(idle.badgeText, 'Recent rating · click to calculate');
  assert.equal(idle.deltaShort, null);
  assert.equal(idle.tooltip.hint, 'Click to load the reviews and calculate.');
  assert.ok(idle.tooltip.notes[0].includes('click the badge'));
  assert.ok(idle.ariaLabel.includes('Press to load'));

  const snippets = new RatingSummary({ ...base, sampleCount: 2, totalScanned: 3, delta: 0.4, complete: false });
  assert.equal(presenter.present(snippets, { willCalculate: false }).state, 'idle', 'snippets are not a result');
  assert.equal(presenter.present(snippets, { willCalculate: true }).state, 'loading', 'about to calculate: skeleton');
  assert.equal(presenter.present(snippets, { willCalculate: false, pending: true }).state, 'loading', 'running: skeleton');
  assert.equal(presenter.present(new RatingSummary(base), { willCalculate: false }).state, 'ready', 'a finished result is always shown');
});

// ---------------------------------------------------------------- the 1M / 3M / 6M strip

const windowSummary = (timeWindow, label, recentAverage, sampleCount, allTimeRating = 4.6) =>
  new RatingSummary({
    recentAverage, sampleCount, totalScanned: 80, allTimeRating, timeWindow, timeWindowLabel: label,
    delta: recentAverage === null ? null : Math.round((recentAverage - allTimeRating) * 10) / 10, allTimeReviewCount: 300,
  });
// the "Celeste" case: 4.6 all-time, 4.3 over 6 months, 4.1 over 3 months, 3.9 over 1 month
const celeste = () => [
  windowSummary('1_MONTH', '1 month', 3.9, 9),
  windowSummary('3_MONTHS', '3 months', 4.1, 22),
  windowSummary('6_MONTHS', '~6 months', 4.3, 48),
];

test('strip: one cell per window, shortest first, each with its rating and a ticker arrow against the all-time rating', () => {
  const windows = celeste();
  const vm = presenter.present(windows[2], { windows });
  assert.deepEqual(vm.cells.map((c) => [c.label, c.valueText, c.deltaText, c.direction, c.sampleText]), [
    ['1M', '3.9', '0.7', 'down', 'n=9'],
    ['3M', '4.1', '0.5', 'down', 'n=22'],
    ['6M', '4.3', '0.3', 'down', 'n=48'],
  ]);
  assert.equal(vm.trend, 'down', 'the newest window is below the 6-month one: trending down');
  assert.deepEqual(vm.cells.map((c) => c.windowId), ['1_MONTH', '3_MONTHS', '6_MONTHS'], 'what a click on the cell opens');
  assert.match(vm.ariaLabel, /Trending down/);
  const rows = Object.fromEntries(vm.tooltip.rows.map((r) => [r.label, r.value]));
  assert.equal(rows['1 month'], '3.9 ★ · n=9 · −0.7');

  const up = [windowSummary('1_MONTH', '1 month', 4.9, 9), windowSummary('3_MONTHS', '3 months', 4.8, 22), windowSummary('6_MONTHS', '~6 months', 4.7, 48)];
  const upVm = presenter.present(up[2], { windows: up });
  assert.equal(upVm.trend, 'up');
  assert.deepEqual(upVm.cells.map((c) => c.direction), ['up', 'up', 'up']);
});

test('strip: the overall trend ignores windows with too few reviews, and small differences are "flat"', () => {
  const six = windowSummary('6_MONTHS', '~6 months', 4.3, 48);
  assert.equal(overallTrend([windowSummary('1_MONTH', '1 month', 2.0, 2), windowSummary('3_MONTHS', '3 months', 4.6, 20), six]), 'up', 'two reviews decide nothing: 3M vs 6M');
  assert.equal(overallTrend([windowSummary('1_MONTH', '1 month', 4.2, 9), windowSummary('3_MONTHS', '3 months', 4.3, 20), six]), 'flat', '0.1 apart is rounding noise: steady');
  assert.equal(overallTrend([windowSummary('1_MONTH', '1 month', 4.1, 9), windowSummary('3_MONTHS', '3 months', 4.3, 20), six]), 'down', '0.2 is the smallest real move');
  assert.equal(overallTrend([windowSummary('1_MONTH', '1 month', null, 0), windowSummary('3_MONTHS', '3 months', null, 0), windowSummary('6_MONTHS', '~6 months', null, 0)]), 'none');
  assert.equal(overallTrend([windowSummary('6_MONTHS', '~6 months', 3.9, 30)]), 'down', 'only 6M: against the all-time rating');
});

test('strip: thin and empty windows are dimmed or marked, never invented', () => {
  const windows = [windowSummary('1_MONTH', '1 month', 2.0, 2), windowSummary('3_MONTHS', '3 months', null, 0), windowSummary('6_MONTHS', '~6 months', 4.3, 48)];
  const vm = presenter.present(windows[2], { windows });
  assert.equal(vm.cells[0].dim, true, 'n=2 is shown but quiet');
  assert.deepEqual([vm.cells[1].valueText, vm.cells[1].direction, vm.cells[1].deltaText], ['–', 'none', ''], 'nothing in the window: a dash, no arrow');
  assert.equal(vm.cells[2].dim, false);
});

test('strip: while loading the cells are placeholders of the final shape (one per window), never numbers', () => {
  const windows = celeste();
  const vm = presenter.present(windows[2], { windows, pending: true });
  assert.equal(vm.state, 'loading');
  assert.deepEqual(vm.cells.map((c) => c.valueText), ['', '', '']);
  assert.equal(vm.trend, 'none');
  assert.deepEqual(vm.placeholder.cells.map((c) => c.label), ['1M', '3M', '6M']);
  assert.ok(vm.placeholder.cells.every((c) => c.valueText === '0.0' && c.sampleText === 'n=00'));
});

test('unsupported layout (Google\'s phone layout): a short note instead of numbers, and no promise of a calculation', () => {
  const vm = presenter.present(new RatingSummary({ ...base, complete: false, totalScanned: 0, sampleCount: 0, recentAverage: null, delta: null }), { unsupported: true });
  assert.equal(vm.state, 'unsupported');
  assert.equal(vm.badgeText, 'Recent-only rating · open on desktop');
  assert.deepEqual(vm.cells, []);
  assert.equal(vm.trend, 'none');
  assert.equal(vm.tooltip.hint, null, 'no "click to calculate"');
  assert.ok(vm.tooltip.notes[0].includes('separate page'), 'says why');
  assert.equal(vm.tooltip.rows.find((r) => r.label === 'All-time rating').value, '4.1 ★', 'still shows what Google shows');
  assert.ok(vm.ariaLabel.startsWith('Recent-only rating'));
  // Proxy for "one line on a 360px phone": the previous 45-character wording measured 262px and was too close to wrapping.
  assert.ok(vm.badgeText.length <= 40, `note is ${vm.badgeText.length} characters`);
});

// ---------------------------------------------------------------- partial windows, unreadable dates

const uncovered = (timeWindow, label, avg, n) => new RatingSummary({ ...windowSummary(timeWindow, label, avg, n), covered: false });

test('strip: a window the load did not reach the end of is marked partial, listed in the tooltip, and never decides the trend', () => {
  const windows = [windowSummary('1_MONTH', '1 month', 3.9, 9), windowSummary('3_MONTHS', '3 months', 4.0, 30), uncovered('6_MONTHS', '~6 months', 4.9, 120)];
  const vm = presenter.present(windows[2], { windows });
  assert.deepEqual(vm.cells.map((c) => c.partial), [false, false, true]);
  assert.equal(vm.tooltip.rows.find((r) => r.label === '~6 months').value, '4.9 ★ · n=120 · +0.3 · partial');
  assert.ok(vm.tooltip.notes.some((n) => /does not reach back far enough for 6M/.test(n)));
  assert.match(vm.ariaLabel, /~6 months: 4\.9 stars from 120 reviews \(partial\)/);
  // 1M (3.9) is judged against the all-time rating (4.6), not against the 6M average, which is only the newest reviews
  assert.equal(overallTrend(windows), 'down');
  assert.equal(overallTrend([windowSummary('1_MONTH', '1 month', 4.7, 9), uncovered('6_MONTHS', '~6 months', 3.0, 120)]), 'flat', '4.7 vs the all-time 4.6, not vs the partial 3.0');
  assert.ok(presenter.present(windows[0], { windows: celeste() }).tooltip.notes.every((n) => !/far enough/.test(n)), 'nothing partial: no warning');
});

test('tooltip explains what the arrows compare with and that Google rounds dates', () => {
  const windows = celeste();
  const notes = presenter.present(windows[2], { windows }).tooltip.notes;
  assert.ok(notes.some((n) => /compare each window with the all-time rating/.test(n) && /rounds review dates/.test(n)));
});

test('every loaded review has an unreadable date (non-English Google): says so, not "none are recent"', () => {
  const summary = new RatingSummary({ ...base, recentAverage: null, sampleCount: 0, delta: null, totalScanned: 40, unparsedCount: 40 });
  const vm = presenter.present(summary);
  assert.equal(vm.state, 'empty');
  assert.ok(/English dates only/.test(vm.tooltip.notes[0]));
  assert.ok(!vm.tooltip.notes.some((n) => /None of the/.test(n) || /skipped/.test(n)));
  assert.match(vm.ariaLabel, /dates could not be read/);
});

test('strip with another longest window: headers come from the windows, and the trend is judged against the longest one shown', () => {
  const four = [
    windowSummary('1_MONTH', '1 month', 4.9, 9),
    windowSummary('2_MONTHS', '2 months', 4.6, 22),
    windowSummary('4_MONTHS', '4 months', 4.0, 48),
  ];
  const vm = presenter.present(four[2], { windows: four });
  assert.deepEqual(vm.cells.map((c) => c.label), ['1M', '2M', '4M']);
  assert.deepEqual(vm.cells.map((c) => c.windowId), ['1_MONTH', '2_MONTHS', '4_MONTHS']);
  assert.deepEqual(vm.placeholder.cells.map((c) => c.label), ['1M', '2M', '4M'], 'the skeleton has the same headers');
  assert.equal(vm.trend, 'up', '1M (4.9) against the 4M average (4.0), not against a 6M window that is not on the strip');

  const week = [
    windowSummary('1_WEEK', '1 week', 4.8, 5),
    windowSummary('1_MONTH', '1 month', 4.5, 9),
    windowSummary('2_MONTHS', '2 months', 4.0, 22),
  ];
  assert.deepEqual(presenter.present(week[2], { windows: week }).cells.map((c) => c.label), ['1W', '1M', '2M']);

  // when the longest window has too few reviews to be a baseline, the all-time rating is used, as before
  const thin = [windowSummary('1_MONTH', '1 month', 4.9, 9), windowSummary('2_MONTHS', '2 months', 4.9, 9), windowSummary('4_MONTHS', '4 months', 4.9, 1, 4.1)];
  assert.equal(overallTrend(thin), 'up');
});
