import { describe, expect, it } from "vitest";

import { steerToConfirm } from "./steer-confirmation.ts";

const msg = (id: string, steerId: string | undefined, steerUnconfirmed = true) => ({ id, role: "user", steerUnconfirmed, ...(steerId ? { steerId } : {}) });

describe("steerToConfirm", () => {
  it("two unconfirmed messages confirmed out of order each clear the right one", () => {
    const a = msg("m-a", "steer-a");
    const b = msg("m-b", "steer-b");
    const thread = [a, b];
    expect(steerToConfirm(thread, "steer-b")).toBe(b);
    b.steerUnconfirmed = false;
    expect(steerToConfirm(thread, "steer-a")).toBe(a);
    a.steerUnconfirmed = false;
    expect(steerToConfirm(thread, "steer-a")).toBeNull();
  });

  it("a confirmation for B never clears A", () => {
    const a = msg("m-a", "steer-a");
    expect(steerToConfirm([a], "steer-b")).toBeNull();
    expect(steerToConfirm([a, msg("m-b", "steer-b", false)], "steer-b")).toBeNull();
  });

  it("an echo without an id, or a message without one, clears nothing", () => {
    expect(steerToConfirm([msg("m-old", undefined)], "steer-a")).toBeNull();
    expect(steerToConfirm([msg("m-a", "steer-a")], undefined)).toBeNull();
    expect(steerToConfirm([msg("m-a", "steer-a")], "")).toBeNull();
  });
});
