import type { ScheduleFetchResults } from '../../src/requestScheduler';
import type { StoreError } from '../../src/utils/storeShared';

export const TEST_INITIAL_TIME = new Date('2025-01-01').getTime();

let defaultLowPriorityThrottleMs = 200;

/** Sets the global default `lowPriorityThrottleMs` used by all test env creators. */
export function setDefaultLowPriorityThrottleMs(ms: number) {
  defaultLowPriorityThrottleMs = ms;
}

/** Returns the current global default `lowPriorityThrottleMs`. */
export function getDefaultLowPriorityThrottleMs() {
  return defaultLowPriorityThrottleMs;
}

/**
 * Custom error class that carries path and method information for testing
 */
export class FetchError extends Error {
  path: string;
  method: StoreError['method'];
  code: number;

  constructor(
    message: string,
    {
      path,
      method = 'GET',
      code = 500,
    }: { path: string; method?: StoreError['method']; code?: number },
  ) {
    super(message);
    this.name = 'FetchError';
    this.path = path;
    this.method = method;
    this.code = code;
  }
}

/**
 * Normalizes an error to StoreError format, extracting path/method if available
 */
export function normalizeError(exception: Error): StoreError {
  if (exception instanceof FetchError) {
    return {
      code: exception.code,
      id: 'fetch-error',
      message: exception.message,
      path: exception.path,
      method: exception.method,
    };
  }

  return { code: 500, id: 'fetch-error', message: exception.message };
}

// Emojis for visual identification in timelines
export const fetchEmojis = [
  '🔴',
  '🟠',
  '🟡',
  '🟢',
  '🔵',
  '🟣',
  '🟤',
  '⚫',
  '⚪',
];
export const mutationEmojis = [
  '⬜',
  '⬛',
  '🟫',
  '🟪',
  '🟦',
  '🟩',
  '🟨',
  '🟧',
  '🟥',
];

export type CommentInput = string | { comment: string; deltaMs?: number };

export type Action = {
  action: string;
  time: number;
  uiValue: unknown;
  actionValue?: unknown;
  id?: string | number;
  itemId?: string;
  /** Batch UI values for multiple items in a single action (e.g. timeline-cleared) */
  itemUiValues?: Record<string, unknown>;
};

export type ActionReference = Pick<Action, 'id' | 'action'>;

/**
 * Creates an action tracker for managing test timeline actions
 */
