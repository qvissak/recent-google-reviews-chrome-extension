import test from 'node:test';
import assert from 'node:assert/strict';
import { RelativeTimeParser, AgeUnit } from '../src/domain/services/RelativeTimeParser.js';
import { Review } from '../src/domain/entities/Review.js';
import { windowIncludes, TimeWindowId } from '../src/domain/entities/TimeWindow.js';

const parser = new RelativeTimeParser();

test('parser: recognizes Google relative strings', () => {
  const cases = [
    ['just now', AgeUnit.JUST_NOW, 0],
    ['5 minutes ago', AgeUnit.MINUTES, 5],
    ['an hour ago', AgeUnit.HOURS, 1],
    ['2 days ago', AgeUnit.DAYS, 2],
    ['a week ago', AgeUnit.WEEKS, 1],
    ['42 weeks ago', AgeUnit.WEEKS, 42],
    ['a month ago', AgeUnit.MONTHS, 1],
    ['4 months ago', AgeUnit.MONTHS, 4],
    ['a year ago', AgeUnit.YEARS, 1],
    ['3 years ago', AgeUnit.YEARS, 3],
    ['Edited 3 weeks ago', AgeUnit.WEEKS, 3],
    ['2 months ago on Google', AgeUnit.MONTHS, 2],
    ['  4 months   ago ', AgeUnit.MONTHS, 4],
    ['yesterday', AgeUnit.DAYS, 1],
  ];
  for (const [raw, unit, value] of cases) {
    const b = parser.parse(raw);
    assert.ok(b, raw);
    assert.equal(b.unit, unit, raw);
    assert.equal(b.value, value, raw);
  }
});

test('parser: rejects non-timestamps', () => {
  for (const raw of ['', null, undefined, 'Closes in 2 hours', 'Great food 2 days ago!', 'a while ago', '12/03/2024', 'Local Guide · 54 reviews']) {
    assert.equal(parser.parse(raw), null, String(raw));
  }
});

test('Review: validates rating bounds', () => {
  assert.throws(() => new Review({ rating: 0 }), RangeError);
  assert.throws(() => new Review({ rating: 6 }), RangeError);
  assert.throws(() => new Review({ rating: NaN }), RangeError);
  assert.equal(new Review({ rating: 5 }).rating, 5);
  assert.equal(new Review({ rating: 1 }).parsedAgeBucket, null);
});

test('TimeWindow ~6 months: boundaries', () => {
  const inWindow = (raw) => windowIncludes(TimeWindowId.SIX_MONTHS, parser.parse(raw));
  for (const raw of ['just now', '3 hours ago', '2 days ago', '26 weeks ago', '6 months ago', 'a month ago']) {
    assert.equal(inWindow(raw), true, raw);
  }
  for (const raw of ['27 weeks ago', '7 months ago', '42 weeks ago', 'a year ago', '2 years ago']) {
    assert.equal(inWindow(raw), false, raw);
  }
  assert.equal(windowIncludes(TimeWindowId.SIX_MONTHS, null), false);
});

test('TimeWindow < 1 year: boundaries', () => {
  const inWindow = (raw) => windowIncludes(TimeWindowId.ONE_YEAR, parser.parse(raw));
  for (const raw of ['42 weeks ago', '11 months ago', '51 weeks ago', '6 months ago']) {
    assert.equal(inWindow(raw), true, raw);
  }
  for (const raw of ['a year ago', '1 year ago', '2 years ago', '52 weeks ago']) {
    assert.equal(inWindow(raw), false, raw);
  }
});

