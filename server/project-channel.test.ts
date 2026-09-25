// The rules for a channel that has a purpose, and the one line that tells
// the bots what the work is.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROJECT_GOAL_MAX,
  CHANNEL_PROJECT_STATUSES,
  CHANNEL_PROJECT_STATUS_LABELS,
  channelProjectSchema,
} from "../shared/project.ts";
import { channelProjectSystemLine, isChannelProject, nextChannelProject } from "./project-channel.ts";

const GOAL = "Get the winter range into the shops by October.";

describe("giving a channel a purpose", () => {
  it("starts a project from a goal alone, and stamps the timestamps itself", () => {
    const outcome = nextChannelProject(undefined, { goal: GOAL }, 1_000);
    expect(outcome).toEqual({
      ok: true,
      project: { goal: GOAL, status: "active", startedAt: 1_000, updatedAt: 1_000 },
    });
    expect(channelProjectSchema.safeParse((outcome as { project: unknown }).project).success).toBe(true);
  });

  it("refuses a project with nothing to aim at", () => {
    expect(nextChannelProject(undefined, {}, 1_000)).toEqual({
      ok: false,
      error: "give this project a goal so everyone knows what the work is",
    });
    expect(nextChannelProject(undefined, { goal: "   " }, 1_000)).toMatchObject({ ok: false });
    expect(nextChannelProject(undefined, { status: "active" }, 1_000)).toMatchObject({ ok: false });
  });

  it("refuses a goal that is not text, too long, or an unknown status", () => {
    expect(nextChannelProject(undefined, { goal: 42 }, 1_000)).toMatchObject({ ok: false });
    expect(nextChannelProject(undefined, { goal: "x".repeat(CHANNEL_PROJECT_GOAL_MAX + 1) }, 1_000)).toEqual({
      ok: false,
      error: `project goal must be text of at most ${CHANNEL_PROJECT_GOAL_MAX} characters`,
    });
    expect(nextChannelProject(undefined, { goal: GOAL, status: "shipped" }, 1_000)).toEqual({
      ok: false,
      error: "project status must be one of: active, paused, done",
    });
    expect(nextChannelProject(undefined, { goal: GOAL, colour: "red" }, 1_000)).toMatchObject({ ok: false });
    expect(nextChannelProject(undefined, "a project", 1_000)).toMatchObject({ ok: false });
    expect(nextChannelProject(undefined, [GOAL], 1_000)).toMatchObject({ ok: false });
  });

  it("never lets a client set a timestamp", () => {
    expect(nextChannelProject(undefined, { goal: GOAL, startedAt: 5 }, 1_000)).toMatchObject({ ok: false });
    expect(nextChannelProject(undefined, { goal: GOAL, updatedAt: 5 }, 1_000)).toMatchObject({ ok: false });
  });

  it("keeps startedAt where it was and moves updatedAt on a real change", () => {
    const first = { goal: GOAL, status: "active" as const, startedAt: 1_000, updatedAt: 1_000 };
    const reworded = nextChannelProject(first, { goal: "Winter range in the shops by October." }, 9_000);
    expect(reworded).toMatchObject({
      ok: true,
      project: { startedAt: 1_000, updatedAt: 9_000, goal: "Winter range in the shops by October." },
    });
    // Asking for what is already there is not a change, so nothing moves.
    expect(nextChannelProject(first, { goal: GOAL, status: "active" }, 9_000)).toEqual({ ok: true, project: first });
  });

  it("stamps a finished date and clears it again when the work restarts", () => {
    const active = { goal: GOAL, status: "active" as const, startedAt: 1_000, updatedAt: 1_000 };
    const done = nextChannelProject(active, { status: "done" }, 9_000);
    expect(done).toMatchObject({ ok: true, project: { status: "done", completedAt: 9_000 } });
    const finished = (done as { project: NonNullable<ReturnType<typeof channelProjectSchema.parse>> }).project;

    // Editing the goal of a finished project keeps the date it finished.
    const reworded = nextChannelProject(finished, { goal: "Winter range, shops, October." }, 12_000);
    expect(reworded).toMatchObject({ ok: true, project: { completedAt: 9_000 } });

    // Reopening drops it: a finished-on date that outlives the finishing is
    // simply wrong.
    const reopened = nextChannelProject(finished, { status: "active" }, 12_000);
    expect(reopened).toMatchObject({ ok: true, project: { status: "active" } });
    expect((reopened as { project: { completedAt?: number } }).project.completedAt).toBeUndefined();
  });

  it("goes back to being a plain channel when the block is cleared", () => {
    const current = { goal: GOAL, status: "active" as const, startedAt: 1_000, updatedAt: 1_000 };
    expect(nextChannelProject(current, null, 9_000)).toEqual({ ok: true, project: undefined });
    expect(isChannelProject({})).toBe(false);
    expect(isChannelProject({ channelProject: current })).toBe(true);
  });

  it("every status has a word a person reads", () => {
    for (const status of CHANNEL_PROJECT_STATUSES) {
      expect(CHANNEL_PROJECT_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe("the line a member's turn gets", () => {
  it("says nothing at all when the channel is not a project", () => {
    expect(channelProjectSystemLine(undefined)).toBeNull();
  });

  it("labels the goal in one line", () => {
    expect(channelProjectSystemLine({ goal: GOAL, status: "active", startedAt: 1, updatedAt: 1 })).toBe(
      `Project goal (what this room is working towards): ${GOAL}`,
    );
  });

  it("says so when the work is on hold or finished", () => {
    expect(channelProjectSystemLine({ goal: GOAL, status: "paused", startedAt: 1, updatedAt: 1 })).toBe(
      `Project goal (what this room is working towards, on hold): ${GOAL}`,
    );
    expect(channelProjectSystemLine({ goal: GOAL, status: "done", startedAt: 1, updatedAt: 1 })).toBe(
      `Project goal (what this room is working towards, finished): ${GOAL}`,
    );
  });

  it("stays one line even when the goal was pasted in as a paragraph", () => {
    const line = channelProjectSystemLine({
      goal: "  Get the winter range\n\ninto the shops\tby October.  ",
      status: "active",
      startedAt: 1,
      updatedAt: 1,
    });
    expect(line).toBe("Project goal (what this room is working towards): Get the winter range into the shops by October.");
    expect(line!.split("\n")).toHaveLength(1);
  });
});

describe("the wiring into a member's turn", () => {
  // A unit test proves the line is right; this proves it is actually used,
  // and used in the one place it belongs: beside the room's own
  // instructions in the member-turn system prompt. Deleting the call would
  // leave every test above passing and every bot ignorant of the work.
  it("sits next to the room bulletin in the system prompt", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8").split("\n");
    const bulletin = source.findIndex((line) => line.includes("roomBulletinLine("));
    expect(bulletin).toBeGreaterThan(-1);
    const nearby = source.slice(bulletin, bulletin + 10).join("\n");
    expect(nearby).toContain("channelProjectSystemLine(group.channelProject)");
  });
});
