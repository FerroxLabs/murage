/** Committed application snapshots shared by selective React readers. */
export function createStoreSubscriptions<S>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    publish(next: S) {
      if (Object.is(state, next)) return;
      state = next;
      for (const listener of listeners) listener();
    },
    select<T>(selector: (state: S) => T) {
      const getSnapshot = () => selector(state);
      return {
        getSnapshot,
        subscribe(listener: () => void) {
          let previous = getSnapshot();
          const changed = () => {
            const next = getSnapshot();
            if (Object.is(previous, next)) return;
            previous = next;
            listener();
          };
          listeners.add(changed);
          return () => { listeners.delete(changed); };
        },
      };
    },
  };
}
