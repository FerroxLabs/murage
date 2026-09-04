// The two gates between a completed turn and a screenshot in the chat. Both
// are pure, so every spelling a driver can hand the poke site — and every
// tool that must NOT count — is pinned down here.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { screenFrameHash, screenTouchingTool, settledFrameIsNews } from "./screen-frame-gate.ts";

describe("screenTouchingTool", () => {
  it("strips the Claude driver's mcp__<server>__ prefix", () => {
    expect(screenTouchingTool("mcp__computer__click")).toBe(true);
    expect(screenTouchingTool("mcp__computer__screenshot")).toBe(true);
    expect(screenTouchingTool("mcp__browser__browser_navigate")).toBe(true);
  });

  it("takes Codex's bare names and pi's server_tool names", () => {
    expect(screenTouchingTool("click")).toBe(true);
    expect(screenTouchingTool("hotkey")).toBe(true);
    expect(screenTouchingTool("computer_click")).toBe(true);
    expect(screenTouchingTool("computer_zoom")).toBe(true);
    expect(screenTouchingTool("computer_computer_batch")).toBe(true);
    expect(screenTouchingTool("browser_browser_navigate")).toBe(true);
    // the box's own Chrome tools live on the computer server
    expect(screenTouchingTool("computer_browser_fill")).toBe(true);
  });

  const acting = [
    "screenshot", "click", "type_text", "press_key", "scroll", "computer_batch", "open_url", "browser_click", "browser_fill",
    "browser_navigate", "browser_type", "browser_press", "browser_scroll", "browser_hover", "browser_drag",
    "browser_select_option", "browser_back", "browser_forward", "browser_screenshot",
    "double_click", "right_click", "drag", "hotkey", "move_cursor", "launch_app", "bring_to_front", "zoom",
  ];
  for (const tool of acting) {
    it(`counts: ${tool}`, () => expect(screenTouchingTool(tool)).toBe(true));
  }

  const bystanders = [
    // the bug: every tool on the computer server is "mcp__computer__…", and
    // a shell command there leaves the desktop exactly as it was
    "mcp__computer__computer_exec",
    "computer_exec",
    "computer_computer_exec",
    // read-only text tools
    "computer_status", "browser_state", "browser_snapshot", "browser_read", "observation_metrics",
    "mcp__browser__browser_snapshot", "browser_browser_read",
    "start_session", "get_window_state", "get_desktop_state", "get_accessibility_tree",
    "list_windows", "list_apps", "check_permissions", "get_screen_size",
    // waits change nothing; the action before them already counted
    "wait_for", "mcp__computer__wait_for", "wait_for_navigation", "browser_wait_for",
    // the person's hands, not the bot's
    "computer_request_help", "browser_request_takeover",
    // not computer tools at all
    "Bash", "Read", "mcp__agents__ask_bot", "mcp__composio__GMAIL_SEND_EMAIL", "screenshot_helper",
  ];
  for (const tool of bystanders) {
    it(`ignores: ${tool}`, () => expect(screenTouchingTool(tool)).toBe(false));
  }
});

describe("settledFrameIsNews", () => {
  const frame = "iVBORw0KGgo-frame-a";

  it("fails open when no frame has been shown yet", () => {
    expect(settledFrameIsNews(undefined, frame)).toBe(true);
  });

  it("is not news when the end frame is byte-identical to the shown one", () => {
    expect(settledFrameIsNews(screenFrameHash(frame), frame)).toBe(false);
  });

  it("is news once a single byte differs", () => {
    expect(settledFrameIsNews(screenFrameHash(frame), "iVBORw0KGgo-frame-b")).toBe(true);
  });

  it("fingerprints with sha256 over the base64, like the observation dedupe", () => {
    expect(screenFrameHash(frame)).toBe(createHash("sha256").update(frame).digest("hex"));
  });
});
