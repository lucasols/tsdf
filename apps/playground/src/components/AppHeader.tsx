import { useApiFetchCalls } from '../apiFetchCounter';
import { storeManager } from '../stores/storeManager';

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function getMethodCounts(calls: { method: string }[]) {
  const counts = new Map<string, number>();

  for (const call of calls) {
    counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => {
      const aIndex = METHOD_ORDER.indexOf(a.method);
      const bIndex = METHOD_ORDER.indexOf(b.method);

      if (aIndex === -1 && bIndex === -1) {
        return a.method.localeCompare(b.method);
      }

      if (aIndex === -1) {
        return 1;
      }

      if (bIndex === -1) {
        return -1;
      }

      return aIndex - bIndex;
    });
}

export function AppHeader({
  debugOpen,
  setDebugOpen,
}: {
  debugOpen: boolean;
  setDebugOpen: (value: boolean) => void;
}) {
  const apiFetchCalls = useApiFetchCalls();
  const methodCounts = getMethodCounts(apiFetchCalls);

  return (
    <header className="app-header">
      <div>
        <p className="app-kicker">Orbit Desk</p>
        <h1>Customer operations</h1>
      </div>
      <div className="header-actions">
        <span>{storeManager.getAllStoreIds().length} live stores</span>
        <span className="api-fetch-summary">
          <span>{apiFetchCalls.length} API fetches</span>
          {methodCounts.map(({ method, count }) => (
            <strong key={method}>
              {method} {count}
            </strong>
          ))}
        </span>
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
