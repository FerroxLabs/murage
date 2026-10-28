import { describe, expect, it } from "vitest";
import { familyOffered, phoneFamily, phonesOffered, shareAskOffered } from "./offered.ts";
import { routeClass, routePolicy } from "../route-policy.ts";

const base = { features: { phoneTools: true }, cloudRole: undefined, launchProof: true, sharedWorkspace: false };

describe("phonesOffered", () => {
  it("is on only with the flag, on a desktop, with the launch proof, unshared", () => {
    expect(phonesOffered(base)).toBe(true);
    expect(phonesOffered({ ...base, features: {} })).toBe(false); // default off
    expect(phonesOffered({ ...base, features: undefined })).toBe(false);
    expect(phonesOffered({ ...base, features: { phoneTools: "yes" } })).toBe(false);
    expect(phonesOffered({ ...base, cloudRole: "home" })).toBe(false); // F24: P1b not shipped
    expect(phonesOffered({ ...base, launchProof: false })).toBe(false);
    expect(phonesOffered({ ...base, sharedWorkspace: true })).toBe(false); // F25
  });
});

const askBase = { features: { phoneShareAsk: true }, cloudRole: undefined, launchProof: true, sharedWorkspace: false };
describe("shareAskOffered (independent of phoneTools)", () => {
  it("is on only with its own flag", () => {
    expect(shareAskOffered(askBase)).toBe(true);
    expect(shareAskOffered({ ...askBase, features: {} })).toBe(false);
    expect(shareAskOffered({ ...askBase, features: undefined })).toBe(false);
    expect(shareAskOffered({ ...askBase, features: { phoneTools: true } })).toBe(false);
    expect(shareAskOffered({ ...askBase, features: { phoneShareAsk: "yes" } })).toBe(false);
    expect(shareAskOffered({ ...askBase, cloudRole: "home" })).toBe(false); // B1
    expect(shareAskOffered({ ...askBase, launchProof: false })).toBe(false);
    expect(shareAskOffered({ ...askBase, sharedWorkspace: true })).toBe(false);
  });
  it("phoneTools does not need phoneShareAsk and the reverse", () => {
    expect(phonesOffered(askBase)).toBe(false);
    expect(phonesOffered({ ...askBase, features: { phoneTools: true, phoneShareAsk: true } })).toBe(true);
    expect(shareAskOffered({ ...askBase, features: { phoneTools: true, phoneShareAsk: true } })).toBe(true);
  });
  it("classifies every phone path into one family", () => {
    expect(phoneFamily("GET", "/api/phones/self/targets")).toBe("ask");
    expect(phoneFamily("POST", "/api/phones/self/share")).toBe("ask");
    expect(phoneFamily("POST", "/api/phones/self/ask")).toBe("ask");
    expect(phoneFamily("POST", "/api/phones/ask-revoke")).toBe("ask");
    expect(phoneFamily("GET", "/api/phones/self/challenge")).toBe("bootstrap");
    expect(phoneFamily("POST", "/api/phones/self/token")).toBe("bootstrap");
    expect(phoneFamily("GET", "/api/phones/self/jobs")).toBe("jobs");
    expect(phoneFamily("POST", "/api/phones/self/jobs/abc/lease")).toBe("jobs");
    expect(phoneFamily("GET", "/api/phones/self")).toBe("jobs");
    expect(phoneFamily("GET", "/api/phones")).toBe("admin");
    expect(phoneFamily("POST", "/api/phones/revoke")).toBe("admin");
    // The wrong method on an ask path is not an ask route: it falls to the jobs family (self) or nothing.
    expect(phoneFamily("GET", "/api/phones/self/share")).toBe("jobs");
    expect(phoneFamily("POST", "/api/phones/self/targets")).toBe("jobs");
    expect(phoneFamily("GET", "/api/phones/ask-revoke")).toBeNull();
    expect(phoneFamily("GET", "/api/other")).toBeNull();
  });
  it("gates each family by its own flag", () => {
    const askOnly = askBase, jobsOnly = { ...askBase, features: { phoneTools: true } };
    expect(familyOffered(phoneFamily("POST", "/api/phones/self/share")!, askOnly)).toBe(true);
    expect(familyOffered(phoneFamily("GET", "/api/phones/self/jobs")!, askOnly)).toBe(false);
    expect(familyOffered(phoneFamily("POST", "/api/phones/self/ask")!, jobsOnly)).toBe(false);
    expect(familyOffered(phoneFamily("GET", "/api/phones/self/challenge")!, askOnly)).toBe(true);
    expect(familyOffered(phoneFamily("GET", "/api/phones/self/challenge")!, jobsOnly)).toBe(true);
    expect(familyOffered(phoneFamily("GET", "/api/phones/self/challenge")!, { ...askBase, features: {} })).toBe(false);
    expect(familyOffered("admin", askOnly)).toBe(false);
    expect(familyOffered("admin", jobsOnly)).toBe(true);
  });
});

describe("route policy for the ask paths", () => {
  it("has an entry with a why for each, in the plan's classes", () => {
    for (const [m, p] of [["GET", "/api/phones/self/targets"], ["POST", "/api/phones/self/share"], ["POST", "/api/phones/self/ask"]] as const) {
      expect(routeClass(m, p), p).toBe("phone");
      expect(routePolicy(m, p)?.why.length, p).toBeGreaterThan(10);
    }
    expect(routeClass("POST", "/api/phones/ask-revoke")).toBe("companion");
    expect(routePolicy("POST", "/api/phones/ask-revoke")?.why.length).toBeGreaterThan(10);
  });
});
