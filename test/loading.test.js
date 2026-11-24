import test from 'node:test';
import assert from 'node:assert/strict';
import { Review } from '../src/domain/entities/Review.js';
import { RelativeTimeParser } from '../src/domain/services/RelativeTimeParser.js';
import { CalculateRecentRatingUseCase } from '../src/usecases/CalculateRecentRatingUseCase.js';
import { LoadReviewsUseCase, coversWindow } from '../src/usecases/LoadReviewsUseCase.js';
import { windowIsCovered } from '../src/domain/services/ReviewCoverage.js';

const parser = new RelativeTimeParser();
let n = 0;
const review = (rating, raw) =>
  new Review({ rating, rawTimestamp: raw, parsedAgeBucket: parser.parse(raw), id: `r${(n += 1)}` });

test('Calculate: returns the matched reviews newest-first, and the place name', () => {
  const reviews = [review(4, '3 months ago'), review(5, '2 days ago'), review(3, '2 weeks ago'), review(1, 'a year ago')];
  const uc = new CalculateRecentRatingUseCase({
    reviewSource: { readSnapshot: () => ({ reviews, allTimeRating: 4.5, allTimeReviewCount: 100, placeName: 'Krasi' }) },
  });
  const s = uc.execute({ timeWindow: '6_MONTHS' });
  assert.deepEqual(s.matchedReviews.map((r) => r.rawTimestamp), ['2 days ago', '2 weeks ago', '3 months ago']);
  assert.equal(s.placeName, 'Krasi');
  assert.equal(uc.execute({ timeWindow: '1_WEEK' }).sampleCount, 1);
  assert.equal(uc.execute({ timeWindow: '1_MONTH' }).sampleCount, 2);
  assert.equal(uc.execute({ timeWindow: '3_MONTHS' }).recentAverage, 4);
});

test('coversWindow: needs age order and one review older than the window', () => {
  const asc = [review(5, '2 days ago'), review(5, '2 months ago'), review(5, '8 months ago')];
  assert.equal(coversWindow(asc, '6_MONTHS'), true);
  assert.equal(coversWindow(asc.slice(0, 2), '6_MONTHS'), false, 'nothing older seen yet');
  const shuffled = [review(5, '8 months ago'), review(5, '2 days ago')];
  assert.equal(coversWindow(shuffled, '6_MONTHS'), false, 'not newest-first: cannot conclude');
});

/** Fake world: `pages` of reviews, one page revealed per loadMore. */
function fakeWorld(pages) {
  const calls = { open: 0, loadMore: 0, close: 0, reset: 0 };
  let shown = 1;
  const reviewSource = {
    reset: () => { calls.reset += 1; },
    readSnapshot: () => ({ reviews: pages.slice(0, shown).flat(), allTimeRating: 4.5, allTimeReviewCount: pages.flat().length }), // an honest total: the list really ends
  };
  const reviewLoader = {
    open: async () => { calls.open += 1; shown = 1; },
    loadMore: async () => { calls.loadMore += 1; if (shown >= pages.length) return false; shown += 1; return true; },
    close: async () => { calls.close += 1; },
  };
  return { calls, uc: new LoadReviewsUseCase({ reviewSource, reviewLoader }) };
}

const pages = () => [
  [review(5, '2 days ago'), review(5, '2 weeks ago')],
  [review(4, 'a month ago'), review(4, '3 months ago')],
  [review(3, '5 months ago'), review(3, '7 months ago')],
  [review(2, 'a year ago')],
];

test('LoadReviews: stops as soon as the window is covered', async () => {
  const { uc, calls } = fakeWorld(pages());
  const result = await uc.execute({ timeWindow: '1_MONTH' });
  assert.deepEqual(result, { reason: 'covered', rounds: 1 }); // page 2 has "3 months ago"
  assert.deepEqual([calls.reset, calls.open, calls.loadMore], [1, 1, 1]);

  const six = await fakeWorld(pages()).uc.execute({ timeWindow: '6_MONTHS' });
  assert.deepEqual(six, { reason: 'covered', rounds: 2 }); // needs "7 months ago" from page 3
});

test('LoadReviews: reports exhaustion, the round cap, and cancellation', async () => {
  const everythingRecent = [[review(5, '1 day ago')], [review(5, '2 days ago')]];
  assert.equal((await fakeWorld(everythingRecent).uc.execute({ timeWindow: '1_YEAR' })).reason, 'exhausted');

  const capped = await fakeWorld(pages()).uc.execute({ timeWindow: '1_YEAR', maxRounds: 1 });
  assert.deepEqual(capped, { reason: 'max-rounds', rounds: 1 });

  const { uc, calls } = fakeWorld(pages());
  let cancelled = false;
  const result = await uc.execute({ timeWindow: '1_YEAR', onProgress: () => { cancelled = true; }, isCancelled: () => cancelled });
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls.loadMore, 0);
});

test('LoadReviews: unordered reviews disable the early stop', async () => {
  const unordered = [[review(5, '8 months ago'), review(5, '2 days ago')], [review(5, '1 day ago')]];
  const result = await fakeWorld(unordered).uc.execute({ timeWindow: '1_MONTH' });
  assert.equal(result.reason, 'exhausted', 'kept loading instead of trusting a shuffled list');
});

