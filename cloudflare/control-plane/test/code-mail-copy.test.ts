import { describe, expect, it } from "vitest";
import { proofMailText } from "../src/flux-email-proof";

// Sean's walk 11-04: a buyer gets two codes minutes apart. Each mail names its own page and says it is not the other code (MurageMain copy, 11-04).
describe("code mail copy: the two codes cannot be confused", () => {
  it("the email-proof mail names the Confirm your email box and says it is not the code for opening Murage", () => {
    const text = proofMailText("123456");
    const [subject, , first] = text.split("\n");
    expect(subject).toBe("Murage Cloud: your code to confirm your email");
    expect(text).toContain("Type this code in the \"Confirm your email\" box on your My Cloud page. It is not the code for opening Murage.");
    expect(first).toBe("This email is from Murage Cloud.");
    expect(text).toContain("This email is from Murage Cloud.\n\nOne more code: it switches on your Flux credit.\n\nType this code");
    expect(text).toContain("Your code is: 123456");
    expect(text).not.toMatch(/[–—]/);
  });
});
