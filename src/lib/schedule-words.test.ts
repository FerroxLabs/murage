// UX L5B: the schedule-words table. A fixed clock: Thursday 5 November 2026,
// 10:00 local. Every expected time is built with local Date parts, so the table
// holds in any time zone.
import { describe, expect, it } from "vitest";
import { nextOccurrence, parseScheduleWords, scheduleFromWhen, type ScheduleWhen } from "./schedule-words";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, 5 + day, hour, minute).getTime();
const NOW = at(0, 10);
const ALL = [0, 1, 2, 3, 4, 5, 6];
const WD = [1, 2, 3, 4, 5];
const daily = (time: string, weekdays: number[]): ScheduleWhen => ({ type: "daily", time, weekdays });
const once = (when: number): ScheduleWhen => ({ type: "once", at: when });
const every = (everyMinutes: number): ScheduleWhen => ({ type: "interval", everyMinutes, anchorAt: at(0, 10, 5) });

const TABLE: Array<[string, ScheduleWhen | null, string?]> = [
  ["every weekday at 8, send me a brief", daily("08:00", WD), "Send me a brief"],
  ["every day at 7am check my email", daily("07:00", ALL), "Check my email"],
  ["daily at 9:30 summarize the news", daily("09:30", ALL), "Summarize the news"],
  ["every morning send me the weather", daily("08:00", ALL), "Send me the weather"],
  ["every evening review my calendar", daily("18:00", ALL), "Review my calendar"],
  ["every night at 10 back up the notes", daily("22:00", ALL), "Back up the notes"],
  ["weekdays at 6pm post a recap", daily("18:00", WD), "Post a recap"],
  ["every weekend at 10 plan meals", daily("10:00", [0, 6]), "Plan meals"],
  ["every monday at 9 send the report", daily("09:00", [1]), "Send the report"],
  ["every mon and wed at 7pm water reminder", daily("19:00", [1, 3]), "Water reminder"],
  ["every tuesday, thursday and saturday at 8:15 stretch", daily("08:15", [2, 4, 6]), "Stretch"],
  ["mondays and fridays at noon order lunch", daily("12:00", [1, 5]), "Order lunch"],
  ["on mondays at 9 check invoices", daily("09:00", [1]), "Check invoices"],
  ["monday to friday at 7:30 brief me", daily("07:30", WD), "Brief me"],
  ["mon-fri at 8 news", daily("08:00", WD), "News"],
  ["every friday afternoon send a summary", daily("14:00", [5]), "Send a summary"],
  ["weekly on friday at 4 send timesheets", daily("16:00", [5]), "Send timesheets"],
  ["every week at 9 review goals", daily("09:00", [4]), "Review goals"],
  ["every hour check the inbox", every(60), "Check the inbox"],
  ["hourly check the queue", every(60), "Check the queue"],
  ["every 15 minutes check the site", every(15), "Check the site"],
  ["every 2 hours drink water", every(120), "Drink water"],
  ["every half hour stand up", every(30), "Stand up"],
  ["every 3 minutes ping", null],
  ["every 30 hours ping", null],
  ["in 30 minutes remind me to call mom", once(at(0, 10, 30)), "Remind me to call mom"],
  ["in 2 hours check the oven", once(at(0, 12)), "Check the oven"],
  ["in an hour call back", once(at(0, 11)), "Call back"],
  ["tomorrow at 9 call the bank", once(at(1, 9)), "Call the bank"],
  ["tomorrow morning send the deck", once(at(1, 8)), "Send the deck"],
  ["today at 5pm send the invoice", once(at(0, 17)), "Send the invoice"],
  ["today at 8 send it", null],
  ["tonight review the PR", once(at(0, 20)), "Review the PR"],
  ["at 3 call Sam", once(at(0, 15)), "Call Sam"],
  ["at 9am send notes", once(at(1, 9)), "Send notes"],
  ["at 11:45 lunch reminder", once(at(0, 11, 45)), "Lunch reminder"],
  ["friday at 10 send the deck", once(at(1, 10)), "Send the deck"],
  ["friday evening send a recap", once(at(1, 18)), "Send a recap"],
  ["next tuesday at 9 dentist", once(at(5, 9)), "Dentist"],
  ["on saturday at noon mow the lawn", once(at(2, 12)), "Mow the lawn"],
  ["thursday at 9 standup", null],
  ["thursday at 3pm standup", once(at(0, 15)), "Standup"],
  ["at noon eat", once(at(0, 12)), "Eat"],
  ["at midnight rotate logs", once(at(1, 0)), "Rotate logs"],
  ["every day at midnight rotate logs", daily("00:00", ALL), "Rotate logs"],
  ["every day send a brief", null],
  ["send me a brief", null, "Send me a brief"],
  ["every month on the 1st pay rent", null],
  ["every other week at 9 water plants", null],
  ["at 25 do it", null],
  ["at 13:00 sync", once(at(0, 13)), "Sync"],
  ["at 8:75 do it", null],
  ["every weekday at 8 a.m. brief", daily("08:00", WD), "Brief"],
  ["Every Weekday At 8, Send Me A Brief", daily("08:00", WD), "Send Me A Brief"],
  ["every day at 7 in the evening read", daily("19:00", ALL), "Read"],
  ["every morning at 6:30 run", daily("06:30", ALL), "Run"],
  ["every weekday at 8, send me a brief about Sun Microsystems", daily("08:00", WD), "Send me a brief about Sun Microsystems"],
  ["post the monthly report every monday at 9", daily("09:00", [1]), "Post the monthly report"],
  // A When inside the task is a doubt: "Pick a time".
  ["remind me at 4 to stretch", null],
  ["check the weather every 10 minutes", every(10), "Check the weather"],
  // Astra r1 High 1: task words never set the time.
  ["every day at 8 send me an evening recap", null],
  ["send me an evening recap every day at 8", null],
  ["every morning send me the evening news", null],
  ["send me an evening recap at 8", null, "Send me an evening recap at 8"],
  ["every day at 9 remind me to call at 5", null],
  ["summarize the daily digest at 8", null],
  ["every friday at 9 send the monday report", null],
  ["send me an evening recap", null, "Send me an evening recap"],
  // Astra r1 High 2: "starting ..." is not read, so the sentence falls back.
  ["every 2 hours starting tomorrow at 9 check the site", null],
  ["every 2 hours, starting tomorrow, check the site", null],
  ["every day at 9 starting tomorrow send a brief", null],
  ["check the site every hour starting monday", null],
  ["every 15 minutes from 9 to 5 check the queue", null],
  // Astra r1 High 3: a time zone is not read, so the sentence falls back.
  ["every day at 8 UTC send a brief", null],
  ["at 9 PST call the team", null],
  ["every weekday at 8:00 utc+2 brief", null],
  ["every day at 9 eastern time post the numbers", null],
  ["tomorrow at 0800z check the logs", null],
  ["every weekday at 8 GMT, send me a brief", null],
  // Medium 6: "this morning" is today; one that has passed is not tomorrow.
  ["this morning at 9 send notes", null],
  ["this evening at 7 call mom", once(at(0, 19)), "Call mom"],
  ["every weekday at 8", daily("08:00", WD), ""],
  ["", null, ""],
];

