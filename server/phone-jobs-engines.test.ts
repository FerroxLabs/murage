import { describe, expect, it } from "vitest";
import { ENGINE_LABEL } from "./conversation-deletion.ts";
import { driverMountsPhoneJobs, PHONE_JOBS_ENGINES } from "./phone-jobs-engines.ts";
import { turnCapabilityFacts } from "./capabilities-primer.ts";

describe("S13b: phoneJobs mounting is classified for every engine kind", () => {
  it("classifies every ENGINE_LABEL kind as mounts-phoneJobs or explicitly unsupported, and nothing else", () => {
    expect(Object.keys(PHONE_JOBS_ENGINES).sort()).toEqual(Object.keys(ENGINE_LABEL).sort());
    for (const [kind, status] of Object.entries(PHONE_JOBS_ENGINES)) {
      if (status.mounts) expect(status.where, kind).not.toBe("");
      else expect(status.why, kind).not.toBe("");
    }
  });

  it("treats an unknown kind as not mounting", () => {
    expect(driverMountsPhoneJobs("someNewAgent")).toBe(false);
    expect(driverMountsPhoneJobs("fuigoAgent")).toBe(true);
    expect(driverMountsPhoneJobs("piAgent")).toBe(true);
    expect(driverMountsPhoneJobs("openclawAgent")).toBe(false);
  });

  it("never tells an unsupported engine it has phone tools", () => {
    const phoneJobs = { command: "node", args: ["pj"], env: {} };
    const facts = (driverKind: string) => turnCapabilityFacts({
      instance: { driverKind, displayName: driverKind, models: { default: "m", options: [] }, adapter: { capabilities: {} } },
      integrations: { phoneJobs }, peers: 0, memory: "off", imageProvider: false, canAskOwner: true,
    } as unknown as Parameters<typeof turnCapabilityFacts>[0]);
    expect(facts("fuigoAgent").mounted.phoneJobs).toBe(true);
    expect(facts("antigravityAgent").mounted.phoneJobs).toBeUndefined();
    expect(facts("openclawAgent").toolAccess).toBe("none");
  });
});
