// Q2 prep: the 45-task script has 42 routed tasks and 3 honest endings, and each ending matches the drawn search answer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withScratchGen, pythonOut } from "./run-mockup";

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "q2", "task-script.md"), "utf8");
const taskRows = script.split("## The three honest-answer endings")[0].split("\n").filter((l) => /^\| (\d+|N\d+) \|/.test(l));
const HONEST = ["N5", "N6", "N11"];

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "q2", "ia-task-rows.md"), "utf8").split("\n").filter(Boolean);
const clean = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const endingRows = script.split("## The three honest-answer endings")[1].split("\n").filter((l) => /^\| N\d+ \|/.test(l));
// the ending check on the raw page: for each typed query, that query's own window must show the typed text in its title and search box,
// and its "An answer, not a setting" card must carry the full answer text and a link with the stated label and destination.
const endingProblems = (raw: string) => endingRows.flatMap((e) => {
  const [id, typed, text, label, dest] = cells(e);
  const head = raw.indexOf(`<h2>Results for &quot;${typed}&quot;</h2>`);
  if (head < 0) return [`${id}: no window titled for the typed query`];
  const start = raw.lastIndexOf('<div class="win', head);
  const next = raw.indexOf('<div class="win', head);
  const win = raw.slice(start, next < 0 ? undefined : next);
  const card = win.slice(Math.max(0, win.indexOf("An answer, not a setting")));
  const link = /<a class="ro" href="([^"]+)">(.*?) <span/.exec(card);
  const bad: string[] = [];
  if (!win.includes(`value="${typed}"`)) bad.push(`${id}: search box does not hold the typed query`);
  if (!clean(card).includes(text)) bad.push(`${id}: answer text missing`);
  if (!link) bad.push(`${id}: no link on the answer card`);
  else {
    if (clean(link[2]).trim() !== label) bad.push(`${id}: link label ${clean(link[2]).trim()}`);
    if (link[1] !== dest.replace(/`/g, "")) bad.push(`${id}: link goes to ${link[1]}`);
  }
  return bad;
});

describe("settings v10 Q2 task script", () => {
  it("lists 45 tasks, 42 routed and 3 honest, each id once", () => {
    const ids = taskRows.map((l) => cells(l)[0]);
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);
    expect(taskRows.filter((l) => /Not in the product/.test(l)).map((l) => cells(l)[0])).toEqual(HONEST);
    expect(taskRows.filter((l) => !/Not in the product/.test(l))).toHaveLength(42);
    expect(endingRows.map((l) => cells(l)[0])).toEqual(HONEST);
  });
  it("every task row equals the design's row (task, route, clicks, result)", () => {
    expect(taskRows.map((l) => cells(l).join("|"))).toEqual(source.map((l) => cells(l).join("|")));
  });
  it("every honest ending, its typed query and its link destination match the drawn search page, and drifted pages are caught", () => {
    const raw = withScratchGen((gen) => {
      pythonOut([join(gen, "build.py")], gen);
      return readFileSync(join(gen, "..", "search-more.html"), "utf8");
    });
    expect(endingProblems(raw)).toEqual([]);
    expect(endingProblems(raw.replace("not confirmed yet", "confirmed"))).toEqual(["N5: answer text missing"]);
    expect(endingProblems(raw.replace(">Open Guides <", ">Open Help <"))).toEqual(["N11: link label Open Help"]);
    expect(endingProblems(raw.replace('href="about.html#about.help">Open Guides', 'href="usage.html#usage.limit">Open Guides'))).toEqual(["N11: link goes to usage.html#usage.limit"]);
    expect(endingProblems(raw.replace('href="messaging.html#messaging.apps">Open', 'href="#">Open'))).toEqual(["N6: link goes to #"]);
    expect(endingProblems(raw.replace('value="lock"', 'value="unlock"'))).toEqual(["N11: search box does not hold the typed query"]);
    expect(endingProblems(raw.replace("<h2>Results for &quot;move to cloud&quot;</h2>", "<h2>Results for &quot;move&quot;</h2>"))).toEqual(["N5: no window titled for the typed query"]);
  });
});
