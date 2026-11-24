import {
  DEFAULT_MAX_MONTHS,
  DEFAULT_TIME_WINDOW,
  isValidMaxMonths,
  isValidTimeWindow,
  normalizeTimeWindow,
} from '../domain/entities/TimeWindow.js';

export const DEFAULT_SETTINGS = Object.freeze({
  searchEnabled: true,
  mapsEnabled: true,
  timeWindow: DEFAULT_TIME_WINDOW,
  maxMonths: DEFAULT_MAX_MONTHS,
});

/** Merge untrusted stored values over defaults. */
function normalize(stored) {
  const s = stored ?? {};
  // One on/off switch used to cover both Search and Maps: someone who only has that stored keeps their choice on both.
  const surface = (own) => (typeof own === 'boolean' ? own : typeof s.isEnabled === 'boolean' ? s.isEnabled : true);
  return {
    searchEnabled: surface(s.searchEnabled),
    mapsEnabled: surface(s.mapsEnabled),
    // normalizeTimeWindow also moves a stored legacy id (1_YEAR) to its current one, so the dropdowns always find it.
    timeWindow: isValidTimeWindow(s.timeWindow) ? normalizeTimeWindow(s.timeWindow) : DEFAULT_SETTINGS.timeWindow,
    maxMonths: isValidMaxMonths(s.maxMonths) ? s.maxMonths : DEFAULT_SETTINGS.maxMonths,
  };
}

/** Reads and updates user preferences through an injected repository. */
export class ManageExtensionSettingsUseCase {
  /** @param {{ settingsRepository: import('./ports/SettingsRepositoryPort.js').SettingsRepositoryPort }} deps */
  constructor({ settingsRepository }) {
    this.settingsRepository = settingsRepository;
  }

  async getSettings() {
    try {
      return normalize(await this.settingsRepository.load());
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Show or hide the badge on Google Search.
   * @param {boolean} enabled
   * @returns {Promise<{searchEnabled: boolean, mapsEnabled: boolean, timeWindow: string, maxMonths: number}>} the settings as now stored
   * @example await settings.setSearchEnabled(false) // Maps is unaffected
   */
  async setSearchEnabled(enabled) {
    await this.settingsRepository.save({ searchEnabled: Boolean(enabled) });
    return this.getSettings();
  }

  /**
   * Show or hide the badge on Google Maps.
   * @param {boolean} enabled
   * @returns {Promise<{searchEnabled: boolean, mapsEnabled: boolean, timeWindow: string, maxMonths: number}>} the settings as now stored
   * @example await settings.setMapsEnabled(false) // Search is unaffected
   */
  async setMapsEnabled(enabled) {
    await this.settingsRepository.save({ mapsEnabled: Boolean(enabled) });
    return this.getSettings();
  }

  async setTimeWindow(timeWindow) {
    if (!isValidTimeWindow(timeWindow)) {
      throw new RangeError(`Unknown time window: ${timeWindow}`);
    }
    await this.settingsRepository.save({ timeWindow });
    return this.getSettings();
  }

  /**
   * The longest window the badge shows, in whole months (2 to 11).
   * @param {number} maxMonths
   * @returns {Promise<{searchEnabled: boolean, mapsEnabled: boolean, timeWindow: string, maxMonths: number}>} the settings as now stored
   * @throws {RangeError} when it is not a whole number from 2 to 11
   * @example await settings.setMaxMonths(4) // the badge then shows 1M / 2M / 4M
   */
  async setMaxMonths(maxMonths) {
    if (!isValidMaxMonths(maxMonths)) {
      throw new RangeError(`Unknown longest window: ${maxMonths}`);
    }
    await this.settingsRepository.save({ maxMonths });
    return this.getSettings();
  }

  /**
   * @param {(settings: {searchEnabled: boolean, mapsEnabled: boolean, timeWindow: string, maxMonths: number}) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    return this.settingsRepository.onChange(async () => listener(await this.getSettings()));
  }
}
