import { useCallback, useState } from 'react';
import { AccountPanel } from './components/AccountPanel';
import { AppHeader } from './components/AppHeader';
import { ContactsPanel } from './components/ContactsPanel';
import { DebugPanel } from './components/DebugPanel';
import { ProjectsPanel } from './components/ProjectsPanel';
import { useRealtimeEvents } from './hooks/useRealtimeEvents';
import { useStoreEventLog } from './hooks/useStoreEventLog';
import { createLogEntry, type LogEntry, type LogFn } from './utils/activityLog';

export function App() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const log = useCallback<LogFn>((message) => {
    setEntries((current) => [createLogEntry(message), ...current].slice(0, 18));
  }, []);

  useStoreEventLog(log);
  useRealtimeEvents(log);

  return (
    <main>
      <AppHeader
        debugOpen={debugOpen}
        setDebugOpen={setDebugOpen}
      />
      <AccountPanel />
      <div className="app-grid">
        <ProjectsPanel />
        <ContactsPanel />
      </div>
      {debugOpen ? (
        <DebugPanel
          entries={entries}
          log={log}
          onClose={() => setDebugOpen(false)}
        />
      ) : null}
    </main>
  );
}
