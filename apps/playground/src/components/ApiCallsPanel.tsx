import { clearApiFetchCalls, useApiFetchCalls } from '../apiFetchCounter';
import { Metric } from './common';

export function ApiCallsPanel() {
  const apiFetchCalls = useApiFetchCalls();

  return (
    <section className="api-calls-section">
      <div className="activity-header">
        <h3>API calls</h3>
        <div className="api-calls-actions">
          <button
            type="button"
            disabled={apiFetchCalls.length === 0}
            onClick={clearApiFetchCalls}
          >
            Clear
          </button>
          <Metric
            label="Total"
            value={apiFetchCalls.length}
          />
        </div>
      </div>
      <ol className="api-call-list">
        {apiFetchCalls.length === 0 ? (
          <li>
            <span>No API calls yet</span>
          </li>
        ) : (
          apiFetchCalls.map((call) => (
            <li key={call.id}>
              <span>
                <strong>{call.method}</strong> {call.path}
              </span>
              <em className={`api-call-status api-call-${call.status}`}>
                {call.status}
                {call.errorStatus ? ` ${call.errorStatus}` : ''}
              </em>
              <time>
                {new Date(call.startedAt).toLocaleTimeString()}
                {call.durationMs === undefined ? '' : ` · ${call.durationMs}ms`}
              </time>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