test('LoadReviews: extend() continues without reopening; window getter is re-read each round; release() closes', async () => {
  const { uc, calls } = fakeWorld(pages());
  await uc.execute({ timeWindow: '1_MONTH' });
  const before = { ...calls };

  const result = await uc.extend({ timeWindow: '1_YEAR' }); // needs "a year ago" from page 4
  assert.equal(result.reason, 'covered');
  assert.equal(calls.open, before.open, 'did not reopen / re-sort');
  assert.equal(calls.reset, before.reset, 'did not discard what was loaded');
  assert.equal(calls.loadMore, before.loadMore + 2);

  const fresh = fakeWorld(pages());
  let current = '1_YEAR';
  const r = await fresh.uc.execute({ timeWindow: () => current, onProgress: () => { current = '1_WEEK'; } });
  assert.equal(r.reason, 'covered'); // window narrowed mid-load
  assert.ok(r.rounds <= 1, 'narrowing the window mid-load stops early');

  await uc.release();
  assert.equal(calls.close, 1);
});

// ------------------------------------------------ a list that stops giving reviews is not the end of the list

test('LoadReviews: no growth while far fewer reviews are loaded than Google reports is "stalled", never a finished result', async () => {
  const calls = { loadMore: 0, markComplete: 0 };
  const loaded = [review(5, '2 days ago'), review(5, '5 days ago')]; // the 10 newest, all within the month
  const reviewSource = {
    reset() {},
    markComplete: () => { calls.markComplete += 1; },
    readSnapshot: () => ({ reviews: loaded, allTimeRating: 4.5, allTimeReviewCount: 871 }),
  };
  const reviewLoader = { open: async () => {}, loadMore: async () => { calls.loadMore += 1; return false; }, close: async () => {} };
  const uc = new LoadReviewsUseCase({ reviewSource, reviewLoader });

  const result = await uc.execute({ timeWindow: '6_MONTHS' });
  assert.equal(result.reason, 'stalled');
  assert.equal(calls.loadMore, 3, 'asked again twice before giving up: Google may just be slow');
  assert.equal(calls.markComplete, 0, 'two reviews of 871 are not a result');
  assert.equal(uc.freshResult({ timeWindow: '6_MONTHS' }), null, 'so a later open does not reuse them');
});

test('LoadReviews: a slow page that finally arrives after a stall is picked up', async () => {
  let shown = 1;
  let askedAfterEmpty = 0;
  const pages = [[review(5, '2 days ago')], [review(4, 'a month ago')], [review(3, '8 months ago')]];
  const reviewSource = { reset() {}, markComplete() {}, readSnapshot: () => ({ reviews: pages.slice(0, shown).flat(), allTimeRating: 4.5, allTimeReviewCount: 3 + 500 }) };
  const reviewLoader = {
    open: async () => {},
    loadMore: async () => {
      askedAfterEmpty += 1;
      if (askedAfterEmpty === 1) return false; // first ask: nothing within the timeout
      if (shown >= pages.length) return false;
      shown += 1;
      return true;
    },
    close: async () => {},
  };
  const result = await new LoadReviewsUseCase({ reviewSource, reviewLoader }).execute({ timeWindow: '6_MONTHS' });
  assert.equal(result.reason, 'covered', 'it asked again and got the rest');
});

test('LoadReviews: the list ending with (nearly) everything Google reports loaded is exhausted at once, without waiting around', async () => {
  let asked = 0;
  const reviews = [review(5, '2 days ago'), review(4, '3 days ago'), review(3, '4 days ago')];
  const uc = new LoadReviewsUseCase({
    reviewSource: { reset() {}, markComplete() {}, readSnapshot: () => ({ reviews, allTimeRating: 4, allTimeReviewCount: 3 }) },
    reviewLoader: { open: async () => {}, loadMore: async () => { asked += 1; return false; }, close: async () => {} },
  });
  assert.equal((await uc.execute({ timeWindow: '6_MONTHS' })).reason, 'exhausted');
  assert.equal(asked, 1, 'no retries when the end is real');
});

// ---------------------------------------------------------------- partial windows (busy places)

test('windowIsCovered: a window is exact only when a review older than it was seen, or the whole list is loaded', () => {
  const busy = [...Array.from({ length: 60 }, () => review(5, '2 days ago')), ...Array.from({ length: 60 }, () => review(4, '5 weeks ago'))];
  assert.equal(windowIsCovered({ reviews: busy, allTimeReviewCount: 900 }, '1_MONTH'), true, '5 weeks ago is older than a month: seen the end of it');
  assert.equal(windowIsCovered({ reviews: busy, allTimeReviewCount: 900 }, '6_MONTHS'), false, 'the page cap was hit well inside 6 months');
  assert.equal(windowIsCovered({ reviews: busy, allTimeReviewCount: 125 }, '6_MONTHS'), true, 'nearly the whole list is loaded: nothing more exists');
  assert.equal(windowIsCovered({ reviews: busy, allTimeReviewCount: null }, '6_MONTHS'), false, 'no total from Google: no proof the list ended');
  const unsorted = [review(5, '8 months ago'), review(5, '2 days ago')];
  assert.equal(windowIsCovered({ reviews: unsorted, allTimeReviewCount: 900 }, '6_MONTHS'), false, 'not newest-first: proves nothing (e.g. Newest never got selected)');
});

test('Calculate: each window says whether the loaded reviews reach back far enough for it', () => {
  const reviews = [...Array.from({ length: 5 }, () => review(5, '2 days ago')), ...Array.from({ length: 5 }, () => review(4, '2 months ago'))];
  const uc = new CalculateRecentRatingUseCase({ reviewSource: { readSnapshot: () => ({ reviews, allTimeRating: 4.5, allTimeReviewCount: 400, placeName: 'P' }) } });
  const [oneMonth, threeMonths, sixMonths] = uc.executeAll({ timeWindows: ['1_MONTH', '3_MONTHS', '6_MONTHS'] });
  assert.deepEqual([oneMonth.covered, threeMonths.covered, sixMonths.covered], [true, false, false]);
});
