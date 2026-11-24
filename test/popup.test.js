import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PopupController } from '../src/frameworks/popup/PopupController.js';

// The real popup markup, so the test breaks if an id the controller needs is renamed.
const html = readFileSync(new URL('../src/frameworks/popup/popup.html', import.meta.url), 'utf8');

async function popup({ failSave = false } = {}) {
  const { window } = new JSDOM(html);
  const settings = { searchEnabled: true, mapsEnabled: true, timeWindow: '6_MONTHS', maxMonths: 6 };
  const settingsUseCase = {
    getSettings: async () => ({ ...settings }),
    setSearchEnabled: async (value) => {
      if (failSave) throw new Error('storage unavailable');
      settings.searchEnabled = value;
      return { ...settings };
    },
    setMapsEnabled: async (value) => {
      if (failSave) throw new Error('storage unavailable');
      settings.mapsEnabled = value;
      return { ...settings };
    },
    setTimeWindow: async (value) => {
      if (failSave) throw new Error('storage unavailable');
      settings.timeWindow = value;
      return { ...settings };
    },
    setMaxMonths: async (value) => {
      if (failSave) throw new Error('storage unavailable');
      settings.maxMonths = value;
      return { ...settings };
    },
  };
  await new PopupController({ document: window.document, settingsUseCase }).init();
  const doc = window.document;
  const changed = async (el) => {
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the save settle
  };
  return { doc, changed, status: doc.getElementById('status') };
}

test('popup: shows the saved settings; the window choices are disabled only once the badge is off on both Search and Maps', async () => {
  const { doc, changed } = await popup();
  const search = doc.getElementById('enabled-search');
  const maps = doc.getElementById('enabled-maps');
  const select = doc.getElementById('window');
  const longest = doc.getElementById('max-months');
  assert.deepEqual([search.checked, maps.checked], [true, true]);
  assert.equal(select.value, '6_MONTHS');
  assert.equal(select.disabled, false);

  search.checked = false;
  await changed(search);
  assert.equal(maps.checked, true, 'switching Search off leaves Maps on');
  assert.deepEqual([select.disabled, longest.disabled], [false, false], 'the badge still shows on Maps, so its settings still apply');

  maps.checked = false;
  await changed(maps);
  assert.deepEqual([select.disabled, longest.disabled], [true, true], 'nothing applies while it is off everywhere');

  search.checked = true;
  await changed(search);
  assert.deepEqual([select.disabled, longest.disabled], [false, false]);
  assert.equal(maps.checked, false, 'and Maps stays off');
});

test('popup: a successful save is reported as ok, a failed one as an error (the stylesheet shows a tick or red from this)', async () => {
  const ok = await popup();
  const select = ok.doc.getElementById('window');
  select.value = '1_MONTH';
  await ok.changed(select);
  assert.equal(ok.status.dataset.state, 'ok');
  assert.equal(ok.status.textContent, 'Saved');

  const failing = await popup({ failSave: true });
  const failingSelect = failing.doc.getElementById('window');
  failingSelect.value = '1_YEAR';
  await failing.changed(failingSelect);
  assert.equal(failing.status.dataset.state, 'error');
  assert.equal(failing.status.textContent, 'Could not save settings');
});

test('popup: each toggle is a real checkbox exposed as a switch, labelled by its row (so keys and screen readers work)', async () => {
  const { doc } = await popup();
  for (const [id, label] of [['enabled-search', /Google Search/], ['enabled-maps', /Google Maps/]]) {
    const toggle = doc.getElementById(id);
    assert.equal(toggle.type, 'checkbox', id);
    assert.equal(toggle.getAttribute('role'), 'switch', id);
    assert.match(doc.querySelector(`label[for="${id}"]`).textContent, label);
  }
});

test('popup: a failed save of either toggle is reported as an error', async () => {
  const { doc, changed, status } = await popup({ failSave: true });
  const maps = doc.getElementById('enabled-maps');
  maps.checked = false;
  await changed(maps);
  assert.equal(status.dataset.state, 'error');
});

test('popup: the longest-window choice offers 2 to 11 months, previews the badge strip, saves, and is disabled with the extension off', async () => {
  const { doc, changed } = await popup();
  const select = doc.getElementById('max-months');
  assert.deepEqual([...select.options].map((o) => o.value), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  assert.equal(select.value, '6');
  const preview = doc.getElementById('strip-preview');
  assert.equal(preview.textContent, 'Shows 1M \u00b7 3M \u00b7 6M');

  select.value = '4';
  await changed(select);
  assert.equal(preview.textContent, 'Shows 1M \u00b7 2M \u00b7 4M', 'the preview follows the choice');
  assert.equal(doc.getElementById('status').dataset.state, 'ok');

  select.value = '2';
  await changed(select);
  assert.equal(preview.textContent, 'Shows 1W \u00b7 1M \u00b7 2M');

  for (const id of ['enabled-search', 'enabled-maps']) {
    const toggle = doc.getElementById(id);
    toggle.checked = false;
    await changed(toggle);
  }
  assert.equal(select.disabled, true);
});

test('popup: a failed save of the longest window is reported as an error', async () => {
  const { doc, changed, status } = await popup({ failSave: true });
  const select = doc.getElementById('max-months');
  select.value = '9';
  await changed(select);
  assert.equal(status.dataset.state, 'error');
});
