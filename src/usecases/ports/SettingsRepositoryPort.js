/**
 * Port: persistence for user preferences.
 *
 * @typedef {Object} StoredSettings  (possibly partial / untrusted)
 * @property {boolean} [searchEnabled]
 * @property {boolean} [mapsEnabled]
 * @property {boolean} [isEnabled]  Legacy single switch: still read, never written.
 * @property {string}  [timeWindow]
 */
export class SettingsRepositoryPort {
  /** @returns {Promise<StoredSettings>} */
  async load() {
    throw new Error('SettingsRepositoryPort.load() not implemented');
  }

  /** @param {StoredSettings} partial @returns {Promise<void>} */
  async save(partial) { // eslint-disable-line no-unused-vars
    throw new Error('SettingsRepositoryPort.save() not implemented');
  }

  /**
   * Notify when settings change anywhere (e.g. popup -> content script).
   * @param {() => void} listener
   * @returns {() => void} unsubscribe
   */
  onChange(listener) { // eslint-disable-line no-unused-vars
    throw new Error('SettingsRepositoryPort.onChange() not implemented');
  }
}
