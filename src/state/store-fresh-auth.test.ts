// Every Allow the store sends from the phone goes through the fresh-auth
// helper. The store is a React provider the node test environment cannot
// mount, so this pins the source; the behaviour itself is tested on
// decideWithFreshAuth in src/lib/fresh-auth.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "store.tsx"), "utf8");
const between = (from: string, to: string) => {
  const start = source.lastIndexOf(from);
  return source.slice(start, source.indexOf(to, start));
};

describe("the store's Allow paths", () => {
  const decide = between('case "decideRequest": {', 'case "answerQuestion": {');
  const answerCard = between('case "answerCard": {', 'case "dismissCard": {');

  it("decideRequest posts through decideWithFreshAuth with its card, bot name and choice", () => {
    expect(decide).toMatch(/decideWithFreshAuth\(/);
    expect(decide).toMatch(/card: action\.card/);
    expect(decide).toMatch(/botName: action\.botName/);
    expect(decide).toMatch(/allowForTask \? "allow-task" : "allow"/);
    expect(decide).not.toMatch(/\.catch\(\(error\) =>/);
  });

  it("decideRequest still tells onError and sends no extra field on a desktop answer", () => {
    expect(decide).toMatch(/onError: action\.onError/);
    expect(decide).toMatch(/\.\.\.extra/);
  });

  it("the legacy answerCard Allow goes through the helper too", () => {
    expect(answerCard).toMatch(/decideWithFreshAuth\(/);
  });

  it("every page call that raises an Allow hands its card and bot name over", () => {
    const read = (f: string) => readFileSync(join(__dirname, "..", "components", f), "utf8");
    expect(read("PendingApproval.tsx")).toMatch(/card: pending\.message\.card/);
    expect(read("CallView.tsx").match(/botName: bot\.name/g)?.length).toBeGreaterThanOrEqual(2);
    expect(read("GroupCallView.tsx")).toMatch(/card: openApproval/);
  });
});