export function createActionTracker() {
  const actionsHistory: Action[] = [];
  const initialTime = Date.now();

  const pendingBeforeNextActionComments: CommentInput[] = [];
  const pendingActionReferenceComments: Array<{
    reference: ActionReference;
    comments: CommentInput[];
  }> = [];

  function getRelativeTime() {
    return Date.now() - initialTime;
  }

  function flushPendingComments(time: number) {
    for (const comment of pendingBeforeNextActionComments) {
      if (typeof comment === 'string') {
        actionsHistory.push({
          action: `-- ${comment}`,
          time,
          uiValue: undefined,
        });
      } else {
        actionsHistory.push({
          action: `-- ${comment.comment}`,
          time: time + (comment.deltaMs ?? 0),
          uiValue: undefined,
        });
      }
    }
    pendingBeforeNextActionComments.length = 0;
  }

  function addAction(
    action: string,
    {
      uiValue,
      actionValue,
      time = getRelativeTime(),
      id,
      itemId,
    }: {
      uiValue?: unknown;
      actionValue?: unknown;
      time?: number;
      id?: string | number;
      itemId?: string;
    } = {},
  ) {
    if (action === 'scheduled-fetch-started') {
      const relatedFetchStartAction = actionsHistory.find(
        (a) => a.action === '>fetch-started' && time === a.time,
      );

      if (relatedFetchStartAction) {
        relatedFetchStartAction.action =
          '>fetch-started-from-manual-scheduling';
        return;
      }
    }

    flushPendingComments(time);

    actionsHistory.push({ action, time, uiValue, actionValue, id, itemId });
  }

  function addTimelineComments(
    reference: ActionReference | 'afterLastAction' | 'beforeNextAction',
    comments: CommentInput[],
  ): void {
    if (reference === 'beforeNextAction') {
      pendingBeforeNextActionComments.push(...comments);
      return;
    }

    if (reference === 'afterLastAction') {
      const time = actionsHistory.at(-1)?.time ?? 0;

      for (const comment of comments) {
        if (typeof comment === 'string') {
          addAction(`-- ${comment}`, { time });
        } else {
          addAction(`-- ${comment.comment}`, {
            time: time + (comment.deltaMs ?? 0),
          });
        }
      }
      return;
    }

    const matchingAction = actionsHistory.findLast(
      (a) => a.id === reference.id && a.action === reference.action,
    );

    if (!matchingAction) {
      // Defer error checking to timeline generation
      pendingActionReferenceComments.push({ reference, comments });
      return;
    }

    for (const comment of comments) {
      if (typeof comment === 'string') {
        addAction(`-- ${comment}`, { time: matchingAction.time });
      } else {
        addAction(`-- ${comment.comment}`, {
          time: matchingAction.time + (comment.deltaMs ?? 0),
        });
      }
    }
  }

  function getTimelineString(): string {
    // Resolve pending action reference comments
    for (const { reference, comments } of pendingActionReferenceComments) {
      const matchingAction = actionsHistory.findLast(
        (a) => a.id === reference.id && a.action === reference.action,
      );

      if (!matchingAction) {
        throw new Error(
          `No action matching ${JSON.stringify(reference)} found in actions history`,
        );
      }

      for (const comment of comments) {
        if (typeof comment === 'string') {
          actionsHistory.push({
            action: `-- ${comment}`,
            time: matchingAction.time,
            uiValue: undefined,
          });
        } else {
          actionsHistory.push({
            action: `-- ${comment.comment}`,
            time: matchingAction.time + (comment.deltaMs ?? 0),
            uiValue: undefined,
          });
        }
      }
    }
    pendingActionReferenceComments.length = 0;

    if (pendingBeforeNextActionComments.length > 0) {
      throw new Error('Pending before next action comments found');
    }

    return formatTimelineString(actionsHistory);
  }

  function clearTimeline() {
    // Preserve the last UI value per itemId so columns don't reset to '-'
    const lastUIPerItem = new Map<string, unknown>();
    for (const action of actionsHistory) {
      if (action.uiValue !== undefined && action.itemId !== undefined) {
        lastUIPerItem.set(action.itemId, action.uiValue);
      }
    }

    actionsHistory.length = 0;
    pendingBeforeNextActionComments.length = 0;
    pendingActionReferenceComments.length = 0;

    // Re-seed with current UI values at the clear point as a single action
    const time = getRelativeTime();

    if (lastUIPerItem.size > 0) {
      actionsHistory.push({
        action: '-- timeline-cleared',
        time,
        uiValue: undefined,
        itemUiValues: Object.fromEntries(lastUIPerItem),
      });
    } else {
      actionsHistory.push({
        action: '-- timeline-cleared',
        time,
        uiValue: undefined,
      });
    }
  }

  return {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
    clearTimeline,
  };
}

/**
 * Creates a UI change tracker
 */
export function createUITracker<T>(
  addAction: (
    action: string,
    options?: { uiValue?: unknown; time?: number; itemId?: string },
  ) => void,
  getRelativeTime: () => number,
  actionsHistory: Action[],
) {
  const uiChanges: T[] = [];
  let lastTrackedValue: T | undefined;

  function trackUIChanges(value: T, itemId?: string) {
    if (value !== lastTrackedValue) {
      lastTrackedValue = value;
      uiChanges.push(value);

      if (value !== undefined) {
        const time = getRelativeTime();
        if (
          actionsHistory.some(
            (action) =>
              action.action === 'optimistic-ui-commit' &&
              action.time === time &&
              action.uiValue === value,
          )
        ) {
          return;
        }

        addAction(uiChanges.length === 1 ? 'ui-initialized' : 'ui-changed', {
          uiValue: value,
          itemId,
        });
      }
    }
  }

  return { uiChanges, trackUIChanges };
}

export function createPerItemUITracker(
  addAction: (
    action: string,
    options?: { uiValue?: unknown; time?: number; itemId?: string },
  ) => void,
  getRelativeTime: () => number,
  actionsHistory: Action[],
) {
  const itemUIValues: Record<string, unknown> = {};
  const uiChanges: Array<Record<string, unknown>> = [];
  let uiInitialized = false;

  function trackItemUI(itemId: string, value: unknown): unknown {
    const valueToUse = value ?? '···';
    if (itemUIValues[itemId] === valueToUse) return valueToUse;

    itemUIValues[itemId] = valueToUse;
    uiChanges.push({ ...itemUIValues });

    const time = getRelativeTime();

    if (
      actionsHistory.some(
        (action) =>
          action.action === 'optimistic-ui-commit' &&
          action.time === time &&
          action.uiValue === valueToUse &&
          action.itemId === itemId,
      )
    ) {
      return valueToUse;
    }

    addAction(!uiInitialized ? 'ui-initialized' : 'ui-changed', {
      uiValue: valueToUse,
      itemId,
    });
    uiInitialized = true;
    return valueToUse;
  }

  return { uiChanges, trackItemUI };
}

