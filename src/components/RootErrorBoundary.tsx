import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The one boundary above the whole tree.
 *
 * React 19 unmounts the entire root when a render throws and nothing catches
 * it. `#root` empties, `body` paints `--color-app` over the window, and the
 * app is a black rectangle with no message, no console for a packaged user to
 * open, and nothing to report but "it broke". The app had exactly one
 * boundary before this — `MessageBoundary`, around individual messages — so
 * every throw outside a transcript ended that way.
 *
 * This does not make the error recoverable. It makes it VISIBLE: the thrown
 * message, where it came from, and a way back. A crash that says what it was
 * is a bug report; a black window is a mystery.
 */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; stack: string }> {
  state: { error: Error | null; stack: string } = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack — it names the subtree, which the error's own
    // stack usually does not once the bundle is minified.
    this.setState({ error, stack: info.componentStack ?? "" });
    console.error("Murage failed to render", error, info.componentStack);
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full w-full items-center justify-center bg-app p-8">
        <div className="flex w-full max-w-[560px] flex-col gap-4 rounded-2xl border border-hairline/60 bg-panel p-6">
          <div>
            <div className="text-[16px] font-medium text-ink">Murage hit an error and stopped drawing</div>
            <div className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              Your conversations and settings are on disk and were not touched. Reloading the window is safe.
            </div>
          </div>
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">
            {String(error?.stack || error?.message || error)}
            {stack ? `\n${stack}` : ""}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="self-start rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
