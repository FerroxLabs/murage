// `tailscale serve`, as the desktop app drives it.
//
// Three properties are pinned here, and each of them is a way this has
// already gone wrong or could:
//
//   1. It refuses to overwrite a serve config that belongs to something else.
//      `serve --https=443` silently replaces whatever is on 443, so the read
//      has to happen before the write and a foreign target has to stop it.
//   2. Failure is classified, not swallowed. Missing CLI, signed out, no
//      certificates on the tailnet and a taken port each have a different
//      next step, and "command failed" is the next step for none of them.
//   3. Funnel is never adopted and never reversed. It is the public internet,
//      one word from the tailnet-only subcommand this module uses.
import { describe, expect, it } from "vitest";

import {
  classifyServeFailure,
  disableServe,
  enableServe,
  readServeStatus,
  sameTarget,
  serveState,
} from "./companion-remote-access.mjs";

const NAME = "seans-macbook-pro.tail0a48a4.ts.net";
const TARGET = "http://127.0.0.1:8813";

/** The exact shape `tailscale serve status --json` printed on 1.98 with our
 * own arrangement in place. Copied from the live machine, not invented. */
const OURS = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: TARGET } } } },
});

/** A scripted CLI. `calls` is the record the refusal tests assert against:
 * the point of refusing is that no write happens, and the only proof of that
 * is the absence of the write in this list. */
function fakeTailscale(script) {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    const reply = script[key] ?? script.default ?? { ok: true, stdout: "", stderr: "" };
    return typeof reply === "function" ? reply(cli, args) : reply;
  };
  return { run, calls };
}

const found = { ok: true, stdout: "1.98.8", stderr: "" };

