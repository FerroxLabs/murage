import { useStore } from "@/state/store";

/** Setup points at the one key editor; no credential travels with navigation. */
export function FluxKeyCardBody({ onOpen }: { onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="min-h-11 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open Flux Router in Models</button>;
}

export function FluxKeyCard() {
  const { dispatch } = useStore();
  return <FluxKeyCardBody onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "models" })} />;
}
