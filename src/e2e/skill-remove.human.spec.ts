// "Remove <skill>" must actually issue the DELETE.
//
// The bug this file exists to keep dead: on a freshly opened profile panel the
// remove control fired NO `DELETE /api/bots/:id/skills/:name` at all — a
// network log across the whole click showed only the `GET .../skills`
// re-reads. The route was never at fault; the handler returned before reaching
// it, because it opened with an early return gated on the browser's own
// confirm() prompt, and a dialog that is auto-dismissed is indistinguishable
// from a person saying no.
//
// So this asserts the thing the bug report measured: the REQUEST, not just the
// row disappearing. A UI that removed the row optimistically and never called
// the server would satisfy the second and not the first.
import type { Page, Request } from "@playwright/test";

import { desktopHeaders, HARNESS_URL } from "./rig";
import { expect, openSidebar, test } from "./fixtures";

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${HARNESS_URL}${path}`, {
    method,
    headers: {
      ...(await desktopHeaders()),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const openBot = async (page: Page, name: string) => {
  const sidebar = await openSidebar(page);
  await sidebar.getByText(name, { exact: true }).click();
};

test.describe("a skill the person wants gone", () => {
  test("one click issues exactly one DELETE, and the row goes", async ({ app }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "one surface is enough for a request assertion");

    const created = await api("POST", "/api/bots", { name: "E2E Remove Skill" });
    const botId: string = created.bot.id;
    try {
      const added = await api("POST", `/api/bots/${botId}/skills/library`, { ids: ["chart-analysis"] });
      expect(added.installed.length).toBe(1);
      await app.reload();
      await openBot(app, "E2E Remove Skill");

      // Every request the click makes, in the order it makes them — the same
      // log the bug was reported from.
      const log: string[] = [];
      const record = (request: Request) => {
        const url = request.url();
        if (url.includes(`/api/bots/${botId}/skills`)) log.push(`${request.method()} ${new URL(url).pathname}`);
      };
      app.on("request", record);

      await app.getByRole("button", { name: "Open E2E Remove Skill's profile" }).first().click();
      const remove = app.getByRole("button", { name: "Remove chart-analysis" });
      await expect(remove).toBeVisible({ timeout: 30_000 });

      const deleted = app.waitForRequest(
        (request) =>
          request.method() === "DELETE" && request.url().includes(`/api/bots/${botId}/skills/chart-analysis`),
        { timeout: 15_000 },
      );
      await remove.click();
      await deleted;
      await expect(remove).toHaveCount(0, { timeout: 15_000 });

      app.off("request", record);
      // eslint-disable-next-line no-console
      console.log(`[skill remove] network across the click → ${JSON.stringify(log)}`);
      const deletes = log.filter((entry) => entry.startsWith("DELETE "));
      expect(deletes.length, `expected one DELETE, saw ${JSON.stringify(log)}`).toBe(1);

      // And the server agrees, which is the half a purely optimistic row would
      // have faked.
      const after = await api("GET", `/api/bots/${botId}/skills`);
      expect(after.skills ?? []).toHaveLength(0);
    } finally {
      await api("DELETE", `/api/bots/${botId}`).catch(() => {});
    }
  });
});
