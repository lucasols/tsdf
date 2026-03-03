import {
  createBrowserTabsPriority,
  type BrowserTabsPriorityOptions,
  type BrowserTabsPriorityTimings,
  type BrowserTabsRemoteLeaseState as BrowserTabsRemoteLeaseStateShape,
  type BrowserTabsTabStatusMessage as BrowserTabsTabStatusMessageShape,
} from './browserTabsPriority';

export type BrowserTabsLeadershipOptions = BrowserTabsPriorityOptions;

export function createBrowserTabsLeadership(
  options: BrowserTabsLeadershipOptions,
) {
  return createBrowserTabsPriority(options);
}

export type BrowserTabsLeadershipTimings = BrowserTabsPriorityTimings;
export type BrowserTabsRemoteLeaseState = BrowserTabsRemoteLeaseStateShape;
export type BrowserTabsTabStatusMessage = BrowserTabsTabStatusMessageShape;