/**
 * Creates emoji cyclers for fetches and mutations
 */
export function createEmojiCyclers() {
  let fetchIdCounter = 0;
  let mutationIdCounter = 0;

  return {
    getFetchEmoji: () => fetchEmojis[fetchIdCounter++ % fetchEmojis.length],
    getMutationEmoji: () =>
      mutationEmojis[mutationIdCounter++ % mutationEmojis.length],
  };
}

/**
 * Creates a fetch counter
 */
export function createFetchCounter() {
  let numOfFetches = 0;
  let numOfStartedFetches = 0;

  return {
    get numOfFinishedFetches() {
      return numOfFetches;
    },
    get numOfStartedFetches() {
      return numOfStartedFetches;
    },
    incrementStarted: () => numOfStartedFetches++,
    incrementFinished: () => numOfFetches++,
  };
}

/**
 * Logs schedule fetch result as an action
 */
export function logScheduleFetchResult(
  result: ScheduleFetchResults,
  addAction: (action: string) => void,
) {
  switch (result) {
    case 'started':
      addAction('scheduled-fetch-started');
      break;
    case 'skipped':
      addAction('scheduled-fetch-skipped');
      break;
    case 'scheduled':
      addAction('scheduled-fetch-scheduled');
      break;
    case 'rt-scheduled':
      addAction('rt-fetch-scheduled');
      break;
    case 'triggered':
      addAction('scheduled-fetch-triggered');
      break;
    case 'coalesced':
      addAction('scheduled-fetch-coalesced');
      break;
    case 'medium-scheduled':
      addAction('medium-fetch-scheduled');
      break;
  }
}

/**
 * Logs scheduler events as actions
 */
export function logSchedulerEvent(
  event: string,
  addAction: (action: string) => void,
  data?: { delayMs?: number },
) {
  switch (event) {
    case 'scheduled-rt-fetch-started':
      addAction('scheduled-rt-fetch-started');
      break;
    case 'medium-priority-scheduled':
      addAction(
        data?.delayMs !== undefined
          ? `medium-fetch-scheduled (delay: ${data.delayMs}ms)`
          : 'medium-fetch-scheduled',
      );
      break;
    case 'medium-priority-fetch-started':
      addAction('medium-priority-fetch-started');
      break;
    case 'medium-priority-cancelled':
      addAction('medium-priority-cancelled');
      break;
  }
}

// Timeline formatting utilities

const secondsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

export function formatTimeMs(ms: number): string {
  if (ms === 0) return '0';
  if (ms >= 1000) return `${secondsFormatter.format(ms / 1000)}s`;
  return `${ms}ms`;
}

function formatTime(ms: number, prevMs: number | undefined): string {
  if (prevMs !== undefined && ms === prevMs) return '.';
  return formatTimeMs(ms);
}

function formatId(id: string | number | undefined): string {
  if (id === undefined) return '';
  return `${id} `;
}

