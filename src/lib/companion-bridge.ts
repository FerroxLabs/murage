// The preload's phone bridge, on its own so first paint need not load the phone setup screens.
import type { CompanionBridge } from "@/components/PhoneSetupFlow";

export const companionBridge = (): CompanionBridge | null =>
  // SAFETY: the preload owns this narrow bridge; browser builds are guarded by the optional lookup.
  (globalThis as { muragebox?: { companion?: CompanionBridge } }).muragebox?.companion ?? null;
