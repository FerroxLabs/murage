// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for the floor facts collector, with a fake CDP `io`. The page-side
// functions are exercised for real in scripts/browser-floor-facts.node-test.mjs.
import { describe, expect, it } from "vitest";
import { classifyFloor } from "./browser-floor.ts";
import {
  COLLECT_FLOOR_FACTS_SOURCE,
  COLLECT_RECIPIENTS_SOURCE,
  CURRENCY_SOURCE,
  EFFECT_TARGET_SOURCE,
  KEY_INFO_SOURCE,
  RELATED_ELEMENTS_SOURCE,
  collectFloorFacts,
  type FloorFactsIo,
} from "./browser-floor-facts.ts";

const DOC = { tabId: 1, navigationEpoch: 1 } as never;
const TARGET = { backendNodeId: 10, document: DOC };

type Call = { method: string; params: Record<string, any> };
type Overrides = Partial<Record<string, (params: Record<string, any>) => unknown>>;

/** A fake io. Every CDP method has a default answer; a test overrides the ones it cares about. */
function fakeIo(raw: Record<string, unknown>, overrides: Overrides = {}) {
  const calls: Call[] = [];
  const io: FloorFactsIo = {
    async world() {
      if (overrides.world) return overrides.world({}) as number;
      return 7;
    },
    async send(method, params) {
      calls.push({ method, params: params as Record<string, any> });
      const custom = overrides[method];
      if (custom) return custom(params as Record<string, any>);
      switch (method) {
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "main", url: "http://127.0.0.1:9/checkout?token=SECRET#x", name: "" } } };
        case "DOM.resolveNode":
          return { object: { objectId: "target" } };
        case "Runtime.callFunctionOn": {
          if ((params as any).functionDeclaration === EFFECT_TARGET_SOURCE) return { result: { objectId: "effect" } };
          if ((params as any).functionDeclaration === RELATED_ELEMENTS_SOURCE) return { result: { objectId: "related" } };
          return { result: { value: raw } };
        }
        case "DOM.describeNode":
          return { node: { backendNodeId: 11 } };
        case "Runtime.getProperties":
          return { result: [] };
        case "Accessibility.getPartialAXTree":
          return { nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card number" }, properties: [] }] };
        default:
          return {};
      }
    },
  };
  return { io, calls };
}

const baseRaw = {
  tag: "input",
  type: "tel",
  fieldName: "cc-number card_number",
  autocomplete: "",
  fallbackName: "Card number",
  // The page checked the AX name and description against every live field value and found none.
  nameHasValue: false,
  descriptionHasValue: false,
  page: { urlPath: "/checkout", title: "Checkout" },
};

