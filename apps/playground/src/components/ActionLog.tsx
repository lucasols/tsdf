import type { LogEntry } from '../utils/activityLog';

export function ActionLog({ entries }: { entries: LogEntry[] }) {
  return (
    <aside
      className="activity"
      aria-label="Playground activity log"
    >
      <div className="activity-header">
        <h2>Activity</h2>
        <span>{entries.length} recent</span>
      </div>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <time>{entry.time}</time>
            <span>{entry.message}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}
