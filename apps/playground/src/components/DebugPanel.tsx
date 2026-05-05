import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ATLAS_PROJECT_PAYLOAD,
  getProjectLabel,
  PROJECT_PAYLOADS,
  type Contact,
  type ContactFilter,
} from '../apiTypes';
import {
  contactListStore,
  createContact,
  deleteContact,
  renameContact,
  toggleContactStatus,
} from '../stores/contactListStore';
import {
  addLocalProfileTag,
  profileStore,
  pushProfileTagFromServer,
} from '../stores/profileStore';
import {
  addLocalDraftProject,
  deleteLocalDraftProject,
  projectStore,
} from '../stores/projectStore';
import {
  clearPlaygroundStorage,
  getPlaygroundDebugEntries,
  resetPlaygroundStores,
  storeManager,
  subscribePlaygroundDebugEntries,
} from '../stores/storeManager';
import {
  compactJson,
  resultSummary,
  type LogEntry,
  type LogFn,
} from '../utils/activityLog';
import { ActionLog } from './ActionLog';
import { ApiCallsPanel } from './ApiCallsPanel';
import { Metric } from './common';

const CONTACT_ROW_FIELDS = ['id', 'name', 'team', 'status'];
const CONTACT_CARD_FIELDS = ['id', 'name', 'email', 'status'];
const DEFAULT_FILTER = { team: 'all', status: 'all' } satisfies ContactFilter;

function getDetailString(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = details?.[key];
  return typeof value === 'string' ? value : String(value ?? 'none');
}

function getDetailBoolean(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = details?.[key];
  return value === true ? 'yes' : value === false ? 'no' : 'none';
}

function getShortTabId(value: string): string {
  if (value === 'none') return value;
  return value.slice(-8);
}