describe("collectFloorFacts: effect target and names", () => {
  it("a click on a label collects the control's facts, with the AX call made on the control", async () => {
    const { io, calls } = fakeIo(baseRaw);
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    // The effect target was resolved in the page, with the operation as data, never as source.
    const effect = calls.find(c => c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === EFFECT_TARGET_SOURCE);
    expect(effect?.params.objectId).toBe("target");
    expect(effect?.params.arguments).toEqual([{ value: "click" }, { value: null }]);
    const ax = calls.find(c => c.method === "Accessibility.getPartialAXTree");
    expect(ax?.params.backendNodeId).toBe(11);
    const collect = calls.find(c => c.method === "Runtime.callFunctionOn" && c.params.functionDeclaration === COLLECT_FLOOR_FACTS_SOURCE);
    expect(collect?.params.objectId).toBe("effect");
    expect(facts.name).toBe("Card number");
    expect(facts.tag).toBe("input");
    expect(facts.type).toBe("tel");
    expect(facts.role).toBe("textbox");
    expect(facts.factsFailed).toBeUndefined();
  });

  it("a wrapping label: no AX name falls back to the page-side label text", async () => {
    const { io } = fakeIo(baseRaw, { "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "" } }] }) });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(facts.name).toBe("Card number");
  });

  it("aria-labelledby: the AX name wins over the fallback", async () => {
    const { io } = fakeIo({ ...baseRaw, fallbackName: "something else" }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Billing card" }, description: { value: "As printed on the card" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "fill", {});
    expect(facts.name).toBe("Billing card");
    expect(facts.description).toBe("As printed on the card");
  });

  it("the key reaches the page function as data, and a press carries the key into the facts", async () => {
    const { io, calls } = fakeIo({ ...baseRaw, submits: true });
    const facts = await collectFloorFacts(io, TARGET, "press", { key: "Enter" });
    const effect = calls.find(c => c.params.functionDeclaration === EFFECT_TARGET_SOURCE);
    expect(effect?.params.arguments).toEqual([{ value: "press" }, { value: "Enter" }]);
    expect(facts.operation).toBe("press");
    expect(facts.key).toBe("Enter");
    expect(facts.submits).toBe(true);
  });

  it("reads checked and required from the AX properties", async () => {
    const { io } = fakeIo({ tag: "input", type: "checkbox", nameHasValue: false, descriptionHasValue: false }, {
      "Accessibility.getPartialAXTree": () => ({
        nodes: [{ backendDOMNodeId: 11, role: { value: "checkbox" }, name: { value: "I agree to the Terms" }, properties: [{ name: "checked", value: { type: "tristate", value: "true" } }, { name: "required", value: { type: "boolean", value: true } }] }],
      }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.checked).toBe(true);
    expect(facts.required).toBe(true);
    expect(facts.name).toBe("I agree to the Terms");
  });

  it("an end to end click on a terms checkbox classifies as consent", async () => {
    const { io } = fakeIo({ tag: "input", type: "checkbox", fallbackName: "I agree to the Terms of Service", nameHasValue: false }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "checkbox" }, name: { value: "I agree to the Terms of Service" } }] }),
    });
    const result = classifyFloor(await collectFloorFacts(io, TARGET, "click", {}));
    expect(result.floor).toBe("consent");
  });
});

