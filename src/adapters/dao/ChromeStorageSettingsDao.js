import { SettingsRepositoryPort } from '../../usecases/ports/SettingsRepositoryPort.js';

const KEYS = ['searchEnabled', 'mapsEnabled', 'timeWindow', 'maxMonths'];
// The old single on/off switch is still read so the use case can carry it over; nothing writes it any more.
const READ_KEYS = [...KEYS, 'isEnabled'];

/** Persists settings in chrome.storage.sync. The storage API is injected for testability. */
export class ChromeStorageSettingsDao extends SettingsRepositoryPort {
  /**
   * @param {{ storage?: typeof chrome.storage }} [deps]
   */
  constructor({ storage = globalThis.chrome?.storage } = {}) {
    super();
    this.storage = storage;
  }

  async load() {
    if (!this.storage?.sync) return {};
    return this.storage.sync.get(READ_KEYS);
  }

  async save(partial) {
    if (!this.storage?.sync) return;
    const filtered = Object.fromEntries(Object.entries(partial).filter(([k]) => KEYS.includes(k)));
    await this.storage.sync.set(filtered);
  }

  onChange(listener) {
    if (!this.storage?.onChanged) return () => {};
    const handler = (changes, area) => {
      if (area === 'sync' && KEYS.some((k) => k in changes)) listener();
    };
    this.storage.onChanged.addListener(handler);
    return () => this.storage.onChanged.removeListener(handler);
  }
}
