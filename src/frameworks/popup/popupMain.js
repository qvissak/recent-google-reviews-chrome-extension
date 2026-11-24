import { ManageExtensionSettingsUseCase } from '../../usecases/ManageExtensionSettingsUseCase.js';
import { ChromeStorageSettingsDao } from '../../adapters/dao/ChromeStorageSettingsDao.js';
import { PopupController } from './PopupController.js';

new PopupController({
  document,
  settingsUseCase: new ManageExtensionSettingsUseCase({
    settingsRepository: new ChromeStorageSettingsDao(),
  }),
}).init();
