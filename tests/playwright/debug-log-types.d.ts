import type { TSDFDebugLogEntry } from '../../src/main';

declare global {
  interface Window {
    __tsdfDebugLogs?: TSDFDebugLogEntry[];
  }
}

export {};
