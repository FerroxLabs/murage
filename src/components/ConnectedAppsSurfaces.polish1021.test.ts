import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountDisplayName } from "./ConnectedAppsSurfaces";

// 1.0.21 polish (Sean's live 1.0.20 walk): every connected account showed its raw service id ("ca_..."). Owners see a
// name they recognise; the id stays internal (keys, reconnect calls), never as row text.
describe("connected account names", () => {
  it("uses the owner's label when there is one", () => {
    expect(accountDisplayName({ id: "ca_gV_9PXfixture", alias: "work" }, "Gmail", 0)).toBe("work");
  });
  it("never shows a raw service id, with or without a label", () => {
    expect(accountDisplayName({ id: "ca_gV_9PXfixture" }, "Gmail", 0)).toBe("Gmail account");
    expect(accountDisplayName({ id: "ca_gV_9PXfixture", alias: "" }, "Gmail", 1)).toBe("Gmail account 2");
    expect(accountDisplayName({ id: "ca_gV_9PXfixture", alias: "ca_gV_9PXfixture" }, "Gmail", 0)).toBe("Gmail account");
  });
  it("the Connected apps rows never render account.id as text", () => {
    const panel = readFileSync(new URL("./PluginsPanel.tsx", import.meta.url), "utf8");
    expect(panel).not.toMatch(/account\.alias \|\| account\.id/);
    expect(panel).not.toMatch(/ConnectedAccountLine id=\{account\.alias \? account\.id/);
    expect(panel).toContain("accountDisplayName(account, card.label");
  });
});
describe("disconnect confirmation", () => {
  it("names the account without its raw id", async () => {
    const { disconnectAccountConfirmation } = await import("./PluginsPanel");
    const line = disconnectAccountConfirmation("Gmail", { id: "ca_gV_9PXfixture" });
    expect(line).not.toContain("ca_");
    expect(line).toContain("“Gmail account”");
    expect(disconnectAccountConfirmation("Gmail", { id: "ca_gV_9PXfixture", alias: "work" })).not.toContain("ca_");
  });
});
describe("app descriptions", () => {
  it("the card's description carries its full words as the hover title", () => {
    const panel = readFileSync(new URL("./PluginsPanel.tsx", import.meta.url), "utf8");
    expect(panel).toMatch(/title=\{pending \|\| \(failed && !accounts\.length\) \? undefined : card\.blurbFull \?\? card\.blurb\}/);
  });
});
