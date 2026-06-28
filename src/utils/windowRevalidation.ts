/** @internal */
export function isWindowVisible(): boolean {
  return document.visibilityState === 'visible';
}

/** @internal */
export function onWindowVisible(handler: () => void): () => void {
  window.addEventListener('focus', handler);
  window.addEventListener('pageshow', handler);
  window.addEventListener('visibilitychange', handler);
  document.addEventListener('visibilitychange', handler);

  return () => {
    window.removeEventListener('focus', handler);
    window.removeEventListener('pageshow', handler);
    window.removeEventListener('visibilitychange', handler);
    document.removeEventListener('visibilitychange', handler);
  };
}