function TabSyncProbe() {
  const debugEntries = useSyncExternalStore(
    subscribePlaygroundDebugEntries,
    getPlaygroundDebugEntries,
    getPlaygroundDebugEntries,
  );
  const latestLeaderChange = useMemo(
    () => debugEntries.find((entry) => entry.operation === 'leader-change'),
    [debugEntries],
  );
  const [eventCounts, setEventCounts] = useState(() => ({
    blur: 0,
    focus: 0,
    hasFocus: document.hasFocus(),
  }));

  useEffect(() => {
    function update(kind: 'blur' | 'focus') {
      setEventCounts((current) => ({
        blur: current.blur + (kind === 'blur' ? 1 : 0),
        focus: current.focus + (kind === 'focus' ? 1 : 0),
        hasFocus: document.hasFocus(),
      }));
    }

    const onFocus = () => update('focus');
    const onBlur = () => update('blur');

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const details = latestLeaderChange?.details;
  const localTabId = getShortTabId(getDetailString(details, 'localTabId'));
  const leaderTabId = getShortTabId(getDetailString(details, 'leaderTabId'));

  return (
    <section className="tab-sync-probe">
      <h3>Tab sync</h3>
      <div className="debug-related">
        <div>
          <span>Leader</span>
          <strong>{leaderTabId}</strong>
        </div>
        <div>
          <span>Local tab</span>
          <strong>{localTabId}</strong>
        </div>
        <div>
          <span>Local leader</span>
          <strong>{getDetailBoolean(details, 'isLocalLeader')}</strong>
        </div>
        <div>
          <span>Rank</span>
          <strong>{getDetailString(details, 'localRank')}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{getDetailString(details, 'reason')}</strong>
        </div>
        <div>
          <span>Focus events</span>
          <strong>{eventCounts.focus}</strong>
        </div>
        <div>
          <span>Blur events</span>
          <strong>{eventCounts.blur}</strong>
        </div>
        <div>
          <span>Has focus</span>
          <strong>{eventCounts.hasFocus ? 'yes' : 'no'}</strong>
        </div>
      </div>
    </section>
  );
}

export function DebugPanel({
  entries,
  log,
  onClose,
}: {
  entries: LogEntry[];
  log: LogFn;
  onClose: () => void;
}) {
  const [selectedContactId, setSelectedContactId] = useState('ada');
  const offlineStatus = storeManager.useOfflineStatus();
  const queryItemSelector = useCallback(
    (item: Contact) => item.name ?? item.id,
    [],
  );
  const multipleItemSelector = useCallback(
    (item: Contact | null) => item?.name ?? 'Loading',
    [],
  );
  const pendingOfflineItemSelector = useCallback(
    (item: Contact) => item.name ?? item.id,
    [],
  );
  const multipleQueriesOptions = useMemo(
    () => ({ itemSelector: queryItemSelector }),
    [queryItemSelector],
  );
  const multipleItemsOptions = useMemo(
    () => ({ selector: multipleItemSelector, showPartialAsRefetching: true }),
    [multipleItemSelector],
  );
  const pendingOfflineItemsOptions = useMemo(
    () => ({ selector: pendingOfflineItemSelector }),
    [pendingOfflineItemSelector],
  );
  const overviewQueries = useMemo(
    () => [
      {
        payload: { team: 'all', status: 'active' } satisfies ContactFilter,
        fields: CONTACT_ROW_FIELDS,
        queryMetadata: { label: 'Active' },
      },
      {
        payload: { team: 'design', status: 'all' } satisfies ContactFilter,
        fields: CONTACT_ROW_FIELDS,
        queryMetadata: { label: 'Design' },
      },
    ],
    [],
  );
  const pinnedItems = useMemo(
    () => [
      {
        payload: selectedContactId,
        fields: CONTACT_CARD_FIELDS,
        queryMetadata: { label: 'Selected' },
      },
      {
        payload: 'maya',
        fields: CONTACT_CARD_FIELDS,
        queryMetadata: { label: 'Pinned' },
      },
    ],
    [selectedContactId],
  );
  const multipleQueries = contactListStore.useMultipleListQueries(
    overviewQueries,
    multipleQueriesOptions,
  );
  const multipleItems = contactListStore.useMultipleItems(
    pinnedItems,
    multipleItemsOptions,
  );
  const pendingOfflineItems = contactListStore.usePendingOfflineItems(
    pendingOfflineItemsOptions,
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="debug-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        className="debug-panel"
        role="dialog"
        aria-modal="true"
        aria-label="TSDF debug panel"
      >
        <div className="debug-header">
          <div>
            <p className="app-kicker">Debug</p>
            <h2>TSDF controls</h2>
          </div>
          <div className="debug-title-actions">
            <Metric
              label="Stores"
              value={storeManager.getAllStoreIds().length}
            />
            <button
              type="button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="debug-grid">
          <TabSyncProbe />

          <section>
            <h3>Manager</h3>
            <pre>{compactJson(offlineStatus)}</pre>
            <div className="button-grid debug-buttons">
              <button
                type="button"
                onClick={() => {
                  storeManager.onTransportReconnect();
                  log('manager.onTransportReconnect() broadcast');
                }}
              >
                Transport reconnect
              </button>
              <button
                type="button"
                onClick={() => {
                  resetPlaygroundStores();
                  log('storeManager.resetAll([])');
                }}
              >
                Reset stores
              </button>
              <button
                type="button"
                onClick={() => {
                  void clearPlaygroundStorage().then(() => {
                    resetPlaygroundStores();
                    log('persistent storage cleared');
                  });
                }}
              >
                Clear storage
              </button>
            </div>
          </section>

          <ApiCallsPanel />

          <section>
            <h3>Document store</h3>
            <div className="button-grid debug-buttons">
              <button
                type="button"
                onClick={() => {
                  const result = profileStore.scheduleFetch('highPriority');
                  log(
                    `profileStore.scheduleFetch('highPriority') -> ${result}`,
                  );
                }}
              >
                Schedule fetch
              </button>
              <button
                type="button"
                onClick={() => {
                  void profileStore
                    .getDataFromStateOrFetch({ ignoreStaleState: true })
                    .then((result) => {
                      log(
                        `profileStore.getDataFromStateOrFetch() -> ${resultSummary(result)}`,
                      );
                    });
                }}
              >
                Get or fetch
              </button>
              <button
                type="button"
                onClick={() => {
                  void profileStore
                    .awaitFetch({ timeoutMs: 1_500 })
                    .then((result) => {
                      log(
                        result.error
                          ? `profileStore.awaitFetch() -> ${result.error.message}`
                          : `profileStore.awaitFetch() -> ${result.data.name}`,
                      );
                    });
                }}
              >
                Await fetch
              </button>
              <button
                type="button"
                onClick={() => {
                  const updated = addLocalProfileTag();
                  log(`addLocalProfileTag() -> ${String(updated)}`);
                }}
              >
                Local update
              </button>
              <button
                type="button"
                onClick={() => {
                  void pushProfileTagFromServer('Server pushed');
                }}
              >
                Realtime update
              </button>
              <button
                type="button"
                onClick={() => {
                  void profileStore.preloadPersistentStorage().then(() => {
                    log('profileStore.preloadPersistentStorage() completed');
                  });
                }}
              >
                Preload storage
              </button>
            </div>
          </section>

          <section>
            <h3>Collection store</h3>
            <div className="button-grid debug-buttons">
              <button
                type="button"
                onClick={() => {
                  const result = projectStore.scheduleFetch(
                    'highPriority',
                    PROJECT_PAYLOADS,
                  );
                  log(
                    `projectStore.scheduleFetch(batch) -> ${compactJson(result)}`,
                  );
                }}
              >
                Batch fetch
              </button>
              <button
                type="button"
                onClick={() => {
                  void projectStore
                    .getItemFromStateOrFetch(ATLAS_PROJECT_PAYLOAD, {
                      ignoreStaleState: true,
                    })
                    .then((result) => {
                      log(
                        `projectStore.getItemFromStateOrFetch() -> ${resultSummary(result)}`,
                      );
                    });
                }}
              >
                Get or fetch
              </button>
              <button
                type="button"
                onClick={() => {
                  void projectStore
                    .awaitFetch(ATLAS_PROJECT_PAYLOAD)
                    .then((result) => {
                      log(
                        result.error
                          ? `projectStore.awaitFetch() -> ${result.error.message}`
                          : `projectStore.awaitFetch() -> ${result.data.name}`,
                      );
                    });
                }}
              >
                Await item
              </button>
              <button
                type="button"
                onClick={() => {
                  addLocalDraftProject();
                  log('addLocalDraftProject()');
                }}
              >
                Add local item
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteLocalDraftProject();
                  log('deleteLocalDraftProject()');
                }}
              >
                Delete local item
              </button>
              <button
                type="button"
                onClick={() => {
                  projectStore.invalidateItem(
                    ATLAS_PROJECT_PAYLOAD,
                    'realtimeUpdate',
                  );
                  log(
                    `projectStore.invalidateItem(${getProjectLabel(ATLAS_PROJECT_PAYLOAD)})`,
                  );
                }}
              >
                Invalidate item
              </button>
            </div>
          </section>

          <section>
            <h3>List query store</h3>
            <div className="debug-related">
              {multipleQueries.map((overview) => (
                <div key={overview.queryKey}>
                  <span>
                    {overview.queryMetadata.label}
                    {overview.isDerived ? ' derived' : ''}
                  </span>
                  <strong>
                    {overview.items.join(', ') || overview.status}
                  </strong>
                </div>
              ))}
              {multipleItems.map((item) => (
                <div key={`${item.queryMetadata.label}:${item.itemStateKey}`}>
                  <span>{item.queryMetadata.label}</span>
                  <strong>{item.data}</strong>
                </div>
              ))}
              <div>
                <span>Pending offline</span>
                <strong>
                  {pendingOfflineItems.items.length} item,{' '}
                  {pendingOfflineItems.deletedItems.length} deleted
                </strong>
              </div>
            </div>
            <label className="field">
              Debug contact id
              <input
                value={selectedContactId}
                onChange={(event) =>
                  setSelectedContactId(event.currentTarget.value)
                }
              />
            </label>
            <div className="button-grid debug-buttons">
              <button
                type="button"
                onClick={() => {
                  const result = contactListStore.scheduleListQueryFetch(
                    'highPriority',
                    DEFAULT_FILTER,
                    4,
                    { fields: CONTACT_ROW_FIELDS },
                  );
                  log(`contactListStore.scheduleListQueryFetch() -> ${result}`);
                }}
              >
                Fetch query
              </button>
              <button
                type="button"
                onClick={() => {
                  void contactListStore
                    .awaitListQueryFetch(DEFAULT_FILTER, {
                      size: 4,
                      timeoutMs: 1_500,
                      fields: '*',
                    })
                    .then((result) => {
                      log(
                        result.error
                          ? `contactListStore.awaitListQueryFetch() -> ${result.error.message}`
                          : `contactListStore.awaitListQueryFetch() -> ${result.items.length} items`,
                      );
                    });
                }}
              >
                Await query
              </button>
              <button
                type="button"
                onClick={() => {
                  void contactListStore
                    .getQueryFromStateOrFetch(DEFAULT_FILTER, {
                      ignoreStaleState: true,
                      fields: '*',
                    })
                    .then((result) => {
                      log(
                        `contactListStore.getQueryFromStateOrFetch() -> ${resultSummary(result)}`,
                      );
                    });
                }}
              >
                Get query
              </button>
              <button
                type="button"
                onClick={() => {
                  contactListStore.scheduleItemFetch(
                    'highPriority',
                    selectedContactId,
                    { fields: '*' },
                  );
                }}
              >
                Fetch item
              </button>
              <button
                type="button"
                onClick={() => {
                  void contactListStore
                    .awaitItemFetch(selectedContactId, {
                      fields: '*',
                      timeoutMs: 1_500,
                    })
                    .then((result) => {
                      log(
                        result.error
                          ? `contactListStore.awaitItemFetch() -> ${result.error.message}`
                          : `contactListStore.awaitItemFetch() -> ${result.data.name}`,
                      );
                    });
                }}
              >
                Await item
              </button>
              <button
                type="button"
                onClick={() => {
                  void renameContact(selectedContactId, 'Renamed from debug');
                }}
              >
                Rename item
              </button>
              <button
                type="button"
                onClick={() => {
                  void toggleContactStatus(selectedContactId);
                }}
              >
                Toggle status
              </button>
              <button
                type="button"
                onClick={() => {
                  void createContact().then((contact) => {
                    if (contact) setSelectedContactId(contact.id);
                  });
                }}
              >
                Create item
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteContact(selectedContactId);
                }}
              >
                Delete item
              </button>
              <button
                type="button"
                onClick={() => {
                  contactListStore.invalidateQueryAndItems({
                    queryPayload: false,
                    itemPayload: selectedContactId,
                    fields: ['email'],
                    type: 'highPriority',
                  });
                }}
              >
                Invalidate field
              </button>
              <button
                type="button"
                onClick={() => {
                  const related =
                    contactListStore.getQueriesRelatedToItem(selectedContactId);
                  log(
                    `contactListStore.getQueriesRelatedToItem() -> ${
                      related
                        .map(
                          ({ query }) =>
                            `${query.payload.team}/${query.payload.status}`,
                        )
                        .join(', ') || 'none'
                    }`,
                  );
                }}
              >
                Related queries
              </button>
              <button
                type="button"
                onClick={() => {
                  void Promise.all([
                    contactListStore.preloadQueryFromStorage(DEFAULT_FILTER),
                    contactListStore.preloadItemFromStorage(selectedContactId),
                  ]).then(([queries, items]) => {
                    log(
                      `contactListStore.preload*FromStorage() -> ${queries.length} query, ${items.length} item`,
                    );
                  });
                }}
              >
                Preload storage
              </button>
            </div>
          </section>
        </div>

        <ActionLog entries={entries} />
      </aside>
    </div>
  );
}
