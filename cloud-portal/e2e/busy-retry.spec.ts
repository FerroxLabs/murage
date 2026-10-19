import { expect, test } from "@playwright/test";
import { retryWhileBusy } from "../lib/retry";

const busy = () => Object.assign(new Error("home_busy"), { status: 409, code: "home_busy" });

test("a billing action that finds the home busy is tried again up to 3 more times, then gives up", async () => {
  let calls = 0;
  await expect(retryWhileBusy(async () => { calls++; throw busy(); }, 1)).rejects.toMatchObject({ code: "home_busy" });
  expect(calls).toBe(4);
  calls = 0;
  expect(await retryWhileBusy(async () => { if (++calls < 3) throw busy(); return "ok"; }, 1)).toBe("ok");
  expect(calls).toBe(3);
  calls = 0;
  await expect(retryWhileBusy(async () => { calls++; throw Object.assign(new Error("x"), { code: "topup_invalid" }); }, 1)).rejects.toMatchObject({ code: "topup_invalid" });
  expect(calls).toBe(1); // any other error is not retried
});
