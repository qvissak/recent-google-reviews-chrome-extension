import test from 'node:test';
import assert from 'node:assert/strict';
import { Review } from '../src/domain/entities/Review.js';
import { RelativeTimeParser } from '../src/domain/services/RelativeTimeParser.js';
import { CalculateRecentRatingUseCase } from '../src/usecases/CalculateRecentRatingUseCase.js';
import {
  ManageExtensionSettingsUseCase,
  DEFAULT_SETTINGS,
} from '../src/usecases/ManageExtensionSettingsUseCase.js';
import { ChromeStorageSettingsDao } from '../src/adapters/dao/ChromeStorageSettingsDao.js';

const parser = new RelativeTimeParser();
const review = (rating, raw) =>
  new Review({ rating, rawTimestamp: raw, parsedAgeBucket: raw ? parser.parse(raw) : null });

const source = (reviews, allTimeRating = 4.5, allTimeReviewCount = 2123) => ({
  readSnapshot: () => ({ reviews, allTimeRating, allTimeReviewCount }),
});

test('averages only in-window reviews, rounds to 1 dp, computes delta', () => {
  const reviews = [
    review(5, '2 days ago'),
    review(4, '3 weeks ago'),
    review(4, '4 months ago'),
    review(1, 'a year ago'), // excluded
    review(2, '42 weeks ago'), // excluded in 6 months
    review(3, null), // unparseable
  ];
  const uc = new CalculateRecentRatingUseCase({ reviewSource: source(reviews) });

  const six = uc.execute({ timeWindow: '6_MONTHS' });
  assert.equal(six.sampleCount, 3);
  assert.equal(six.totalScanned, 6);
  assert.equal(six.unparsedCount, 1);
  assert.equal(six.recentAverage, 4.3);
  assert.equal(six.delta, -0.2);
  assert.equal(six.allTimeRating, 4.5);
  assert.equal(six.timeWindowLabel, '~6 months');

  const year = uc.execute({ timeWindow: '1_YEAR' });
  assert.equal(year.sampleCount, 4);
  assert.equal(year.recentAverage, 3.8); // (5+4+4+2)/4 = 3.75 -> 3.8
});

test('zero matching reviews -> null average and delta, no crash', () => {
  const uc = new CalculateRecentRatingUseCase({ reviewSource: source([review(5, '2 years ago')]) });
  const s = uc.execute({ timeWindow: '6_MONTHS' });
  assert.equal(s.sampleCount, 0);
  assert.equal(s.recentAverage, null);
  assert.equal(s.delta, null);
  assert.equal(s.totalScanned, 1);
});

test('missing all-time rating -> delta null; unknown window falls back to default', () => {
  const uc = new CalculateRecentRatingUseCase({
    reviewSource: source([review(4, '1 day ago')], null, null),
  });
  const s = uc.execute({ timeWindow: 'bogus' });
  assert.equal(s.timeWindow, '6_MONTHS');
  assert.equal(s.allTimeRating, null);
  assert.equal(s.delta, null);
  assert.equal(s.recentAverage, 4);
});

test('delta of zero is +0, not -0', () => {
  const uc = new CalculateRecentRatingUseCase({ reviewSource: source([review(4, '1 day ago')], 4) });
  assert.ok(Object.is(uc.execute().delta, 0));
});

// ------------------------------------------------------------------ settings

class FakeStorage {
  constructor(initial = {}) {
    this.data = { ...initial };
    this.listeners = [];
    const self = this;
    this.sync = {
      async get(keys) {
        return Object.fromEntries(keys.filter((k) => k in self.data).map((k) => [k, self.data[k]]));
      },
      async set(values) {
        const changes = Object.fromEntries(Object.keys(values).map((k) => [k, { newValue: values[k] }]));
        Object.assign(self.data, values);
        self.listeners.forEach((l) => l(changes, 'sync'));
      },
    };
    this.onChanged = {
      addListener: (l) => self.listeners.push(l),
      removeListener: (l) => { self.listeners = self.listeners.filter((x) => x !== l); },
    };
  }
}

test('settings: defaults, validation, persistence, change notification', async () => {
  const storage = new FakeStorage({ timeWindow: 'garbage' });
  const uc = new ManageExtensionSettingsUseCase({
    settingsRepository: new ChromeStorageSettingsDao({ storage }),
  });
  assert.deepEqual(await uc.getSettings(), DEFAULT_SETTINGS);

  const seen = [];
  const unsubscribe = uc.subscribe((s) => seen.push(s));
  await uc.setTimeWindow('1_YEAR');
  await uc.setSearchEnabled(false);
  await uc.setMapsEnabled(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await uc.getSettings(), { searchEnabled: false, mapsEnabled: false, timeWindow: '11_MONTHS', maxMonths: 6 }, 'the old 1_YEAR is stored and read as 11_MONTHS');
  assert.ok(seen.length >= 2);

  await assert.rejects(() => uc.setTimeWindow('nope'), RangeError);
  unsubscribe();
  assert.equal(storage.listeners.length, 0);
});

