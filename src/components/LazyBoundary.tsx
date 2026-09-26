// A lazy panel whose chunk failed to load, caught where it happened.
//
// Settings, BotSettings, ComputerPanel, the call screens and the document
// editor load on first use (spec §6). The first failure is usually a new
// build on the computer, and chunk-reload.ts reloads the page once for it. A
// second one inside that minute is left to throw, and with no boundary nearer
// than RootErrorBoundary it took the whole app down (final review M7): on a
// phone, a flaky network while opening Settings twice. This keeps it to the
// panel: "Couldn't open this. Tap to retry.".
//
// "Tap to retry" reloads the whole page. A fresh React.lazy is not enough:
// Chromium caches a failed dynamic import() in the module map, so the same
// URL rejects again without touching the network (phone verification f5,
// Chromium 143). Only a new document gets a new module map. The reload is
// direct, not through chunk-reload.ts, so that module's once-a-minute guard
// (meant for automatic reloads) never blocks a person who asked.
//
// `retryableLazy` still swaps in a fresh lazy when a load fails, which lets a
// browser that does not cache the failure open the panel again after Close.
//
// Only a failed chunk load gets that treatment (0.1.60 audit L1). Any other
// render error used to show the same "Couldn't open this" and, on the tap,
// reload the whole window: that ended a live call, and a panel that always
// throws came straight back after the reload. Such an error now stays in the
// panel with its own words, "Try again" re-renders only the panel, and
// nothing reloads.
import { Component, lazy, type ComponentProps, type ComponentType, type ReactNode } from "react";

export interface RetryableLazy<P extends object> {
  Component: (props: P) => ReactNode;
  retry: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same bound React.lazy uses
export function retryableLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): RetryableLazy<ComponentProps<T>> {
  let current = lazy(load);
  const Component = (props: ComponentProps<T>) => {
    const Current = current as ComponentType<ComponentProps<T>>;
    return <Current {...props} />;
  };
  return {
    Component,
    retry: () => {
      current = lazy(load);
    },
  };
}

export const LAZY_RETRY_TEXT = "Couldn't open this. Tap to retry.";
export const PANEL_ERROR_TEXT = "Something went wrong while showing this, so it couldn't be opened.";
export const PANEL_ERROR_RETRY = "Try again";

/** Whether an error is a lazy chunk that could not be fetched, as each engine
 * words it, or Vite's own preload failure. Nothing else is. */
export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null | undefined;
  if (e?.name === "ChunkLoadError") return true;
  const message = typeof e?.message === "string" ? e.message : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS for|Loading (?:CSS )?chunk \S+ failed/i.test(message);
}

export class LazyBoundary extends Component<
  {
    children: ReactNode;
    onRetry: () => void;
    /** Closes the panel instead, so a retry that keeps failing never
     * leaves the app behind a screen that cannot be dismissed. */
    onDismiss?: () => void;
    /** Inside a pane rather than over the whole app. */
    inline?: boolean;
    /** Test seam; the page reload by default. */
    reload?: () => void;
  },
  { failed: boolean; broken: boolean }
> {
  state = { failed: false, broken: false };

  static getDerivedStateFromError(error: unknown) {
    return isChunkLoadError(error) ? { failed: true, broken: false } : { failed: false, broken: true };
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) {
      console.error("murage: a panel failed to render", error);
      return;
    }
    console.warn("murage: a panel could not be loaded", error);
    // Swap in a fresh import now, not on the tap: a panel closed and opened
    // again later starts clean too, instead of replaying the old rejection.
    this.props.onRetry();
  }

  retry = () => {
    (this.props.reload ?? (() => window.location.reload()))();
  };

  /** A render error: draw the panel again, and only the panel. */
  renderAgain = () => {
    this.setState({ broken: false });
  };

  render() {
    if (this.state.broken) return this.renderBroken();
    if (!this.state.failed) return this.props.children;
    const button = (
      <button
        type="button"
        onClick={this.retry}
        className="min-h-11 rounded-xl border border-hairline/50 bg-card px-4 text-[13px] text-ink shadow-xl hover:bg-raised"
      >
        {LAZY_RETRY_TEXT}
      </button>
    );
    if (this.props.inline) return <div role="alert">{button}</div>;
    const { onDismiss } = this.props;
    return (
      <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/20">
        {button}
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="min-h-11 rounded-xl px-4 text-[13px] text-white/80 hover:text-white">
            Close
          </button>
        )}
      </div>
    );
  }

  renderBroken() {
    const { onDismiss, inline } = this.props;
    const body = (
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-hairline/50 bg-card p-4 text-center shadow-xl">
        <p className="text-[13px] text-ink">{PANEL_ERROR_TEXT}</p>
        <div className="flex gap-2">
          <button type="button" onClick={this.renderAgain} className="min-h-11 rounded-xl border border-hairline/50 bg-card px-4 text-[13px] text-ink hover:bg-raised">
            {PANEL_ERROR_RETRY}
          </button>
          {onDismiss && (
            <button type="button" onClick={onDismiss} className="min-h-11 rounded-xl px-4 text-[13px] text-ink-secondary hover:text-ink">
              Close
            </button>
          )}
        </div>
      </div>
    );
    if (inline) return <div role="alert">{body}</div>;
    return <div role="alert" className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">{body}</div>;
  }
}
