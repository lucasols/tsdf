export type LogEntry = { id: number; time: string; message: string };

export type LogFn = (message: string) => void;

let nextLogId = 1;

export function compactJson(value: unknown): string {
  if (value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogEntry(message: string): LogEntry {
  return {
    id: nextLogId++,
    time: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    message,
  };
}

export function resultSummary(result: {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}): string {
  if (result.ok) {
    return `ok ${compactJson(result.value)}`;
  }

  return `error ${compactJson(result.error)}`;
}
