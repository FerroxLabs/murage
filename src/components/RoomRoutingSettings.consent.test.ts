// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { config: { flux: { configured: true }, decider: { enabled: false, jobs: { roomRouting: false } } } }, dispatch: vi.fn() }),
}));
import { RoomRoutingSettings } from "./RoomRoutingSettings";

it("ROOM-ROUTING-CONSENT the switch renders the external processing disclosure", () => {
  const html = renderToStaticMarkup(createElement(RoomRoutingSettings));
  expect(html).toContain("Turning this on sends your new message, recent room messages, the room name and bot names to Flux to choose who replies.");
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
});
