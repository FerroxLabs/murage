// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  end: vi.fn(), on: vi.fn(), spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
import { spawnCloudLauncher } from "./bot-state.ts";
import { TURN_LAUNCHER } from "./turn-process.ts";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.spawn.mockReturnValue({ stdio: [null, null, null, { on: fixture.on, end: fixture.end }] });
});

it.each([undefined, false, true])("launcher commitChannel=%s opens only its declared descriptors", commitChannel => {
  const request = { mode: "fixture", bot_id: "fixture-bot" };
  const child = spawnCloudLauncher(request, commitChannel === undefined ? undefined : { commitChannel });
  expect(child).toBe(fixture.spawn.mock.results[0].value);
  expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/sudo", ["-n", "-C", commitChannel ? "5" : "4", "--", TURN_LAUNCHER], expect.objectContaining({
    env: { PATH: "/usr/bin:/bin" }, cwd: "/", detached: true,
    stdio: Array(commitChannel ? 5 : 4).fill("pipe"),
  }));
  expect(fixture.on).toHaveBeenCalledWith("error", expect.any(Function));
  expect(fixture.end).toHaveBeenCalledExactlyOnceWith(JSON.stringify(request));
});
