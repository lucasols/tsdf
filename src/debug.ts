/** Debug log severity used to choose the default console method. */
export type TSDFDebugLogLevel = 'log' | 'warn' | 'error';

/** Internal subsystem that emitted a debug log entry. */
export type TSDFDebugLogArea = 'browser-tabs' | 'focus' | 'persistent-storage';

/** Operations emitted by focus lifecycle handling. */
export type TSDFFocusDebugOperation = 'window-focus-revalidate';

/** Operations emitted by the persistent storage subsystem. */
export type TSDFPersistentStorageDebugOperation =
  | 'clear'
  | 'commit'
  | 'list-keys'
  | 'list-metadata'
  | 'list-metadata-by-filter'
  | 'load'
  | 'load-many'
  | 'read-entry'
  | 'read-protected-keys'
  | 'remove'
  | 'save'
  | 'schedule-save'
  | 'sync-load'
  | 'sync-protected-keys'
  | 'write';

/** Operations emitted by the browser-tab sync subsystem. */
export type TSDFBrowserTabsDebugOperation =
  | 'leader-change'
  | 'publish'
  | 'publish-skipped'
  | 'receive'
  | 'receive-skipped'
  | 'session-change'
  | 'transport-close'
  | 'transport-open'
  | 'transport-unavailable';

/** Structured debug log entry emitted by TSDF internals. */
export type TSDFDebugLogEntry = {
  /** Subsystem that emitted the entry. */
  area: TSDFDebugLogArea;
  /** Severity of the entry. */
  level: TSDFDebugLogLevel;
  /** Human-readable summary of the operation. */
  message: string;
  /** Stable operation id, such as `publish`, `load`, or `write`. */
  operation:
    | TSDFFocusDebugOperation
    | TSDFPersistentStorageDebugOperation
    | TSDFBrowserTabsDebugOperation;
  /** Structured operation metadata for filtering and diagnostics. */
  details?: Readonly<Record<string, unknown>>;
};

function defaultConsoleDebugLogger(entry: TSDFDebugLogEntry): void {
  if (import.meta.env.DEV) {
    const consoleForLevel = globalThis.console[entry.level];
    if (typeof consoleForLevel !== 'function') return;

    const details = entry.details
      ? { operation: entry.operation, ...entry.details }
      : { operation: entry.operation };

    consoleForLevel(`[tsdf:${entry.area}] ${entry.message}`, details);
  }
}

/** Custom debug logger invoked for each emitted TSDF debug entry. */
export type TSDFDebugLogger = (entry: TSDFDebugLogEntry) => void;

/** Enables manager-wide debug logging for browser-tab sync and persistence. */
export type TSDFDebugOptions = boolean | TSDFDebugLogger;

export function resolveTSDFDebugLogger(
  debug: TSDFDebugOptions | undefined,
): TSDFDebugLogger | undefined {
  if (!import.meta.env.DEV) return undefined;
  if (debug === undefined || debug === false) return undefined;
  if (debug === true) return defaultConsoleDebugLogger;
  return debug;
}

export function emitTSDFDebugLog(
  logger: TSDFDebugLogger | undefined,
  entry: TSDFDebugLogEntry,
): void {
  if (import.meta.env.DEV) {
    if (!logger) return;

    try {
      logger(entry);
    } catch (error) {
      globalThis.console.error('[tsdf:debug] Debug logger failed', error);
    }
  }
}

export function getTSDFDebugTimingMs(): number {
  if (!import.meta.env.DEV) return 0;
  return Date.now();
}
