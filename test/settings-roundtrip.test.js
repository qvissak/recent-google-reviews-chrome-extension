import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ChromeStorageSettingsDao } from '../src/adapters/dao/ChromeStorageSettingsDao.js';
import { ManageExtensionSettingsUseCase } from '../src/usecases/ManageExtensionSettingsUseCase.js';
import { PopupController } from '../src/frameworks/popup/PopupController.js';

const html = readFileSync(new URL('../src/frameworks/popup/popup.html', import.meta.url), 'utf8');

/** chrome.storage as the browser gives it: promise-based sync.get(keys) / sync.set(items), and onChanged(changes, area). */
function fakeChromeStorage() {
  const data = {};
  const listeners = new Set();
  return {
    data,
    sync: {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        const changes = {};
        for (const [key, newValue] of Object.entries(items)) {
          changes[key] = { oldValue: data[key], newValue };
          data[key] = newValue;
        }
        for (const listener of [...listeners]) listener(changes, 'sync');
      },
    },
    onChanged: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
  };
}

async function openPopup(storage) {
  const { window } = new JSDOM(html);
  const settingsUseCase = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  await new PopupController({ document: window.document, settingsUseCase }).init();
  return window;
}

const choose = async (window, id, value) => {
  const el = window.document.getElementById(id);
  if (el.type === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test('settings: a window picked in the popup is stored, reaches a listening content script, and is still there when the popup reopens', async () => {
  const storage = fakeChromeStorage();
  // The page side: a use case subscribed the way ContentScriptController does.
  const pageSeen = [];
  const page = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  page.subscribe((settings) => pageSeen.push(settings));

  const popup = await openPopup(storage);
  assert.equal(popup.document.getElementById('window').value, '6_MONTHS', 'default before anything is saved');

  await choose(popup, 'window', '1_MONTH');
  assert.equal(storage.data.timeWindow, '1_MONTH', 'written to storage');
  assert.equal(popup.document.getElementById('status').textContent, 'Saved');
  assert.deepEqual(pageSeen.at(-1), { searchEnabled: true, mapsEnabled: true, timeWindow: '1_MONTH', maxMonths: 6 }, 'the page is told');

  const reopened = await openPopup(storage);
  assert.equal(reopened.document.getElementById('window').value, '1_MONTH', 'still selected next time');

  await choose(reopened, 'enabled-search', false);
  await choose(reopened, 'enabled-maps', false);
  assert.deepEqual(pageSeen.at(-1), { searchEnabled: false, mapsEnabled: false, timeWindow: '1_MONTH', maxMonths: 6 }, 'switching off keeps the window');
  assert.equal(reopened.document.getElementById('window').disabled, true);
});

test('settings: every option the popup offers is accepted and stored', async () => {
  const storage = fakeChromeStorage();
  const popup = await openPopup(storage);
  const options = [...popup.document.querySelectorAll('#window option')].map((o) => o.value);
  assert.ok(options.length >= 5);
  for (const value of options) {
    await choose(popup, 'window', value);
    assert.equal(storage.data.timeWindow, value, `${value} saved`);
    assert.equal(popup.document.getElementById('status').dataset.state, 'ok', `${value} reported as saved`);
  }
});

test('settings: the longest badge window is stored, reaches the page, and survives reopening the popup', async () => {
  const storage = fakeChromeStorage();
  const pageSeen = [];
  const page = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  page.subscribe((settings) => pageSeen.push(settings));

  const popup = await openPopup(storage);
  assert.equal(popup.document.getElementById('max-months').value, '6', 'default');

  await choose(popup, 'max-months', '9');
  assert.equal(storage.data.maxMonths, 9, 'written as a number');
  assert.equal(pageSeen.at(-1).maxMonths, 9, 'the page is told');

  const reopened = await openPopup(storage);
  assert.equal(reopened.document.getElementById('max-months').value, '9', 'still there next time');
  assert.equal(reopened.document.getElementById('strip-preview').textContent, 'Shows 1M · 5M · 9M');
});

test('settings: every longest-window choice the popup offers is accepted and stored', async () => {
  const storage = fakeChromeStorage();
  const popup = await openPopup(storage);
  const options = [...popup.document.querySelectorAll('#max-months option')].map((o) => Number(o.value));
  assert.deepEqual(options, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const value of options) {
    await choose(popup, 'max-months', String(value));
    assert.equal(storage.data.maxMonths, value, `${value} saved`);
    assert.equal(popup.document.getElementById('status').dataset.state, 'ok', `${value} reported as saved`);
  }
});

test('settings: Search and Maps toggles are stored separately, reach the page, and survive reopening the popup; an old single switch carries over', async () => {
  const storage = fakeChromeStorage();
  const pageSeen = [];
  const page = new ManageExtensionSettingsUseCase({ settingsRepository: new ChromeStorageSettingsDao({ storage }) });
  page.subscribe((settings) => pageSeen.push(settings));

  const popup = await openPopup(storage);
  await choose(popup, 'enabled-maps', false);
  assert.equal(storage.data.mapsEnabled, false);
  assert.equal('searchEnabled' in storage.data, false, 'only the one that changed is written');
  assert.deepEqual([pageSeen.at(-1).searchEnabled, pageSeen.at(-1).mapsEnabled], [true, false]);

  const reopened = await openPopup(storage);
  assert.deepEqual(
    [reopened.document.getElementById('enabled-search').checked, reopened.document.getElementById('enabled-maps').checked],
    [true, false],
  );

  // Someone upgrading from the single switch, who had it off:
  const legacy = fakeChromeStorage();
  legacy.data.isEnabled = false;
  const migrated = await openPopup(legacy);
  assert.deepEqual(
    [migrated.document.getElementById('enabled-search').checked, migrated.document.getElementById('enabled-maps').checked],
    [false, false],
  );
  assert.equal(migrated.document.getElementById('window').disabled, true);
});