test('TimeWindow week / month / 3 months: boundaries on Google\'s coarse dates', () => {
  const inWindow = (id, raw) => windowIncludes(id, parser.parse(raw));
  for (const raw of ['just now', '3 hours ago', '2 days ago', '7 days ago', 'a week ago']) {
    assert.equal(inWindow(TimeWindowId.ONE_WEEK, raw), true, `week: ${raw}`);
  }
  for (const raw of ['2 weeks ago', '8 days ago', 'a month ago']) {
    assert.equal(inWindow(TimeWindowId.ONE_WEEK, raw), false, `week: ${raw}`);
  }
  for (const raw of ['2 weeks ago', '4 weeks ago', 'a month ago', '30 days ago']) {
    assert.equal(inWindow(TimeWindowId.ONE_MONTH, raw), true, `month: ${raw}`);
  }
  for (const raw of ['5 weeks ago', '2 months ago']) {
    assert.equal(inWindow(TimeWindowId.ONE_MONTH, raw), false, `month: ${raw}`);
  }
  for (const raw of ['a month ago', '2 months ago', '3 months ago', '13 weeks ago']) {
    assert.equal(inWindow(TimeWindowId.THREE_MONTHS, raw), true, `3 months: ${raw}`);
  }
  for (const raw of ['4 months ago', '14 weeks ago', 'a year ago']) {
    assert.equal(inWindow(TimeWindowId.THREE_MONTHS, raw), false, `3 months: ${raw}`);
  }
  // windows nest: anything in a smaller window is in every larger one
  const ids = [TimeWindowId.ONE_WEEK, TimeWindowId.ONE_MONTH, TimeWindowId.THREE_MONTHS, TimeWindowId.SIX_MONTHS, TimeWindowId.ONE_YEAR];
  for (const raw of ['just now', '2 days ago', 'a week ago', '3 weeks ago', 'a month ago', '3 months ago', '6 months ago', '11 months ago', 'a year ago']) {
    const flags = ids.map((id) => inWindow(id, raw));
    assert.deepEqual(flags, [...flags].sort((a, b) => Number(a) - Number(b)), `nesting: ${raw}`);
  }
});

test('TimeWindow: default is 6 months and options are listed in order', async () => {
  const { DEFAULT_TIME_WINDOW, TIME_WINDOW_OPTIONS, timeWindowOptionLabel } = await import('../src/domain/entities/TimeWindow.js');
  assert.equal(DEFAULT_TIME_WINDOW, '6_MONTHS');
  assert.deepEqual(
    TIME_WINDOW_OPTIONS.map((o) => o.label),
    ['Last week', 'Last month', ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `Last ${n} months`)],
  );
  assert.equal(timeWindowOptionLabel('3_MONTHS'), 'Last 3 months');
});

test('TimeWindow: the strip shows 1M, 3M, 6M shortest first; widerTimeWindow picks the one reaching further back', async () => {
  const { TREND_WINDOWS, widerTimeWindow } = await import('../src/domain/entities/TimeWindow.js');
  assert.deepEqual([...TREND_WINDOWS], ['1_MONTH', '3_MONTHS', '6_MONTHS']);
  assert.equal(widerTimeWindow('1_WEEK', '6_MONTHS'), '6_MONTHS');
  assert.equal(widerTimeWindow('1_YEAR', '6_MONTHS'), '11_MONTHS', 'the old year window is now the 11-month one');
  assert.equal(widerTimeWindow('3_MONTHS', '3_MONTHS'), '3_MONTHS');
  assert.equal(TREND_WINDOWS.reduce(widerTimeWindow, '1_WEEK'), '6_MONTHS', 'loading for the strip covers every cell');
});

test('isMobileLayout: phone user agents only (Google picks the layout from the user agent, not the window width)', async () => {
  const { isMobileLayout } = await import('../src/frameworks/content/googleLayout.js');
  const pixel = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36';
  const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  const androidTablet = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  assert.equal(isMobileLayout({ userAgent: pixel }), true, 'DevTools Pixel emulation');
  assert.equal(isMobileLayout({ userAgent: desktop }), false, 'a narrow desktop window still gets the desktop layout');
  assert.equal(isMobileLayout({ userAgent: androidTablet }), false, 'tablets are served the larger layout');
  assert.equal(isMobileLayout({ userAgent: desktop, userAgentData: { mobile: true } }), true, 'the client hint wins');
  assert.equal(isMobileLayout({}), false);
});

