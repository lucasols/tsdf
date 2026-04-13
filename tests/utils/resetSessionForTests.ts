import { opfsOfflineUploadAdapter } from '../../src/main';
import { __resetSessionOfflineCoordinatorRegistryForTests } from '../../src/persistentStorage/offline/sessionCoordinator';
import { __resetSessionProtectedKeysSnapshotForTests } from '../../src/persistentStorage/offline/sessionProtectionRegistry';
import { __resetOfflineUploadRegistryForTests } from '../../src/persistentStorage/offlineUploadRegistry';
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';

export function resetSessionForTests(
  options: { clearStorage?: boolean } = {},
): void {
  __resetSessionOfflineCoordinatorRegistryForTests();
  __resetSessionProtectedKeysSnapshotForTests();
  __resetOfflineUploadRegistryForTests();
  resetExpirationScanTracking();

  if (options.clearStorage) {
    localStorage.clear();
    resetMockBrowserOpfsForTests();
  }

  opfsPersistentStorage.resetForTests?.();
  opfsOfflineUploadAdapter.resetForTests?.();
}
