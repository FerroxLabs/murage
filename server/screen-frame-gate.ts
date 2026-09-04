// Which turns earn a settled screenshot in the transcript.
//
// The screen poller folds a turn's last frame into the chat on turn end.
// Two questions decide whether that frame is worth the reader's attention,
// and both are answered here, pure, so they can be pinned down in tests:
//   1. did the tool that just completed act on (or look at) the screen — a
//      shell command over computer_exec or a status read does not count,
//      however the driver happens to spell the tool's name;
//   2. is the end frame different from the one the transcript already
//      shows — a boxAgent turn starts as screen work by definition, so this
//      is what keeps its shell-only replies from re-picturing the same idle
//      desktop.
import { createHash } from "node:crypto";

/** Tools that change or show the screen, by their bare MCP names. One list
 * for every computer surface, because the poke site only has the name: the
 * cloud box and remote computers (server/computer-proxy.ts), the built-in
 * browser (server/drivers/browser-proxy.ts) and Cua Driver's own surface
 * for the local Mac, Local VM and VPS (docs/computer-use-integration.md).
 *
 * Deliberately NOT here: computer_exec (a shell — no screenshot unless
 * asked, and the ask is not visible at the poke site); the read-only text
 * tools (computer_status, browser_state, browser_snapshot, browser_read,
 * observation_metrics, start_session, get_*, list_*, check_permissions);
 * the waits (wait_for, wait_for_navigation, browser_wait_for — they change
 * nothing, and the action they follow already counted); and the takeover
 * pleas (computer_request_help, browser_request_takeover — whatever changed
 * during those was the person's doing, and captures are withheld under
 * their lease anyway). */
const SCREEN_TOUCHING_TOOLS = new Set([
  // cloud box / remote computer
  "screenshot",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "computer_batch",
  "open_url",
  "browser_click",
  "browser_fill",
  // built-in browser
  "browser_navigate",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_hover",
  "browser_drag",
  "browser_select_option",
  "browser_back",
  "browser_forward",
  "browser_screenshot",
  // Cua Driver (local Mac, Local VM, VPS)
  "double_click",
  "right_click",
  "drag",
  "hotkey",
  "move_cursor",
  "launch_app",
  "bring_to_front",
  "zoom",
]);

/** The same tool reaches the poke site under three spellings: the Claude
 * driver's `mcp__computer__click`, Codex's bare `click`, and pi's
 * `computer_click` (server_tool, lowercased). A server prefix is stripped
 * at most once, so pi's `computer_computer_exec` lands on `computer_exec`
 * — still a shell — and never on a bare `exec`. */
export function screenTouchingTool(toolName: string): boolean {
  const bare = toolName.toLowerCase().replace(/^mcp__.+?__/, "");
  return SCREEN_TOUCHING_TOOLS.has(bare) || SCREEN_TOUCHING_TOOLS.has(bare.replace(/^(?:computer|browser)_/, ""));
}

/** sha256 over the base64 frame — the same fingerprint the model-side
 * observation dedupe uses (server/computer-observation.ts). */
export function screenFrameHash(png: string): string {
  return createHash("sha256").update(png).digest("hex");
}

/** A settled frame is news only when it differs from the frame the reader
 * can already see. With nothing to compare against it fails open, like the
 * observation dedupe does: an unshown screen beats a wrongly hidden one. */
export function settledFrameIsNews(shownFrameHash: string | undefined, png: string): boolean {
  return shownFrameHash === undefined || screenFrameHash(png) !== shownFrameHash;
}
