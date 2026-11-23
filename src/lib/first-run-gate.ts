// First-run email step state: whether the owner has already answered it on
// this machine. Stored locally only; nothing here is sent anywhere.
const GATE_KEY = "murage-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
