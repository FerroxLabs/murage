/** Renderer bridge decisions, independent of React and DOM focus/modal state.
 * The component effect owns this subscription and returns its cleanup. */
export function subscribeUpdateNotice(input: {
  version?: string;
  status?: string;
  dismissed: () => boolean;
  title: (version: string) => string;
  report: (value: { version: string; dismissed: boolean; title: string }) => Promise<unknown> | undefined;
  subscribeLocale: (changed: () => void) => () => void;
  onNotice: (callback: (version: string) => void) => (() => void) | undefined;
  show: () => void;
}): () => void {
  let active = true;
  const report = () => {
    if (active && input.version) void input.report({ version: input.version, dismissed: input.dismissed(),
      title: input.title(input.version) })?.catch(() => {});
  };
  const stopLocale = input.subscribeLocale(report);
  const stopNotice = input.onNotice(version => {
    if (active && input.status === 'downloaded' && version === input.version && !input.dismissed()) input.show();
  });
  report();
  return () => { active = false; stopLocale(); stopNotice?.(); };
}
