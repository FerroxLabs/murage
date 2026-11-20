// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G9 gap check H2, on the rendered rows (H1, the analytics switch, left with the analytics client in the 1.0.20
// re-cut: Murage sends no usage analytics, src/lib/no-telemetry-1020.test.ts). H2: blurring a profile field writes nothing before the profile
// has been read, and nothing when no field changed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();
let config: { profile?: { name: string; email: string } } | null = null;
const dispatch = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ state: { config }, dispatch }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));

import { ProfileFields } from "./GeneralRows";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  api.mockReset();
  config = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});
const mount = async (node: React.ReactNode) => { await act(async () => { root.render(node); }); };
const input = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const blur = async (node: HTMLElement) => { await act(async () => { node.focus(); node.blur(); }); };
const type = async (node: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("H2: profile fields never write without an edit", () => {
  it("before the profile is read, the fields are read-only and a blur writes nothing", async () => {
    await mount(<ProfileFields />);
    expect(input("Your name").readOnly).toBe(true);
    await blur(input("Your name"));
    await blur(input("Your email"));
    // Even a typed name is not sent before the read: it would go out with an empty email over the saved one.
    await type(input("Your name"), "Ann");
    await blur(input("Your name"));
    expect(api).not.toHaveBeenCalled();
  });

  it("after the read, focusing and leaving a field without an edit writes nothing, even with no saved profile", async () => {
    config = {}; // read, and this owner has no profile yet
    await mount(<ProfileFields />);
    await blur(input("Your name"));
    config = { profile: { name: "Ann Example ", email: "Ann@Example.test" } };
    await mount(<ProfileFields />);
    await blur(input("Your name"));
    await blur(input("Your email"));
    expect(api).not.toHaveBeenCalled();
  });

  it("an edited field is saved, with the other field kept as read", async () => {
    config = { profile: { name: "Ann", email: "ann@example.test" } };
    api.mockResolvedValue({ profile: { name: "Ann B", email: "ann@example.test" } });
    await mount(<ProfileFields />);
    await type(input("Your name"), "Ann B");
    await blur(input("Your name"));
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.mock.calls[0]![1].body)).toEqual({ profile: { name: "Ann B", email: "ann@example.test" } });
  });
});