test('settings: repository failure falls back to defaults', async () => {
  const uc = new ManageExtensionSettingsUseCase({
    settingsRepository: { load: async () => { throw new Error('boom'); } },
  });
  assert.deepEqual(await uc.getSettings(), DEFAULT_SETTINGS);
});

test('executeAll: one summary per window from a single read of the reviews', () => {
  let reads = 0;
  const reviews = [review(5, '2 days ago'), review(3, '3 weeks ago'), review(4, '4 months ago')];
  const useCase = new CalculateRecentRatingUseCase({
    reviewSource: { readSnapshot: () => { reads += 1; return { reviews, allTimeRating: 4.0, allTimeReviewCount: 99, placeName: 'P' }; } },
  });
  const [month, threeMonths, sixMonths] = useCase.executeAll({ timeWindows: ['1_MONTH', '3_MONTHS', '6_MONTHS'] });
  assert.equal(reads, 1, 'reading scans the page: never once per window');
  assert.deepEqual([month.sampleCount, threeMonths.sampleCount, sixMonths.sampleCount], [2, 2, 3]);
  assert.deepEqual([month.recentAverage, sixMonths.recentAverage], [4.0, 4.0]);
  assert.equal(useCase.execute({ timeWindow: '6_MONTHS' }).sampleCount, 3, 'execute() is still the single-window form');
});

test('settings: the longest badge window defaults to 6, is validated, persisted, and announced like any other setting', async () => {
  const storage = new FakeStorage({ maxMonths: 'garbage' });
  const uc = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  assert.equal((await uc.getSettings()).maxMonths, 6, 'unreadable stored value: default');

  const seen = [];
  const unsubscribe = uc.subscribe((s) => seen.push(s));
  const saved = await uc.setMaxMonths(4);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(saved.maxMonths, 4);
  assert.equal(seen.at(-1).maxMonths, 4, 'the page is told');
  assert.equal((await uc.getSettings()).timeWindow, '6_MONTHS', 'the other settings are untouched');

  for (const bad of [1, 12, 4.5, '4', null]) await assert.rejects(() => uc.setMaxMonths(bad), RangeError, String(bad));
  assert.equal((await uc.getSettings()).maxMonths, 4, 'a rejected value changes nothing');
  unsubscribe();
});

test('settings: Search and Maps are switched on and off independently, and both default to on', async () => {
  const storage = new FakeStorage({});
  const uc = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  const initial = await uc.getSettings();
  assert.deepEqual([initial.searchEnabled, initial.mapsEnabled], [true, true]);

  const seen = [];
  uc.subscribe((s) => seen.push(s));
  let now = await uc.setSearchEnabled(false);
  assert.deepEqual([now.searchEnabled, now.mapsEnabled], [false, true], 'turning Search off leaves Maps on');
  now = await uc.setMapsEnabled(false);
  assert.deepEqual([now.searchEnabled, now.mapsEnabled], [false, false]);
  now = await uc.setSearchEnabled(true);
  assert.deepEqual([now.searchEnabled, now.mapsEnabled], [true, false], 'and the other way round');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([seen.at(-1).searchEnabled, seen.at(-1).mapsEnabled], [true, false], 'the page is told');

  assert.equal(storage.data.searchEnabled, true);
  assert.equal(storage.data.mapsEnabled, false);
  assert.equal('isEnabled' in storage.data, false, 'the old single switch is never written again');
});

test('settings: the old single on/off switch carries over to both, until each is set on its own', async () => {
  const off = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage: new FakeStorage({ isEnabled: false }) }) });
  const migratedOff = await off.getSettings();
  assert.deepEqual([migratedOff.searchEnabled, migratedOff.mapsEnabled], [false, false], 'someone who had it off still has it off everywhere');

  const on = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage: new FakeStorage({ isEnabled: true }) }) });
  const migratedOn = await on.getSettings();
  assert.deepEqual([migratedOn.searchEnabled, migratedOn.mapsEnabled], [true, true]);

  // Turning one back on does not turn the other on behind their back.
  const afterSearchOn = await off.setSearchEnabled(true);
  assert.deepEqual([afterSearchOn.searchEnabled, afterSearchOn.mapsEnabled], [true, false]);

  // A value set on its own wins over the legacy one.
  const mixed = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage: new FakeStorage({ isEnabled: false, mapsEnabled: true }) }) });
  const m = await mixed.getSettings();
  assert.deepEqual([m.searchEnabled, m.mapsEnabled], [false, true]);
});
