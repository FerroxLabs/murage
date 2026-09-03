// The link a phone actually follows, and the preconditions the screen states.
//
// The pairing QR carried a `murage://pair` URL for an iOS app that was
// removed from this repository. Scanning it on a phone opened nothing, which
// is why the pairing copy stopped naming a client — the honest thing to do
// with a dead client, and not a fix. The fix is the browser door: the sidecar
// serves this same app over the tailnet, and `/enter#<token>` is the page a
// camera app can open.
//
// The second half of this file is the screen that leads into it. It sold a
// native phone app — "Use Murage from your phone", a phone icon, "Set up my
// phone" — for a product whose phone story is a browser. Copy is not usually
// worth a test; a screen that promises a thing the product cannot do is.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WEB_UI_SUBTITLE,
  WEB_UI_TITLE,
  companionBrowserLink,
  companionDoorUrl,
  typedCodeInstruction,
  webUiReadiness,
  type CompanionBrowserDoor,
  type CompanionState,
} from "./PhoneSetupFlow";

/** A well-formed pairing token: the shape `devices.ts` issues and accepts. */
const TOKEN = `murage_pair_${"A".repeat(43)}`;
const DOOR: CompanionBrowserDoor = { scheme: "http", host: "macbook.tail1234.ts.net", port: 8813 };

const state = (over: Partial<CompanionState> = {}): CompanionState => ({
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [],
  pairing: null,
  ...over,
});

describe("the link the QR carries", () => {
  it("sends a phone to the door's first-contact page with the token in the fragment", () => {
    // The fragment is the whole security design of /enter, not a formatting
    // choice: it never reaches a server, an access log, or a Referer header,
    // and the page strips it from history before its first network call.
    expect(companionBrowserLink(DOOR, TOKEN)).toBe(
      `http://macbook.tail1234.ts.net:8813/enter#${TOKEN}`,
    );
    // Never the query string, which would undo every one of those.
    expect(companionBrowserLink(DOOR, TOKEN)).not.toContain("?");
  });

  it("leaves the port off when it is the scheme's own", () => {
    // `tailscale serve` terminates TLS on 443. A URL that spelled it out
    // would still work and would look like an address someone typed wrong.
    expect(companionBrowserLink({ scheme: "https", host: "macbook.tail1234.ts.net", port: 443 }, TOKEN))
      .toBe(`https://macbook.tail1234.ts.net/enter#${TOKEN}`);
    expect(companionBrowserLink({ scheme: "http", host: "macbook.tail1234.ts.net", port: 80 }, TOKEN))
      .toBe(`http://macbook.tail1234.ts.net/enter#${TOKEN}`);
  });

  it("brackets a bare IPv6 literal", () => {
    // Unbracketed, the first colon of the address reads as the port
    // separator and the link addresses a machine that does not exist.
    expect(companionBrowserLink({ scheme: "http", host: "fd7a:115c:a1e0::4d3b", port: 8813 }, TOKEN))
      .toBe(`http://[fd7a:115c:a1e0::4d3b]:8813/enter#${TOKEN}`);
  });

  it("takes the tailnet address as readily as the name", () => {
    expect(companionBrowserLink({ scheme: "http", host: "100.79.121.109", port: 8813 }, TOKEN))
      .toBe(`http://100.79.121.109:8813/enter#${TOKEN}`);
  });

  it("answers null rather than building a link nothing can open", () => {
    // A malformed link is a QR code somebody points a phone at and gets a
    // blank page from, with nothing on screen saying why. Null is a state
    // the caller renders; a broken string is not.
    expect(companionBrowserLink(null, TOKEN)).toBeNull();
    expect(companionBrowserLink(undefined, TOKEN)).toBeNull();
    expect(companionBrowserLink(DOOR, null)).toBeNull();
    expect(companionBrowserLink(DOOR, undefined)).toBeNull();
    // the six-digit code is not the credential this page redeems
    expect(companionBrowserLink(DOOR, "123456")).toBeNull();
    expect(companionBrowserLink(DOOR, `murage_pair_${"A".repeat(42)}`)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, host: "  " }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 0 }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 70_000 }, TOKEN)).toBeNull();
    expect(companionBrowserLink({ ...DOOR, port: 8813.5 }, TOKEN)).toBeNull();
  });

  it("refuses a host carrying anything that would re-shape the URL", () => {
    // The host comes over IPC from another process. A `/` or a `#` in it
    // would move the path or truncate the fragment, and a `@` would turn the
    // whole thing into userinfo in front of somebody else's host.
    for (const host of [
      "evil.example/x",
      "macbook.ts.net#",
      "macbook.ts.net?a=1",
      "user@evil.example",
      "macbook .ts.net",
      "macbook\\\\evil",
    ]) {
      expect(companionBrowserLink({ ...DOOR, host }, TOKEN), host).toBeNull();
    }
  });

  it("refuses a scheme that is not one of the two", () => {
    // `javascript:` and `data:` are the reason this is an allowlist.
    expect(
      companionBrowserLink({ ...DOOR, scheme: "javascript" as CompanionBrowserDoor["scheme"] }, TOKEN),
    ).toBeNull();
  });
});