export function formatTimelineString(actionsHistory: Action[]): string {
  if (actionsHistory.length === 0) return '\n\n';

  // Sort actions by time, preserving insertion order for same-time events
  const sortedActions = [...actionsHistory].sort((a, b) => a.time - b.time);

  // Collect unique itemIds to create per-item UI columns
  const itemIds = new Set<string>();
  for (const action of sortedActions) {
    if (action.itemId !== undefined) {
      itemIds.add(action.itemId);
    }
    if (action.itemUiValues) {
      for (const key of Object.keys(action.itemUiValues)) {
        itemIds.add(key);
      }
    }
  }

  const hasItemIds = itemIds.size > 0;

  if (hasItemIds) {
    return formatMultiItemTimelineString(
      sortedActions,
      Array.from(itemIds).sort(),
    );
  }

  // Check if any action has UI values
  const hasUIValues = sortedActions.some((a) => a.uiValue !== undefined);

  let currentUI: unknown = undefined;
  let prevTime: number | undefined = undefined;

  const headerCols = hasUIValues ? ['time', 'ui', ''] : ['time', ''];
  const rows: Array<{ cols: string[] }> = [{ cols: headerCols }];

  for (const { action, time, uiValue, actionValue, id } of sortedActions) {
    if (uiValue !== undefined) currentUI = uiValue;

    const timeStr = formatTime(time, prevTime);

    const idStr = formatId(id);
    let actionStr = `${idStr}${action}`;
    if (actionValue !== undefined) {
      actionStr += ` (value: ${JSON.stringify(actionValue)})`;
    }

    if (hasUIValues) {
      const uiStr = currentUI !== undefined ? JSON.stringify(currentUI) : '-';
      rows.push({ cols: [timeStr, uiStr, actionStr] });
    } else {
      rows.push({ cols: [timeStr, actionStr] });
    }

    prevTime = time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
}

function formatMultiItemTimelineString(
  sortedActions: Action[],
  itemIds: string[],
): string {
  // Only create columns for itemIds that have at least one tracked UI value
  const itemIdsWithUI = itemIds.filter((id) =>
    sortedActions.some(
      (a) =>
        (a.itemId === id && a.uiValue !== undefined) ||
        (a.itemUiValues && id in a.itemUiValues),
    ),
  );

  const currentUIPerItem: Record<string, unknown> = {};
  for (const itemId of itemIdsWithUI) {
    currentUIPerItem[itemId] = undefined;
  }

  const showItemIdInAction = itemIds.length > 1;
  let prevTime: number | undefined = undefined;

  const rows: Array<{ cols: string[] }> = [
    { cols: ['time', ...itemIdsWithUI, ''] },
  ];

  // Group consecutive actions that can be merged into a single row:
  // same time, same action string, different itemIds, no actionValue
  const groups: Action[][] = [];
  for (const entry of sortedActions) {
    const prev = groups[groups.length - 1];
    const prevEntry = prev?.[prev.length - 1];

    const normalizeEntryAction =
      entry.action === 'ui-initialized' ? 'ui-changed' : entry.action;
    const normalizePrevEntryAction =
      prevEntry?.action === 'ui-initialized' ? 'ui-changed' : prevEntry?.action;

    if (
      prevEntry &&
      showItemIdInAction &&
      entry.time === prevEntry.time &&
      normalizeEntryAction === normalizePrevEntryAction &&
      entry.itemId !== undefined &&
      prevEntry.itemId !== undefined &&
      entry.actionValue === undefined &&
      prevEntry.actionValue === undefined &&
      entry.id === prevEntry.id
    ) {
      prev.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  for (const group of groups) {
    // Apply all UI updates in the group
    for (const { uiValue, itemId, itemUiValues } of group) {
      if (itemUiValues) {
        for (const [batchItemId, batchValue] of Object.entries(itemUiValues)) {
          currentUIPerItem[batchItemId] = batchValue;
        }
      } else if (uiValue !== undefined && itemId !== undefined) {
        currentUIPerItem[itemId] = uiValue;
      }
    }

    const first = group[0];
    if (!first) continue;
    const timeStr = formatTime(first.time, prevTime);

    // Create UI columns for each item with tracked values
    const uiCols = itemIdsWithUI.map((colItemId) => {
      const val = currentUIPerItem[colItemId];
      if (val === undefined) return '-';
      if (typeof val === 'number' || typeof val === 'string')
        return String(val);
      return JSON.stringify(val);
    });

    const idStr = formatId(first.id);

    let itemIdStr = '';
    if (showItemIdInAction && group.length > 1) {
      const mergedIds = group
        .map((a) => a.itemId)
        .filter((id) => id !== undefined);
      itemIdStr = `[${mergedIds.join(', ')}] `;
    } else if (showItemIdInAction && first.itemId !== undefined) {
      itemIdStr = `[${first.itemId}] `;
    }

    let actionStr = `${idStr}${itemIdStr}${first.action}`;
    if (first.actionValue !== undefined) {
      actionStr += ` (value: ${JSON.stringify(first.actionValue)})`;
    }

    rows.push({ cols: [timeStr, ...uiCols, actionStr] });
    prevTime = first.time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
}

function formatTableString(
  rows: Array<{ cols: string[]; separator?: string }>,
): string {
  if (rows.length === 0) return '';

  const colWidths: number[] = [];
  for (const { cols } of rows) {
    for (const [i, col] of cols.entries()) {
      colWidths[i] = Math.max(colWidths[i] ?? 0, col.length);
    }
  }

  return rows
    .map(({ cols, separator = '|' }) =>
      cols
        .map((col, i) => col.padEnd(colWidths[i] ?? 0))
        .join(` ${separator} `)
        .trimEnd(),
    )
    .join('\n');
}
