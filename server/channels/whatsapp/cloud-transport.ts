// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Cloud API seam (design 7.1, 13 W9). WhatsApp offers an official Business route (the Cloud API), and Murage will
// offer it as a later option beside the linked-device route that exists today. This file is the place it will plug in
// and nothing more: it implements `WhatsAppTransport` and refuses every call with a clear "not available yet" state.
// It contains no network code and reads no credentials.
//
// What the seam is. `WhatsAppService` talks to a backend only through `WhatsAppTransport` (transport.ts): start, link,
// stop, unlink, self, resolve, reserve, sendText, sendAudio, groups, markRead, presence, plus a `capabilities` record
// the service branches on. `BridgeTransport` is the linked-device backend. `makeWhatsApp` in server/index.ts picks the
// transport from `config.whatsapp.backend` ("linked-device" or "cloud-api").
//
// What the seam is not. A Cloud API backend is not a transport-only swap. It still needs, in later work:
//   - a token row in WORKSPACE_CREDENTIALS, typed by the owner;
//   - a provider verification challenge and signed-payload validation on its own ingress path (server/webhook-ingress.ts
//     accepts authenticated POSTs only and has neither);
//   - event filtering (statuses and template events are not messages), no groups, no presence, no id resolution;
//   - its own onboarding panel in Settings.
// What stays shared: the normalised envelope (event.ts), prompt wrapping (core/wrap.ts), the access policy for direct
// messages, the per-chat receipt ledgers and the status row.
import { ChannelSendError } from "../durable-delivery.ts";
import type { LidMapping } from "./core/lid.ts";
import type { LinkEvent, TransportCapabilities, TransportHandlers, WhatsAppTransport } from "./transport.ts";

/** Why the official route cannot be started. A value, so the service and UI can say it plainly. */
export const CLOUD_API_NOT_AVAILABLE = "cloud-api-not-available" as const;
export const CLOUD_API_MESSAGE = "The official WhatsApp Business route is not available yet. Link your own number instead.";

export class CloudApiNotAvailable extends Error {
  readonly code = CLOUD_API_NOT_AVAILABLE;
  constructor() { super(CLOUD_API_MESSAGE); }
}

export const CLOUD_API_CAPABILITIES: TransportCapabilities = {
  linking: "token", groups: false, presence: false, readReceipts: false, lidResolution: false, ownSendEcho: false,
};

export class CloudApiTransport implements WhatsAppTransport {
  readonly capabilities = CLOUD_API_CAPABILITIES;
  readonly resolve: LidMapping = { pnForLid: async () => undefined, lidForPn: async () => undefined };

  async start(_handlers: TransportHandlers): Promise<void> { throw new CloudApiNotAvailable(); }
  onLink(_listener: (event: LinkEvent) => void): void { /* nothing to link */ }
  async link(): Promise<void> { throw new CloudApiNotAvailable(); }
  async stop(): Promise<void> { /* never started */ }
  async unlink(): Promise<void> { /* nothing was linked */ }
  self(): null { return null; }
  async reserve(): Promise<{ ids: string[] }> { throw new ChannelSendError("unavailable", false); }
  async sendText(): Promise<{ ids: string[] }> { throw new ChannelSendError("unavailable", false); }
}
