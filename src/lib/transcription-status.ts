export const TRANSCRIPTION_STATUS_EVENT = "murage:transcription-status";

declare global {
  interface WindowEventMap {
    "murage:transcription-status": CustomEvent<{ configured: boolean }>;
  }
}

export function announceTranscriptionStatus(configured: boolean) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPTION_STATUS_EVENT, { detail: { configured } }));
}
