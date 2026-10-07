// usage: node cdp.mjs <page-url-prefix> <script.js> [json-args | -]
//        node cdp.mjs <page-url-prefix> --crash
// Runs the script's body as `async (args) => { … }` in the first WebView page
// whose URL starts with the prefix, through the forwarded DevTools socket on
// 127.0.0.1:$CDP_PORT (default 29333), and prints the JSON result. Waits up to
// 30 s for the page. --crash kills that page's renderer instead (a real phone
// is not rooted, so `kill` cannot reach the sandboxed renderer): Page.crash,
// then chrome://crash if the renderer is still answering.
import { readFileSync } from "node:fs";

const port = process.env.CDP_PORT || "29333";
const [prefix, file, argv = "{}"] = process.argv.slice(2);
// "-": the arguments come on stdin, so a pairing code never shows in `ps`.
const rawArgs = argv === "-" ? readFileSync(0, "utf8").trim() || "{}" : argv;
const deadline = Date.now() + 30_000;
let page;
while (!page && Date.now() < deadline) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = pages.find((candidate) => candidate.type === "page" && candidate.url.startsWith(prefix));
  } catch {
    // the socket is not forwarded yet
  }
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) {
  console.error(`no WebView page starting with ${prefix}`);
  process.exit(2);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

if (file === "--crash") {
  // Page.crash never answers: the renderer dies under it, and DevTools says so
  // with Inspector.targetCrashed or by closing the socket.
  const done = () => {
    console.log(JSON.stringify("crashed"));
    process.exit(0);
  };
  socket.onclose = done;
  socket.onmessage = (event) => {
    if (JSON.parse(event.data).method === "Inspector.targetCrashed") done();
  };
  socket.send(JSON.stringify({ id: 1, method: "Inspector.enable" }));
  socket.send(JSON.stringify({ id: 2, method: "Page.crash" }));
  setTimeout(() => socket.send(JSON.stringify({ id: 3, method: "Page.navigate", params: { url: "chrome://crash" } })), 3000);
  setTimeout(() => {
    console.error("the renderer is still alive after Page.crash and chrome://crash");
    process.exit(1);
  }, 10_000);
} else {
  // CDP_BYPASS_CSP=1: the page is reloaded with its own CSP set aside, so a
  // check can reach the native guard behind it (a foreign form POST, which the
  // door's form-action 'self' would otherwise stop first).
  if (process.env.CDP_BYPASS_CSP === "1") {
    await new Promise((resolve) => {
      socket.onmessage = (event) => {
        if (JSON.parse(event.data).method === "Page.loadEventFired") resolve();
      };
      socket.send(JSON.stringify({ id: 7, method: "Page.enable" }));
      socket.send(JSON.stringify({ id: 8, method: "Page.setBypassCSP", params: { enabled: true } }));
      socket.send(JSON.stringify({ id: 9, method: "Page.reload" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const expression = `(async (args) => {\n${readFileSync(file, "utf8")}\n})(${rawArgs})`;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    if (message.result?.exceptionDetails) {
      console.error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text);
      process.exit(1);
    }
    console.log(JSON.stringify(message.result?.result?.value ?? null));
    process.exit(0);
  };
  socket.onclose = () => {
    console.error("the page went away before answering");
    process.exit(3);
  };
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
}
