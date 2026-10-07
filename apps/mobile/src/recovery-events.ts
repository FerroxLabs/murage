/** Network and foreground edges only. Duplicate OS events cannot schedule more retries. */
export function listenForRecovery(
  page: EventTarget & { readonly visibilityState: string },
  network: EventTarget,
  online: () => boolean,
  recover: () => void,
): () => void {
  let wasOnline = online();
  let background = page.visibilityState !== "visible";
  const foreground = () => {
    if (page.visibilityState !== "visible" || !background) return;
    background = false;
    // Fold a connectivity change observed on foreground into this same attempt.
    wasOnline = online();
    if (wasOnline) recover();
  };
  const pause = () => { background = true; };
  const visibility = () => {
    if (page.visibilityState === "visible") foreground();
    else pause();
  };
  const offline = () => { wasOnline = false; };
  const connected = () => {
    const changed = !wasOnline && online();
    wasOnline = online();
    if (changed && !background && page.visibilityState === "visible") recover();
  };
  const listeners: [EventTarget, string, () => void][] = [
    [page, "pause", pause], [page, "resume", foreground], [page, "visibilitychange", visibility],
    [network, "offline", offline], [network, "online", connected],
  ];
  for (const [target, event, listener] of listeners) target.addEventListener(event, listener);
  return () => { for (const [target, event, listener] of listeners) target.removeEventListener(event, listener); };
}
