// A computer's screenshot is a picture of whatever is on that screen right
// now: an inbox, a bank page, a password manager. As an ordinary JSON body it
// was cacheable, so a browser or proxy could keep the frame and serve it back
// later, stale and outside the session. Box, VPS and Local VM screenshot
// routes answer through here with no-store (upstream #1568).
import type { ServerResponse } from "node:http";

export function sendScreenshot(res: ServerResponse, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}
