import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { AnsweredWhere } from "./mobile-push-hooks.ts";

const response = (statusCode = 200) => Object.assign(new EventEmitter(), { statusCode }) as unknown as { statusCode: number; once(event: "finish", listener: () => void): unknown };
const finish = (res: unknown, statusCode: number) => { (res as { statusCode: number }).statusCode = statusCode; (res as EventEmitter).emit("finish"); };

describe("AnsweredWhere attempts are cleaned up per attempt", () => {
  it("a losing attempt that finishes with a refusal does not erase the winner's attribution", () => {
    const where = new AnsweredWhere();
    const winner = response(), loser = response();
    where.attempt("t:r", "desktop", winner);
    where.attempt("t:r", "desktop", loser); // same value, a different attempt
    finish(loser, 409);
    expect(where.take("t:r")).toBe("desktop");
  });
  it("the latest attempt still cleans itself up when it is refused", () => {
    const where = new AnsweredWhere();
    const only = response();
    where.attempt("t:r", "desktop", only);
    finish(only, 409);
    expect(where.take("t:r")).toBe("elsewhere");
  });
  it("an accepted attempt stays until the card settles", () => {
    const where = new AnsweredWhere();
    const ok = response();
    where.attempt("t:r", "desktop", ok);
    finish(ok, 200);
    expect(where.take("t:r")).toBe("desktop");
  });
});
