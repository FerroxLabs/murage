"use strict";
const CAP = 16384;
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let call = {};
  try { call = JSON.parse(raw) || {}; } catch { call = {}; }
  const tool = typeof call.tool_name === "string" && call.tool_name ? call.tool_name : "tool";
  const input = call.tool_input && typeof call.tool_input === "object" && !Array.isArray(call.tool_input) ? call.tool_input : {};
  let message = JSON.stringify({ murage: 1, v: 1, tool, input, truncated: false });
  if (message.length > CAP) message = JSON.stringify({ murage: 1, v: 1, tool, input: null, truncated: true });
  process.stdout.write(JSON.stringify({ action: "approve", message }));
});
