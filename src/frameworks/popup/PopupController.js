import { MAX_MAX_MONTHS, MIN_MAX_MONTHS, timeWindowShortLabel, trendWindowsFor } from '../../domain/entities/TimeWindow.js';

/** Thin UI controller for the toolbar popup. All logic lives in the settings use case. */
export class PopupController {
  /**
   * @param {{ document: Document, settingsUseCase: import('../../usecases/ManageExtensionSettingsUseCase.js').ManageExtensionSettingsUseCase }} deps
   */
  constructor({ document, settingsUseCase }) {
    this.document = document;
    this.settingsUseCase = settingsUseCase;
    this.searchInput = document.getElementById('enabled-search');
    this.mapsInput = document.getElementById('enabled-maps');
    this.windowSelect = document.getElementById('window');
    this.maxMonthsSelect = document.getElementById('max-months');
    this.stripPreview = document.getElementById('strip-preview');
    this.status = document.getElementById('status');
    this.#fillMonths();
  }

  /** Built from the domain's range, so the choices can never disagree with what the use case accepts. */
  #fillMonths() {
    for (let months = MIN_MAX_MONTHS; months <= MAX_MAX_MONTHS; months += 1) {
      const option = this.document.createElement('option');
      option.value = String(months);
      option.textContent = `${months} months`;
      this.maxMonthsSelect.append(option);
    }
  }

  async init() {
    this.#reflect(await this.settingsUseCase.getSettings());

    this.searchInput.addEventListener('change', () =>
      this.#save(() => this.settingsUseCase.setSearchEnabled(this.searchInput.checked)),
    );
    this.mapsInput.addEventListener('change', () =>
      this.#save(() => this.settingsUseCase.setMapsEnabled(this.mapsInput.checked)),
    );
    this.windowSelect.addEventListener('change', () =>
      this.#save(() => this.settingsUseCase.setTimeWindow(this.windowSelect.value)),
    );
    this.maxMonthsSelect.addEventListener('change', () =>
      this.#save(() => this.settingsUseCase.setMaxMonths(Number(this.maxMonthsSelect.value))),
    );
  }

  async #save(action) {
    try {
      this.#reflect(await action());
      this.#say('ok', 'Saved');
    } catch {
      this.#say('error', 'Could not save settings');
    }
  }

  /** The state lets the stylesheet tell a confirmation (a tick) from a failure (red) without parsing the text. */
  #say(state, text) {
    this.status.dataset.state = state;
    this.status.textContent = text;
  }

  #reflect(settings) {
    this.searchInput.checked = settings.searchEnabled;
    this.mapsInput.checked = settings.mapsEnabled;
    // The two choices below describe the badge, so they only apply while it is on somewhere.
    const badgeShown = settings.searchEnabled || settings.mapsEnabled;
    this.windowSelect.disabled = !badgeShown;
    this.windowSelect.value = settings.timeWindow;
    this.maxMonthsSelect.disabled = !badgeShown;
    this.maxMonthsSelect.value = String(settings.maxMonths);
    // What the badge will show for this choice, e.g. "Shows 1M · 3M · 6M": the rule is not obvious from "6 months" alone.
    this.stripPreview.textContent = `Shows ${trendWindowsFor(settings.maxMonths).map(timeWindowShortLabel).join(' · ')}`;
  }
}