describe("parseScheduleWords", () => {
  it("has the 60-row table", () => expect(TABLE.length).toBeGreaterThanOrEqual(60));
  it.each(TABLE)("%s", (sentence, when, task) => {
    const read = parseScheduleWords(sentence, NOW);
    expect(read.when).toEqual(when);
    if (task !== undefined) expect(read.task).toBe(task);
  });

  it("never hands back a start in the past", () => {
    for (const [sentence] of TABLE) {
      const read = parseScheduleWords(sentence, NOW);
      if (!read.when) continue;
      const next = nextOccurrence(scheduleFromWhen(read.when), NOW);
      expect(next, sentence).not.toBeNull();
      expect(next!, sentence).toBeGreaterThan(NOW);
    }
  });

  it("is deterministic: the same sentence and clock give the same answer", () => {
    expect(parseScheduleWords("every weekday at 8, send me a brief", NOW)).toEqual(parseScheduleWords("every weekday at 8, send me a brief", NOW));
  });
});

describe("nextOccurrence", () => {
  const weekday8 = { type: "daily" as const, time: "08:00", weekdays: WD };
  it("every weekday at 8, on Thursday at 10, is Friday at 8", () => {
    expect(nextOccurrence(weekday8, NOW)).toBe(at(1, 8));
  });
  it("on Friday evening it is Monday at 8", () => {
    expect(nextOccurrence(weekday8, at(1, 19))).toBe(at(4, 8));
  });
  it("is strictly after now, never the same minute", () => {
    expect(nextOccurrence({ type: "daily", time: "10:00", weekdays: ALL }, NOW)).toBe(at(1, 10));
  });
  it("a one-off in the past has no next run", () => {
    expect(nextOccurrence({ type: "once", at: at(0, 9) }, NOW)).toBeNull();
  });
  it("an interval steps from its anchor past now", () => {
    expect(nextOccurrence({ type: "interval", everyMinutes: 15, anchorAt: at(0, 9) }, NOW)).toBe(at(0, 10, 15));
  });
  it("app and limit routines have no clock", () => {
    expect(nextOccurrence({ type: "app_event", triggerId: "x" }, NOW)).toBeNull();
    expect(nextOccurrence({ type: "limit_reset", engineKey: "claude" }, NOW)).toBeNull();
  });
});
