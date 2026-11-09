// An in-memory store for mounted U19 consumer tests. No provider or live data.
import { useSyncExternalStore, type ReactNode } from "react";
import { initialState, reducer, type AppState, type Bot } from "../state/store";
import { TERMS_VERSION } from "../../shared/terms";
export * from "../state/store";

const bot = (id: string, section: string, extra: Partial<Bot> = {}): Bot => ({
  id, name: "Same name", section, threadId: `thread-${id}`, messages: [], title: "", description: "", notifications: false,
  color: "orange", unread: false, modelSelection: { instanceId: "fixture", model: "fake" }, ...extra,
});
let state: AppState = {
  ...initialState, hydrated: true, selectedId: "a",
  bots: [bot("a", "Alpha"), bot("b", "Beta"), bot("h", "Beta", { sidebarHidden: true })],
  sidebarSectionOrder: ["section:Alpha", "section:Beta"],
};
const listeners = new Set<() => void>();
const actions: unknown[] = [];
let failSave: (() => void) | undefined;
function patch(next: Partial<AppState>) { state = { ...state, ...next }; listeners.forEach((fn) => fn()); }
function dispatch(action: Parameters<typeof reducer>[1]) {
  actions.push(action);
  patch(reducer(state, action));
}
export function useStore() {
  return { state: useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state), dispatch };
}
export const useStoreIfAny = useStore;
export function useStoreActions() { return { dispatch }; }
export function StoreProvider({ children }: { children: ReactNode }) { return children; }
export async function api(path: string) {
  if (path === "/api/terms") return { accepted: true, version: TERMS_VERSION };
  if (path === "/api/sidebar-sections") return new Promise((_resolve, reject) => { failSave = () => reject(new Error("fixture save failed")); });
  if (path === "/api/setup") return { firstRun: false, next: "done", checklist: [] };
  return {};
}
Object.assign(window, { u19: { patch, actions, state: () => state, failSave: () => failSave?.() } });

// G27 (66c341b84): ChatView reads through useStoreSelector/useStoreSnapshot; serve them from the same in-memory store.
const selectorCache = new WeakMap<(s: AppState) => unknown, { source: AppState; value: unknown }>();
export function useStoreSelector<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => {
      const hit = selectorCache.get(select);
      if (hit && hit.source === state) return hit.value as T;
      const value = select(state);
      selectorCache.set(select, { source: state, value });
      return value;
    },
  );
}
export function useStoreSnapshot() { return () => state; }
export function useStoreActionsIfAny() { return { dispatch }; }
