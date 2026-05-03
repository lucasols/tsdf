import { storeManager } from '../stores/storeManager';

export function AppHeader({
  debugOpen,
  setDebugOpen,
}: {
  debugOpen: boolean;
  setDebugOpen: (value: boolean) => void;
}) {
  return (
    <header className="app-header">
      <div>
        <p className="app-kicker">Orbit Desk</p>
        <h1>Customer operations</h1>
      </div>
      <div className="header-actions">
        <span>{storeManager.getAllStoreIds().length} live stores</span>
        <button
          type="button"
          className={debugOpen ? 'primary-button' : ''}
          onClick={() => setDebugOpen(!debugOpen)}
        >
          {debugOpen ? 'Hide debug' : 'Show debug'}
        </button>
      </div>
    </header>
  );
}
