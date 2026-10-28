// 1.0.9 share and ask S41: a line that came through the phone shows "From your phone" and an "Ask again" chip; a plain line shows neither.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FromPhoneLineView } from "./FromPhoneLine";

const view = (via: "share" | "ask-intent" | undefined) =>
  renderToStaticMarkup(createElement(FromPhoneLineView, { via, onAskAgain: () => undefined }));

describe("the From your phone line", () => {
  it("shows the label and the chip on a phone line", () => {
    for (const via of ["share", "ask-intent"] as const) {
      const html = view(via);
      expect(html).toContain(en["phone.ask.fromPhone"]);
      expect(html).toContain(`>${en["phone.ask.askAgain"]}<`);
    }
  });
  it("shows nothing on a plain line", () => {
    expect(view(undefined)).toBe("");
  });
});

describe("the transcript hides Edit, Regenerate and Retry on a phone line", () => {
  const chat = readFileSync(fileURLToPath(new URL("./ChatView.tsx", import.meta.url)), "utf8");
  it("gates every edit and regenerate path on canEditLine", () => {
    expect(chat).toContain("canEditLine(message)");
    expect(chat).toContain("lastUserMessage && canEditLine(lastUserMessage)");
    expect(chat).toContain("<FromPhoneLine");
  });
});
