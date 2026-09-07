import { describe, expect, it } from "vitest";
import { telegramMessageDisplay } from "./telegram-message-display";

const wrap = (body: string) => `[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n${body}\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]`;

describe("Telegram message presentation", () => {
  it.each(["Hello", "", "  Keep whitespace\n\n", "> quote\n```ts\nconst x = 1;\n```", "[Attached file: example.txt]"])("preserves the exact body %j", (body) => {
    expect(telegramMessageDisplay(wrap(body))).toEqual({ body });
  });

  it.each(["Hello", `Example:\n${wrap("hello")}`, `\`\`\`\n${wrap("hello")}\n\`\`\``, `> ${wrap("hello")}`, `${wrap("hello")}\n`, wrap("hello").replace("[/UNTRUSTED", "[/OTHER"), "[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]"])("keeps non-envelope text literal %j", (text) => {
    expect(telegramMessageDisplay(text)).toBeNull();
  });
});