describe("what this screen is allowed to promise", () => {
  it("offers a browser, not an app that is not in this repository", () => {
    // `ios/` was deleted. Any copy naming a phone app describes something a
    // user cannot obtain, and the button under it leads to a QR that opens
    // nothing on their phone.
    for (const copy of [WEB_UI_TITLE, WEB_UI_SUBTITLE]) {
      expect(copy).not.toMatch(/\bapp store\b|\bdownload the app\b|\binstall the app\b/i);
    }
    expect(WEB_UI_TITLE).toMatch(/browser/i);
    // Tailscale is the route, and it is named rather than implied.
    expect(WEB_UI_SUBTITLE).toMatch(/Tailscale/);
    // And the thing it is NOT: nothing here is on the internet.
    expect(WEB_UI_SUBTITLE).toMatch(/nothing exposed to the internet/i);
  });

  it("does not borrow the upstream copy that demotes Tailscale", () => {
    // Upstream #669 labels Tailscale "Optional — Secure HTTPS above remains
    // the recommended setup", where their "secure HTTPS" is the cloudflared
    // path this fork keeps dark. Taking that sentence would recommend a door
    // that is switched off.
    for (const copy of [WEB_UI_TITLE, WEB_UI_SUBTITLE]) {
      expect(copy).not.toMatch(/optional/i);
      expect(copy).not.toMatch(/secure HTTPS/i);
    }
  });
});

describe("the preconditions, before the button is pressed", () => {
  it("says it is still asking, and offers nothing to press", () => {
    const asking = webUiReadiness({ state: null, browserDoor: null });
    expect(asking.ready).toBe(false);
    expect(asking.blocker).toBe("Checking this computer…");
    // Nothing to re-probe: the sidecar has not answered once yet.
    expect(asking.canRecheck).toBe(false);
  });

  it("lets the button through when the sidecar is simply off", () => {
    // Pressing it is what starts the sidecar, and every question below is one
    // only a running sidecar can answer. Refusing here would be refusing to
    // let anybody find out.
    const off = webUiReadiness({ state: state({ enabled: false }), browserDoor: null });
    expect(off.ready).toBe(true);
    expect(off.blocker).toBeNull();
    // and it still says what is true right now
    expect(off.tailnetName).toBeNull();
    expect(off.doorAddress).toBeNull();
  });

  it("names Tailscale as the next thing to do, and offers the re-probe", () => {
    const noTailnet = webUiReadiness({ state: state(), browserDoor: null });
    expect(noTailnet.ready).toBe(false);
    expect(noTailnet.blocker).toMatch(/Tailscale isn’t signed in/);
    // The phone's half of the requirement, said before it fails rather than
    // after: both ends have to be on the same tailnet.
    expect(noTailnet.blocker).toMatch(/same tailnet/);
    // Tailscale is routinely installed while this screen is open, and the
    // sidecar read the tailnet once, at boot.
    expect(noTailnet.canRecheck).toBe(true);
  });

  it("distinguishes a missing tailnet from a door that has not come up", () => {
    // Two different things to do, and "it didn't work" is neither of them.
    const noDoor = webUiReadiness({
      state: state({ tailnetName: "macbook.tail1234.ts.net" }),
      browserDoor: null,
    });
    expect(noDoor.ready).toBe(false);
    expect(noDoor.blocker).toMatch(/browser door isn’t listening/);
    expect(noDoor.tailnetName).toBe("macbook.tail1234.ts.net");
  });

  it("is ready, and specific, once both are true", () => {
    const ready = webUiReadiness({
      state: state({ tailnetName: "macbook.tail1234.ts.net" }),
      browserDoor: DOOR,
    });
    expect(ready.ready).toBe(true);
    expect(ready.blocker).toBeNull();
    // The real name and the real address, not "connected".
    expect(ready.tailnetName).toBe("macbook.tail1234.ts.net");
    expect(ready.doorAddress).toBe("macbook.tail1234.ts.net:8813");
  });
});