describe("reading what serve is already doing", () => {
  it("recognises our own arrangement", () => {
    expect(readServeStatus(OURS, { proxyTarget: TARGET })).toEqual({ owner: "ours", host: NAME });
  });

  it("refuses mixed 443 owners even when our matching entry appears first", async () => {
    const mixed = JSON.parse(OURS);
    mixed.Web["other.tail1234.ts.net:443"] = {Handlers:{"/":{Proxy:"http://127.0.0.1:3000"}}};
    expect(readServeStatus(JSON.stringify(mixed),{proxyTarget:TARGET}).owner).toBe("other");
    const {run,calls} = fakeTailscale({version:found,"serve status --json":{ok:true,stdout:JSON.stringify(mixed),stderr:""}});
    expect((await disableServe({run,proxyTarget:TARGET})).reason).toBe("conflict");
    expect(calls.some(call=>call.endsWith(" off"))).toBe(false);
  });

  it("does not adopt another proxy path on the same socket", () => {
    expect(sameTarget(`${TARGET}/another-service`,TARGET)).toBe(false);
  });

  it("treats an empty config as a free port", () => {
    expect(readServeStatus("{}", { proxyTarget: TARGET })).toEqual({ owner: "none" });
    expect(readServeStatus("", { proxyTarget: TARGET })).toEqual({ owner: "none" });
  });

  it("refuses a 443 that belongs to something else, and names it", () => {
    const theirs = JSON.stringify({
      TCP: { 443: { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    const read = readServeStatus(theirs, { proxyTarget: TARGET });
    expect(read.owner).toBe("other");
    expect(read.conflict).toContain("http://127.0.0.1:3000");
    expect(read.conflict).toContain("will not overwrite");
  });

  it("refuses a config that also serves a second mount we did not create", () => {
    const extra = JSON.stringify({
      Web: {
        [`${NAME}:443`]: {
          Handlers: { "/": { Proxy: TARGET }, "/grafana": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    });
    expect(readServeStatus(extra, { proxyTarget: TARGET }).owner).toBe("other");
  });

  it("refuses rather than adopting or reversing a Funnel", () => {
    // Funnel publishes to the public internet. It was somebody's deliberate
    // act; taking it over — in either direction — is not ours to do.
    const funnelled = JSON.stringify({
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: TARGET } } } },
      AllowFunnel: { [`${NAME}:443`]: true },
    });
    const read = readServeStatus(funnelled, { proxyTarget: TARGET });
    expect(read.owner).toBe("other");
    expect(read.conflict).toMatch(/Funnel/);
  });

  it("refuses a raw TCP forward sitting on the same port", () => {
    const tcp = JSON.stringify({ TCP: { 443: { TCPForward: "127.0.0.1:9000" } } });
    expect(readServeStatus(tcp, { proxyTarget: TARGET }).owner).toBe("other");
  });

  it("reads unparseable output as 'do not touch it', never as 'nothing there'", () => {
    // A parse failure treated as an empty config would overwrite exactly the
    // configuration it failed to read.
    const read = readServeStatus("<html>proxy error</html>", { proxyTarget: TARGET });
    expect(read.owner).toBe("unknown");
    expect(read.conflict).toContain("will not overwrite");
  });

  it("does not mistake serve's own normalisation for a foreign target", () => {
    expect(sameTarget("127.0.0.1:8813", "http://127.0.0.1:8813")).toBe(true);
    expect(sameTarget("http://localhost:8813", "http://127.0.0.1:8813")).toBe(true);
    expect(sameTarget("http://127.0.0.1:8812", "http://127.0.0.1:8813")).toBe(false);
    expect(sameTarget("", "http://127.0.0.1:8813")).toBe(false);
  });
});

describe("failure gets a reason, not a shrug", () => {
  it("tells a signed-out Tailscale apart from a broken one", () => {
    expect(classifyServeFailure("not logged in, run tailscale up").reason).toBe("logged-out");
    expect(classifyServeFailure("Logged out.").reason).toBe("logged-out");
  });

  it("names the tailnet certificate setting when that is what is missing", () => {
    const { reason, message } = classifyServeFailure(
      "HTTPS is disabled for your tailnet; enable HTTPS in the admin console",
    );
    expect(reason).toBe("no-certificates");
    expect(message).toContain("admin console");
    // And says the fallback is still there, because it is.
    expect(message).toContain("plain HTTP");
  });

  it("names an old CLI rather than reporting a generic failure", () => {
    expect(classifyServeFailure("flag provided but not defined: -bg").reason).toBe("unsupported");
  });

  it("quotes the first line of anything else", () => {
    const { reason, message } = classifyServeFailure("something went sideways\nstack\ntrace");
    expect(reason).toBe("failed");
    expect(message).toContain("something went sideways");
    expect(message).not.toContain("stack");
  });
});

describe("turning it on", () => {
  it("says Tailscale is missing rather than failing opaquely", async () => {
    const { run, calls } = fakeTailscale({ default: { ok: false, stdout: "", stderr: "ENOENT" } });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state.available).toBe(false);
    expect(state.reason).toBe("missing");
    expect(state.message).toContain("not installed");
    expect(calls.some((call) => call.startsWith("serve --bg"))).toBe(false);
  });

  it("REFUSES to clobber a serve config that belongs to something else", async () => {
    const theirs = JSON.stringify({
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: theirs, stderr: "" },
    });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state.on).toBe(false);
    expect(state.reason).toBe("conflict");
    expect(state.message).toContain("http://127.0.0.1:3000");
    // The whole point: it read, and then it did not write.
    expect(calls.some((call) => call.startsWith("serve --bg"))).toBe(false);
  });

  it("is a no-op when the arrangement is already ours", async () => {
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: OURS, stderr: "" },
    });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state).toMatchObject({ on: true, host: NAME, reason: null });
    expect(calls.some((call) => call.startsWith("serve --bg"))).toBe(false);
  });

  it("serves tailnet-only on 443 and reads the host back out of the config", async () => {
    let configured = false;
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": () => ({ ok: true, stdout: configured ? OURS : "{}", stderr: "" }),
      [`serve --bg --https=443 ${TARGET}`]: () => {
        configured = true;
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state).toMatchObject({ available: true, on: true, host: NAME });
    // `--bg` or it dies with the app. `--https=443` or the link needs a port.
    expect(calls).toContain(`serve --bg --https=443 ${TARGET}`);
    // And never, under any circumstance, the other subcommand.
    expect(calls.some((call) => call.includes("funnel"))).toBe(false);
  });

  it("does not claim success when serve accepted the request but is not serving", async () => {
    const { run } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: "{}", stderr: "" },
      [`serve --bg --https=443 ${TARGET}`]: { ok: true, stdout: "", stderr: "" },
    });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state.on).toBe(false);
    expect(state.message).toContain("plain HTTP");
  });

  it("passes a tailnet with no certificates through as its own reason", async () => {
    const { run } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: "{}", stderr: "" },
      [`serve --bg --https=443 ${TARGET}`]: {
        ok: false,
        stdout: "",
        stderr: "HTTPS is not enabled for your tailnet",
      },
    });
    const state = await enableServe({ run, proxyTarget: TARGET });
    expect(state.reason).toBe("no-certificates");
    expect(state.on).toBe(false);
  });
});

describe("turning it off", () => {
  it("removes our arrangement", async () => {
    let configured = true;
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": () => ({ ok: true, stdout: configured ? OURS : "{}", stderr: "" }),
      "serve --https=443 off": () => {
        configured = false;
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    const state = await disableServe({ run, proxyTarget: TARGET });
    expect(state.on).toBe(false);
    expect(calls).toContain("serve --https=443 off");
  });

  it("leaves somebody else's config exactly where it found it", async () => {
    const theirs = JSON.stringify({
      Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: theirs, stderr: "" },
    });
    const state = await disableServe({ run, proxyTarget: TARGET });
    expect(state.on).toBe(false);
    expect(state.reason).toBe("conflict");
    expect(calls).not.toContain("serve --https=443 off");
  });
});

describe("reading state without changing it", () => {
  it("never writes", async () => {
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": { ok: true, stdout: OURS, stderr: "" },
    });
    await serveState({ run, proxyTarget: TARGET });
    expect(calls).toEqual(["version", "serve status --json"]);
  });

  it("refuses an unexplained read failure instead of treating it as an empty config", async () => {
    const { run, calls } = fakeTailscale({
      version: found,
      "serve status --json": { ok: false, stdout: "", stderr: "" },
    });
    expect(await serveState({ run, proxyTarget: TARGET })).toMatchObject({
      available: true,
      on: false,
      reason: "failed",
    });
    expect((await enableServe({run,proxyTarget:TARGET})).on).toBe(false);
    expect(calls.some(call=>call.startsWith("serve --bg"))).toBe(false);
  });
});
