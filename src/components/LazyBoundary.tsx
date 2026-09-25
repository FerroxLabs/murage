// A lazy panel whose chunk failed to load, caught where it happened.
//
// Settings, BotSettings, ComputerPanel, the call screens and the document
// editor load on first use (spec §6). The first failure is usually a new
// build on the computer, and chunk-reload.ts reloads the page once for it. A
// second one inside that minute is left to throw, and with no boundary nearer
// than RootErrorBoundary it took the whole app down (final review M7): on a
// phone, a flaky network while opening Settings twice. This keeps it to the
// panel: "Couldn't open this — tap to retry".
//
// React.lazy remembers a rejected import for good, so a retry needs a fresh
// lazy component. `retryableLazy` hands out one stable component that renders
// whichever lazy is current, and `retry` swaps in a new one.
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

export const LAZY_RETRY_TEXT = "Couldn't open this — tap to retry";

export class LazyBoundary extends Component<
  {
    children: ReactNode;
    onRetry: () => void;
    /** Closes the panel instead, so a retry that keeps failing never
     * leaves the app behind a screen that cannot be dismissed. */
    onDismiss?: () => void;
    /** Inside a pane rather than over the whole app. */
    inline?: boolean;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("murage: a panel could not be loaded", error);
    // Swap in a fresh import now, not on the tap: a panel closed and opened
    // again later starts clean too, instead of replaying the old rejection.
    this.props.onRetry();
  }

  retry = () => {
    this.setState({ failed: false });
  };

  render() {
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
}