test('TimeWindow: the strip for each longest window (2 to 11 months) follows the product table', async () => {
  const { trendWindowsFor, timeWindowShortLabel } = await import('../src/domain/entities/TimeWindow.js');
  const strip = (max) => trendWindowsFor(max).map(timeWindowShortLabel).join('/');
  assert.equal(strip(6), '1M/3M/6M');
  assert.equal(strip(5), '1M/3M/5M');
  assert.equal(strip(4), '1M/2M/4M');
  assert.equal(strip(3), '1M/2M/3M');
  assert.equal(strip(2), '1W/1M/2M', 'the shortest is a week once the middle one is already a month');
  // beyond the table the same rule holds: a month, half of the longest (rounded up), the longest
  assert.deepEqual([7, 8, 9, 10, 11].map(strip), ['1M/4M/7M', '1M/4M/8M', '1M/5M/9M', '1M/5M/10M', '1M/6M/11M']);
  for (let max = 2; max <= 11; max += 1) {
    const ids = trendWindowsFor(max);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, `${max}: three different windows`);
    assert.equal(trendWindowsFor(max).at(-1), max === 1 ? '1_MONTH' : `${max}_MONTHS`, 'the longest is the chosen one');
  }
  assert.deepEqual([...trendWindowsFor()], [...trendWindowsFor(6)], 'default is 6');
  assert.deepEqual([...trendWindowsFor(12)], [...trendWindowsFor(6)], 'out of range falls back to the default');
});

test('TimeWindow: longest-window validation accepts whole numbers from 2 to 11 only', async () => {
  const { isValidMaxMonths, normalizeMaxMonths } = await import('../src/domain/entities/TimeWindow.js');
  for (const ok of [2, 3, 6, 11]) assert.equal(isValidMaxMonths(ok), true, String(ok));
  for (const bad of [1, 12, 0, -3, 4.5, '6', null, undefined, NaN]) assert.equal(isValidMaxMonths(bad), false, String(bad));
  assert.equal(normalizeMaxMonths(9), 9);
  assert.equal(normalizeMaxMonths(12), 6);
});

test('TimeWindow: every N-month window includes "N months ago" and excludes "N+1 months ago"; 1_YEAR is an alias of 11_MONTHS', async () => {
  const { windowIncludes, normalizeTimeWindow } = await import('../src/domain/entities/TimeWindow.js');
  for (let n = 1; n <= 11; n += 1) {
    const id = n === 1 ? '1_MONTH' : `${n}_MONTHS`;
    assert.equal(windowIncludes(id, parser.parse(n === 1 ? 'a month ago' : `${n} months ago`)), true, `${id} includes its own edge`);
    assert.equal(windowIncludes(id, parser.parse(`${n + 1} months ago`)), false, `${id} excludes the next month`);
    assert.equal(windowIncludes(id, parser.parse('a year ago')), false, `${id} excludes "a year ago"`);
  }
  assert.equal(normalizeTimeWindow('1_YEAR'), '11_MONTHS');
  assert.equal(normalizeTimeWindow('13_MONTHS'), '6_MONTHS', 'unknown ids still fall back to the default');
});

test('TimeWindow: loading goes back far enough for every window on the badge and for the selected one', async () => {
  const { loadWindowFor } = await import('../src/domain/entities/TimeWindow.js');
  assert.equal(loadWindowFor('1_WEEK', 6), '6_MONTHS');
  assert.equal(loadWindowFor('1_WEEK', 9), '9_MONTHS', 'a longer badge loads deeper');
  assert.equal(loadWindowFor('1_WEEK', 2), '2_MONTHS', 'a shorter one loads less');
  assert.equal(loadWindowFor('11_MONTHS', 4), '11_MONTHS', 'the list may reach further than the badge');
  assert.equal(loadWindowFor('1_YEAR', 4), '11_MONTHS', 'a stored legacy id works too');
  assert.equal(loadWindowFor('garbage', undefined), '6_MONTHS');
});