describe("collectFloorFacts: no value leak", () => {
  it("never copies a field value, however the page side reports it", async () => {
    const secret = "hunter2-PASSWORD-VALUE";
    const typed = "plain-typed-TEXT-VALUE";
    const { io } = fakeIo({
      ...baseRaw,
      type: "password",
      // Anything outside the declared shape must be dropped, not forwarded.
      value: secret,
      fieldValue: typed,
      innerText: typed,
      password: secret,
      form: { action: "/login", method: "post", fields: [{ type: "password", names: "Password", value: secret }, { type: "text", names: "Username", value: typed }] },
      snippets: { form: "Sign in", dialog: "", landmark: "", before: "", after: "" },
    }, {
      "Accessibility.getPartialAXTree": () => ({
        nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Password" }, value: { type: "string", value: secret }, properties: [{ name: "value", value: { value: typed } }] }],
      }),
    });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    const json = JSON.stringify(facts);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(typed);
    expect(facts.form?.hasPasswordField).toBe(true);
  });

  it("drops an accessible name or description that contains a live field value (H1)", async () => {
    const { io, calls } = fakeIo({ ...baseRaw, nameHasValue: true, descriptionHasValue: true, fallbackName: "Card number" }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card number 4111 1111 1111 1111" }, description: { value: "Ends 4111 1111 1111 1111" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(JSON.stringify(facts)).not.toContain("4111");
    expect(facts.name).toBe("Card number");
    expect(facts.description).toBeUndefined();
    // The page received the AX strings to test them; no value had to leave the page.
    const collect = calls.find(c => c.params.functionDeclaration === COLLECT_FLOOR_FACTS_SOURCE);
    expect(collect?.params.arguments[0].value.name).toBe("Card number 4111 1111 1111 1111");
    expect(classifyFloor(facts).floor).toBe("credentials");
  });

  it("an AX name the page did not clear is not used (fail closed)", async () => {
    const { nameHasValue: _n, descriptionHasValue: _d, ...unchecked } = baseRaw;
    const { io } = fakeIo({ ...unchecked, fallbackName: "Card number" }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card number SECRET-AX-9" }, description: { value: "SECRET-AX-9" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(JSON.stringify(facts)).not.toContain("SECRET-AX-9");
    expect(facts.name).toBe("Card number");
  });

  it("when the page function fails the AX name is not used, since nothing checked it", async () => {
    const { io } = fakeIo(baseRaw, {
      "Runtime.callFunctionOn": params => (params.functionDeclaration === EFFECT_TARGET_SOURCE ? { result: { objectId: "effect" } } : { exceptionDetails: { text: "boom" } }),
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card SECRET-AX-7" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(facts.factsFailed).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("SECRET-AX-7");
    expect(classifyFloor(facts).floor).not.toBeNull();
  });
});

describe("collectFloorFacts: Opus gate fixes", () => {
  it("M4: a password field tied to the form by form= sets the flag, and submitting floors", async () => {
    const { io } = fakeIo({ tag: "button", type: "submit", submits: true, nameHasValue: false, fallbackName: "Continue", form: { action: "/x", method: "post", fields: [{ type: "text", names: "Username", idName: "u" }, { type: "password", names: "", idName: "p" }] } }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "button" }, name: { value: "Continue" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.form?.hasPasswordField).toBe(true);
    expect(classifyFloor(facts).rule).toBe("submit-credentials-form");
  });

  it("M5: a target inside a frame is factsFailed and keeps the AX name and role, so it never reads as frame-other", async () => {
    const { io } = fakeIo({ inFrame: true, frame: { host: "pay.example.net", path: "/checkout" }, nameHasValue: false, descriptionHasValue: false }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "button" }, name: { value: "Place order" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
    expect(facts.name).toBe("Place order");
    expect(facts.role).toBe("button");
    expect(facts.frame).toEqual({ host: "pay.example.net", path: "/checkout", readable: false });
    const result = classifyFloor(facts);
    expect(result.rule).not.toBe("frame-other");
    expect(result.floor).toBe("payment");
  });

  it("M5: a frame target whose name the frame could not clear drops the name and is still floor", async () => {
    const { io } = fakeIo({ inFrame: true, frame: { host: "pay.example.net", path: "/" } }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "SECRET-FRAME-1" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("SECRET-FRAME-1");
    expect(classifyFloor(facts).floor).not.toBeNull();
  });

  it("L1: a press whose focus sits in a frame drops the frame element's own name and is floor-unsure", async () => {
    const { io } = fakeIo({ inFrame: true, frameElement: true, frame: { host: "widgets.example", path: "/w" }, nameHasValue: false }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "iframe" }, name: { value: "Help widget" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "press", { key: "Enter" });
    expect(facts.factsFailed).toBe(true);
    expect(facts.name).toBeUndefined();
    expect(classifyFloor(facts).unsure).toBe(true);
  });

  it("L3: the frame list is capped at 50", async () => {
    const childFrames = Array.from({ length: 80 }, (_, i) => ({ frame: { id: `f${i}`, url: `https://f${i}.example/x`, name: "" } }));
    const { io } = fakeIo(baseRaw, { "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: "https://shop.example/" }, childFrames } }) });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.page?.frames?.length).toBe(50);
  });

  it("L4: a form whose fields passed the cap is factsFailed", async () => {
    const { io } = fakeIo({ ...baseRaw, fieldsCapped: true, form: { fields: [] } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
  });

  it("L5: the currency pattern given to the page runs in linear time", () => {
    const re = new RegExp(CURRENCY_SOURCE.source, CURRENCY_SOURCE.flags);
    const started = performance.now();
    expect(re.test("1".repeat(60000) + "x")).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
    expect(re.test("Total 1,234.56 USD")).toBe(true);
    expect(re.test("$19.00")).toBe(true);
    expect(re.test("version 2026 notes")).toBe(false);
  });
});

describe("collectFloorFacts: Opus gate round 2", () => {
  const keyInfo = () => new Function(`return (${KEY_INFO_SOURCE});`)() as (key: unknown) => { enter: boolean; space: boolean; mod: boolean };

  it("N1: the page reads every spelling of Enter as Enter, and a missing or unknown key too", () => {
    const info = keyInfo();
    for (const key of ["Enter", "Return", "enter", "RETURN", "NumpadEnter", "numpadenter", "Shift+Enter", "Control+Enter", "ControlOrMeta+Return", "Alt+NumpadEnter", "\n", "\r", "\r\n", undefined, null, "", "Unidentified", "Execute"]) {
      expect(info(key).enter, JSON.stringify(key)).toBe(true);
    }
    for (const key of ["Tab", "a", "Shift+A", " ", "Space", "Spacebar", "Escape", "ArrowDown", "F5", "+", "Control+s"]) {
      expect(info(key).enter, JSON.stringify(key)).toBe(false);
    }
    expect(info("Shift+Space").space).toBe(true);
    expect(info(" ").space).toBe(true);
    expect(info("Control+s").mod).toBe(true);
    expect(info("Shift+A").mod).toBe(false);
  });

  it("N1: Enter in a login form's email field floors as credentials however the key is spelt", async () => {
    // What the page side reports once Enter reaches the default submit button (proved in the real-Chrome test).
    const raw = { tag: "button", type: "submit", submits: true, nameHasValue: false, descriptionHasValue: false, fallbackName: "Log in", form: { action: "/login", method: "post", fields: [{ type: "email", names: "Email", idName: "email" }, { type: "password", names: "Password", idName: "pw" }] } };
    for (const key of ["Enter", "Return", "enter", "NumpadEnter", "Shift+Enter", "Control+Enter", "\n", "\r", "\r\n", undefined]) {
      const { io, calls } = fakeIo(raw, { "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "button" }, name: { value: "Log in" } }] }) });
      const facts = await collectFloorFacts(io, TARGET, "press", key === undefined ? {} : { key });
      const effect = calls.find(c => c.params.functionDeclaration === EFFECT_TARGET_SOURCE);
      expect(effect?.params.arguments[1]).toEqual({ value: key ?? null });
      expect(classifyFloor(facts).floor, String(key)).toBe("credentials");
    }
  });

  it("N1/N3: an unsure submit stays unsure (no submits field), never an explicit false", async () => {
    const { submits: _s, ...rest } = { ...baseRaw, submits: undefined };
    const facts = await collectFloorFacts(fakeIo({ ...rest, tag: "textarea", type: undefined }).io, TARGET, "press", { key: "Enter" });
    expect("submits" in facts).toBe(false);
  });

  it("N5: a closed shadow root under the effect target makes the facts partial and drops the AX name and description", async () => {
    const { io, calls } = fakeIo(baseRaw, {
      "DOM.describeNode": params => (params.pierce
        ? { node: { backendNodeId: 11, nodeName: "X-CARD", shadowRoots: [{ nodeName: "#document-fragment", shadowRootType: "closed", children: [{ nodeName: "INPUT" }] }] } }
        : { node: { backendNodeId: 11 } }),
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "Card SECRETCLOSED-1" }, description: { value: "SECRETCLOSED-2" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    const pierce = calls.find(c => c.method === "DOM.describeNode" && c.params.pierce === true);
    expect(pierce?.params).toMatchObject({ objectId: "effect", depth: -1, pierce: true });
    expect(facts.factsFailed).toBe(true);
    expect(facts.name).toBeUndefined();
    expect(facts.description).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain("SECRETCLOSED");
    // Whether a partial read of a known control is floor is the classifier's call (see REPORT, round 2 notes).
  });

  it("N5: a closed shadow root inside a label or labelledby target does the same", async () => {
    const { io, calls } = fakeIo(baseRaw, {
      "Runtime.getProperties": params => (params.objectId === "related" ? { result: [{ name: "0", value: { type: "object", objectId: "label-1" } }, { name: "length", value: { type: "number", value: 1 } }] } : { result: [] }),
      "DOM.describeNode": params => (params.objectId === "label-1"
        ? { node: { backendNodeId: 30, nodeName: "LABEL", children: [{ nodeName: "X-PIN", shadowRoots: [{ shadowRootType: "closed" }] }] } }
        : { node: { backendNodeId: 11, nodeName: "INPUT", shadowRoots: [{ shadowRootType: "user-agent" }] } }),
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "PIN SECRETCLOSED-3" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(calls.some(c => c.method === "DOM.describeNode" && c.params.objectId === "label-1" && c.params.pierce === true)).toBe(true);
    expect(facts.factsFailed).toBe(true);
    expect(facts.name).toBeUndefined();
    expect(JSON.stringify(facts)).not.toContain("SECRETCLOSED");
  });

  it("N5: open and user-agent shadow roots are read normally", async () => {
    const { io } = fakeIo(baseRaw, {
      "DOM.describeNode": () => ({ node: { backendNodeId: 11, nodeName: "INPUT", shadowRoots: [{ shadowRootType: "user-agent" }], children: [{ nodeName: "X-OPEN", shadowRoots: [{ shadowRootType: "open" }] }] } }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBeUndefined();
    expect(facts.name).toBe("Card number");
  });

  it("N5: when the closed-root check cannot run, the facts are partial and the AX name is not used", async () => {
    const { io } = fakeIo(baseRaw, {
      "DOM.describeNode": params => { if (params.pierce) throw new Error("describe refused"); return { node: { backendNodeId: 11 } }; },
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "textbox" }, name: { value: "SECRETCLOSED-4" } }] }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("SECRETCLOSED");
  });
});

describe("collectFloorFacts: snippets, form and page", () => {
  it("caps every snippet at 1,000 characters and before and after at 300", async () => {
    const long = "a".repeat(5000);
    const { io } = fakeIo({ ...baseRaw, snippets: { form: long, dialog: long, landmark: long, before: "b".repeat(5000), after: "c".repeat(5000) } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.snippets?.form?.length).toBe(1000);
    expect(facts.snippets?.dialog?.length).toBe(1000);
    expect(facts.snippets?.landmark?.length).toBe(1000);
    expect(facts.snippets?.before?.length).toBe(300);
    expect(facts.snippets?.after?.length).toBe(300);
    // Before keeps the END of the text (the part nearest the target), after keeps the start.
    const { io: io2 } = fakeIo({ ...baseRaw, snippets: { before: "x".repeat(400) + "NEAR", after: "NEAR" + "y".repeat(400) } });
    const near = await collectFloorFacts(io2, TARGET, "click", {});
    expect(near.snippets?.before?.endsWith("NEAR")).toBe(true);
    expect(near.snippets?.after?.startsWith("NEAR")).toBe(true);
  });

  it("derives the form flags from field descriptors and keeps the form action without its query", async () => {
    const { io } = fakeIo({
      tag: "button", type: "submit", submits: true,
      form: {
        action: "https://shop.example/pay?session=SECRET", method: "POST", hasCurrencyAmount: true,
        fields: [
          { type: "text", autocomplete: "cc-number", names: "Card number", idName: "cc" },
          { type: "tel", autocomplete: "one-time-code", names: "Code", idName: "code" },
          { type: "password", autocomplete: "", names: "Password", idName: "pw" },
        ],
      },
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.form).toMatchObject({ action: "https://shop.example/pay", method: "post", hasPasswordField: true, hasOneTimeCodeField: true, hasCardFields: true, hasCurrencyAmount: true });
    expect(JSON.stringify(facts)).not.toContain("SECRET");
  });

  it("a plain form has no credential flags", async () => {
    const { io } = fakeIo({ tag: "button", type: "submit", form: { action: "/subscribe", method: "post", fields: [{ type: "email", autocomplete: "email", names: "Email address", idName: "email" }] } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.form?.hasPasswordField).toBe(false);
    expect(facts.form?.hasOneTimeCodeField).toBe(false);
    expect(facts.form?.hasCardFields).toBe(false);
  });

  it("page facts: path without query, title, child frame hosts, signature booleans", async () => {
    const { io } = fakeIo({ ...baseRaw, page: { urlPath: "/checkout", title: "Checkout", hasCurrencyAmount: true } }, {
      "Page.getFrameTree": () => ({
        frameTree: {
          frame: { id: "main", url: "https://shop.example/checkout?x=1" },
          childFrames: [
            { frame: { id: "a", url: "https://js.stripe.com/v3/elements-inner-card.html?secret=1", name: "__privateStripeFrame1" } },
            { frame: { id: "b", url: "https://www.google.com/recaptcha/api2/anchor?k=1", name: "" } },
            { frame: { id: "c", url: "about:blank", name: "sp_message_iframe_123" } },
          ],
        },
      }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.page?.urlPath).toBe("/checkout");
    expect(facts.page?.title).toBe("Checkout");
    expect(facts.page?.hasCurrencyAmount).toBe(true);
    expect(facts.page?.hasPaymentFrame).toBe(true);
    expect(facts.page?.hasCaptcha).toBe(true);
    expect(facts.page?.hasConsentManager).toBe(true);
    expect(facts.page?.frames).toEqual([
      { host: "js.stripe.com", path: "/v3/elements-inner-card.html" },
      { host: "www.google.com", path: "/recaptcha/api2/anchor" },
    ]);
    expect(JSON.stringify(facts)).not.toContain("secret=1");
  });

  it("signature booleans for the target come from the page side; a challenge page from the title or path", async () => {
    const { io } = fakeIo({ ...baseRaw, signatures: { consentManager: false, captcha: true, payment: false }, page: { urlPath: "/cdn-cgi/challenge-platform/h/b", title: "Just a moment..." } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.signatures).toEqual({ consentManager: false, captcha: true, payment: false, challengePage: true });
  });

  it("a target inside a frame reports the frame, unreadable, with its signature booleans", async () => {
    const { io } = fakeIo({ inFrame: true, frame: { host: "js.stripe.com", path: "/v3/x" } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.frame).toEqual({ host: "js.stripe.com", path: "/v3/x", readable: false });
    expect(facts.signatures?.payment).toBe(true);
  });

  it("carries consentOptionalOn and wasPassword when the page side knows them, leaves them out when it does not", async () => {
    const known = await collectFloorFacts(fakeIo({ ...baseRaw, consentOptionalOn: false, wasPassword: true }).io, TARGET, "click", {});
    expect(known.consentOptionalOn).toBe(false);
    expect(known.wasPassword).toBe(true);
    const unknown = await collectFloorFacts(fakeIo(baseRaw).io, TARGET, "click", {});
    expect("consentOptionalOn" in unknown).toBe(false);
    expect("wasPassword" in unknown).toBe(false);
  });

  it("carries the dialog being answered, capped, and needs no target", async () => {
    const { io, calls } = fakeIo({});
    const facts = await collectFloorFacts(io, { document: DOC }, "dialog_accept", { dialog: { kind: "confirm", text: "d".repeat(5000) } });
    expect(facts.dialog?.kind).toBe("confirm");
    expect(facts.dialog?.text.length).toBe(1000);
    expect(calls.some(c => c.method === "DOM.resolveNode")).toBe(false);
    expect(facts.page?.urlPath).toBeUndefined(); // the frame-tree path never goes out (gate ruling)
  });

  it("visibility: reports the page-side block, unknown fields are null", async () => {
    const box = { x: 10, y: 20, width: 100, height: 30 };
    const { io } = fakeIo({ ...baseRaw, visibility: { box, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: 'div#overlay "Win a prize"' } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.visibility).toEqual({ box, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: 'div#overlay "Win a prize"' });
    const bare = await collectFloorFacts(fakeIo({}).io, TARGET, "click", {});
    expect(bare.visibility).toEqual({ box: null, inViewport: null, opacity: null, visibility: null, ariaHidden: null, coveredBy: null });
  });
});

describe("collectFloorFacts: failures are floor, never a throw", () => {
  it("an AX call that rejects gives factsFailed, with what was gathered", async () => {
    const { io } = fakeIo(baseRaw, { "Accessibility.getPartialAXTree": () => { throw new Error("AX unavailable"); } });
    const facts = await collectFloorFacts(io, TARGET, "type", {});
    expect(facts.factsFailed).toBe(true);
    expect(facts.tag).toBe("input");
    expect(facts.name).toBe("Card number"); // the page-side fallback
    expect(facts.page?.urlPath).toBe("/checkout");
  });

  it("an isolated world that refuses gives factsFailed and no throw", async () => {
    const { io } = fakeIo(baseRaw, { world: () => { throw new Error("world refused"); } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.operation).toBe("click");
    expect(facts.factsFailed).toBe(true);
  });

  it("a target that cannot be resolved (frame, gone) gives factsFailed but keeps page facts", async () => {
    const { io } = fakeIo(baseRaw, { "DOM.resolveNode": () => { throw new Error("No node with given id found"); } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
    expect(facts.page?.urlPath).toBeUndefined(); // the frame-tree path never goes out (gate ruling)
    expect(classifyFloor(facts).floor).not.toBeNull();
  });

  it("a page function that throws gives factsFailed", async () => {
    const { io } = fakeIo(baseRaw, {
      "Runtime.callFunctionOn": params => (params.functionDeclaration === EFFECT_TARGET_SOURCE
        ? { result: { objectId: "effect" } }
        : { exceptionDetails: { text: "Uncaught", exception: { description: "boom" } } }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
  });

  it("an unreachable frame tree gives factsFailed", async () => {
    const { io } = fakeIo(baseRaw, { "Page.getFrameTree": () => { throw new Error("frame gone"); } });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
  });

  it("garbage from the page side gives factsFailed, not a crash", async () => {
    for (const bad of [null, "text", 42, []]) {
      const { io } = fakeIo({}, { "Runtime.callFunctionOn": params => (params.functionDeclaration === EFFECT_TARGET_SOURCE ? { result: { objectId: "effect" } } : { result: { value: bad } }) });
      const facts = await collectFloorFacts(io, TARGET, "click", {});
      expect(facts.factsFailed).toBe(true);
    }
  });

  it("a call that never answers is cut off at the deadline", async () => {
    const { io } = fakeIo(baseRaw, { "DOM.resolveNode": () => new Promise(() => undefined) });
    const facts = await collectFloorFacts(io, TARGET, "click", { timeoutMs: 30 });
    expect(facts.factsFailed).toBe(true);
    expect(facts.operation).toBe("click");
  });
});

describe("page functions are plain data-driven source strings", () => {
  it("both compile as function expressions and contain no template slots", () => {
    for (const source of [EFFECT_TARGET_SOURCE, COLLECT_FLOOR_FACTS_SOURCE]) {
      expect(() => new Function(`return (${source});`)).not.toThrow();
      expect(source.trimStart().startsWith("function")).toBe(true);
    }
  });

  it("field values are read in one place only (liveValues), never outside it", () => {
    // Outside liveValues() the only `.value` read is a button's own value attribute; no innerText or textContent anywhere.
    const start = COLLECT_FLOOR_FACTS_SOURCE.indexOf("const liveValues=");
    const end = COLLECT_FLOOR_FACTS_SOURCE.indexOf("/*liveValues-end*/");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const outside = COLLECT_FLOOR_FACTS_SOURCE.slice(0, start) + COLLECT_FLOOR_FACTS_SOURCE.slice(end);
    expect((outside.match(/\.value\b/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(COLLECT_FLOOR_FACTS_SOURCE).not.toMatch(/innerText/);
  });
});

describe("Opus gate follow-up: the frame-tree path never goes out when the page read fails", () => {
  it("world refused: no path from Page.getFrameTree in the facts", async () => {
    const { io } = fakeIo(baseRaw, { world: () => { throw new Error("world refused"); }, "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: "https://shop.example/reset/TOKENABCDEF123456/confirm" } } }) });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("TOKENABCDEF123456");
    expect(facts.page?.urlPath).toBeUndefined();
  });
  it("page function returns no path: the frame-tree path is not used either", async () => {
    const { io } = fakeIo({ ...baseRaw, page: {} }, { "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: "https://shop.example/reset/TOKENABCDEF123456/confirm" } } }) });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(JSON.stringify(facts)).not.toContain("TOKENABCDEF123456");
  });
});

// Round 8: every token the scan returns carries the descriptor of the field it came from; a token with none is not trusted.
const described = <T extends { recipients: string[] }>(value: T): T & { fields: unknown[] } => ({ ...value, fields: value.recipients.map(() => ({ type: "email", autocomplete: "", names: "To", idName: "to", masked: false })) });
describe("T21 recipients (intent rule I2)", () => {
  const withRecipients = (value: unknown, extra: Overrides = {}) => fakeIo({ ...baseRaw, type: "submit", tag: "button", submits: true }, {
    "Runtime.callFunctionOn": params => {
      if (params.functionDeclaration === COLLECT_RECIPIENTS_SOURCE) return typeof value === "function" ? (value as () => unknown)() : { result: { value } };
      if (params.functionDeclaration === EFFECT_TARGET_SOURCE) return { result: { objectId: "effect" } };
      if (params.functionDeclaration === RELATED_ELEMENTS_SOURCE) return { result: { objectId: "related" } };
      return { result: { value: { ...baseRaw, type: "submit", tag: "button", submits: true } } };
    },
    ...extra,
  });
  it("a send click carries the recipients the page scan found", async () => {
    const { io } = withRecipients(described({ recipients: ["ana@example.com", "+15551234567"], incomplete: false }));
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.recipients).toEqual(["ana@example.com", "+15551234567"]);
  });
  it("the scan runs on the effect target, and not for a read-only operation", async () => {
    const { io, calls } = withRecipients({ recipients: ["a@b.co"], incomplete: false });
    await collectFloorFacts(io, TARGET, "click", {});
    expect(calls.some(c => c.params.functionDeclaration === COLLECT_RECIPIENTS_SOURCE && c.params.objectId === "effect")).toBe(true);
    const quiet = withRecipients({ recipients: ["a@b.co"], incomplete: false });
    const read = await collectFloorFacts(quiet.io, TARGET, "scroll", {});
    expect(read.recipients).toBeUndefined();
  });
  it("a failing, malformed or junk scan leaves the list absent and does not fail the floor facts", async () => {
    for (const bad of [() => { throw new Error("page"); }, { recipients: "ana@example.com" }, { recipients: [7, "", null] }, null, { exceptionDetails: {}, result: {} }]) {
      const { io } = withRecipients(bad);
      const facts = await collectFloorFacts(io, TARGET, "click", {});
      expect(facts.recipients).toBeUndefined();
      expect(facts.factsFailed).not.toBe(true);
      // T22: the list is unknown, and the facts say so, so I2 does not stay silent.
      expect(facts.recipientScanFailed).toBe(true);
    }
  });
  it("a scan that worked, even with nothing found, does not set the failure flag", async () => {
    for (const ok of [described({ recipients: [], incomplete: false }), described({ recipients: ["a@b.co"], incomplete: false })]) {
      const { io } = withRecipients(ok);
      expect((await collectFloorFacts(io, TARGET, "click", {})).recipientScanFailed).toBeUndefined();
    }
    const quiet = withRecipients({ recipients: ["a@b.co"], incomplete: false });
    expect((await collectFloorFacts(quiet.io, TARGET, "scroll", {})).recipientScanFailed).toBeUndefined();
  });
  it("the list is capped at 20 entries of at most 254 characters", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `u${i}@example.com`).concat(["x".repeat(300) + "@a.co"]);
    const { io } = withRecipients(described({ recipients: many, incomplete: false }));
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.recipients).toHaveLength(20);
    expect(facts.recipientScanFailed).toBe(true);
    expect(facts.recipients!.every(item => item.length <= 254)).toBe(true);
  });
  it("H3: a scan that says it is incomplete is unknown recipients, with what it found still listed", async () => {
    const { io } = withRecipients(described({ recipients: ["ana@example.com"], incomplete: true }));
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.recipientScanFailed).toBe(true);
    expect(facts.recipients).toEqual(["ana@example.com"]);
  });
  it("H3: a scan that does not say it is complete is unknown too", async () => {
    const { io } = withRecipients({ recipients: [] });
    expect((await collectFloorFacts(io, TARGET, "click", {})).recipientScanFailed).toBe(true);
  });
});


describe("Round 2: open shadow context", () => {
  it("does not turn an open root without a form into incomplete facts", async () => {
    const { io } = fakeIo({ ...baseRaw, tag: "button", type: "button", fieldName: "", fallbackName: "Open action", shadowNoForm: true }, {
      "Accessibility.getPartialAXTree": () => ({ nodes: [{ backendDOMNodeId: 11, role: { value: "button" }, name: { value: "Open action" } }] }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 11, shadowRoots: [{ shadowRootType: "open" }] } }),
    });
    const facts = await collectFloorFacts(io, TARGET, "click", {});
    expect(facts.factsFailed).not.toBe(true);
    expect(classifyFloor(facts).floor).toBeNull();
  });
});
