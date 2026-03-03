import { createContext } from 'react';

/**
 * Context to set `isOffScreen` for all TSDF hooks within a subtree.
 *
 * When `true`, hooks wrapped by this context will not trigger data fetching or
 * respond to invalidation events, unless overridden by an explicit `isOffScreen`
 * option passed directly to the hook.
 *
 * @example
 * ```tsx
 * <IsOffScreenContext.Provider value={!isTabActive}>
 *   <MyComponent />
 * </IsOffScreenContext.Provider>
 * ```
 */
export const IsOffScreenContext = createContext<boolean>(false);
