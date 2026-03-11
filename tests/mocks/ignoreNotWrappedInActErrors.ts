const notWrappedInActMessage = 'was not wrapped in act';

export function ignoreNotWrappedInActErrors() {
  const originalConsoleError = console.error;

  console.error = (...args) => {
    if (
      args.length > 0 &&
      typeof args[0] === 'string' &&
      args[0].includes(notWrappedInActMessage)
    ) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- testing utility only
    originalConsoleError(...args);
  };

  return () => {
    console.error = originalConsoleError;
  };
}