// The other route through the same credential: a keyboard.
//
// The door has accepted a typed six-digit code since `codeEntryMarkup` and
// `codeEntryScript` landed in `companion/src/browser.ts` — the same digits the
// QR carries, redeemed against the same window. Nothing in the desktop said
// so, and a laptop was told to point a camera it does not have at its own
// screen. These tests hold the desktop to naming both.
describe("the address a keyboard is sent to", () => {
  it("is the door's own origin — no path, no credential", () => {
    // Any HTML GET without a session answers 401 with `signInPage`, and that
    // page carries the typed-code field. So the origin is the whole
    // instruction. `/enter` belongs to the QR, whose token rides in a
    // fragment nobody is going to retype.
    expect(companionDoorUrl(DOOR)).toBe("http://macbook.tail1234.ts.net:8813");
    expect(companionDoorUrl(DOOR)).not.toContain("/enter");
    expect(companionDoorUrl(DOOR)).not.toContain("#");
  });

  it("leaves the port off when it is the scheme's own, and brackets IPv6", () => {
    expect(companionDoorUrl({ scheme: "https", host: "macbook.tail1234.ts.net", port: 443 }))
      .toBe("https://macbook.tail1234.ts.net");
    expect(companionDoorUrl({ scheme: "http", host: "fd7a:115c:a1e0::4d3b", port: 8813 }))
      .toBe("http://[fd7a:115c:a1e0::4d3b]:8813");
  });

  it("refuses an address that would send somebody to another machine", () => {
    // This string is rendered as a link and read out to be typed, and the
    // host arrives over IPC from the sidecar. A `/`, `@` or `#` in it moves
    // the path, the userinfo or the fragment.
    expect(companionDoorUrl(null)).toBeNull();
    expect(companionDoorUrl(undefined)).toBeNull();
    for (const host of ["evil.example/x", "user@evil.example", "macbook.ts.net#", "  "]) {
      expect(companionDoorUrl({ ...DOOR, host }), host).toBeNull();
    }
    expect(companionDoorUrl({ ...DOOR, scheme: "javascript" as CompanionBrowserDoor["scheme"] })).toBeNull();
    expect(companionDoorUrl({ ...DOOR, port: 0 })).toBeNull();
  });
});

describe("what the desktop says about typing the code", () => {
  it("names the address and the act, in that order", () => {
    const typed = typedCodeInstruction("http://macbook.tail1234.ts.net:8813");
    expect(typed.url).toBe("http://macbook.tail1234.ts.net:8813");
    const sentence = `${typed.lead}${typed.url}${typed.tail}`;
    // Where to go...
    expect(sentence).toContain("http://macbook.tail1234.ts.net:8813");
    // ...and what to do there. Without this the address is a fact, not an
    // instruction.
    expect(sentence).toMatch(/type this code/i);
    // Said to somebody who cannot scan, which is the whole reason it exists.
    expect(sentence).toMatch(/camera/i);
  });

  it("still says the code can be typed when there is no address yet", () => {
    // The door may not be up, or this may be the local-network fallback. A
    // sentence with "null" in it is worse than the dead end it replaced.
    const typed = typedCodeInstruction(null);
    expect(typed.url).toBeNull();
    // Nothing dangles. A tail is the second half of a sentence about an
    // address, and with no address to render it would leave a hole on screen
    // — "Open  on that computer" — rather than a missing word anybody notices.
    expect(typed.tail, "with no address there is no second half").toBe("");
    const sentence = `${typed.lead}${typed.tail}`;
    expect(sentence).toMatch(/type this code/i);
    expect(sentence).not.toMatch(/null|undefined/);
    expect(sentence).not.toMatch(/ {2}/);
  });
});

describe("the pairing step puts the code where it can be read", () => {
  const pairingStep = () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PhoneSetupFlow.tsx", import.meta.url)),
      "utf8",
    );
    // From the QR down to the troubleshooting disclosure: the part of the
    // step a person looks at before they go hunting.
    const start = source.indexOf('aria-label="Phone pairing QR code"');
    return source.slice(start, source.indexOf("<details", start));
  };

  it("shows the digits next to the QR rather than inside Having trouble?", () => {
    expect(pairingStep(), "the code must be on screen above the disclosure").toContain(
      "c.state.pairing.code",
    );
  });

  it("does not gate the digits on whether a QR link could be built", () => {
    // That gate was `phonePairingManualCodeMode`: with a link, the code hid
    // in the disclosure. A laptop always has a link and never a camera, so
    // the one device that needed the digits was the one that never saw them.
    expect(pairingStep(), "the code must not depend on a QR-link mode").not.toContain(
      "manualCodeMode",
    );
  });

  it("tells that device where to type them", () => {
    expect(pairingStep()).toContain("typed.url");
  });
});
