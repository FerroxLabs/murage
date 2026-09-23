// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What each kind of finding means, in words an owner acts on.
const MESSAGES: Record<string, string> = {
  "credential-access": "Reads passwords, keys or tokens",
  "credential-mention": "Mentions where passwords or keys are kept",
  "network-exfiltration": "Sends data to an outside website",
  "shell-execution": "Runs risky commands on the computer",
  "filesystem-write": "Changes files outside its own folder",
  "instruction-override": "Tells the bot to ignore its instructions",
  "obfuscation": "Hides content in encoded text",
  "index-poisoning": "Its search words don't match what it does",
  "hidden-text": "Contains text you cannot see",
  "direction-override": "Contains characters that reorder text to hide it",
  "padding": "Hides text far down the page",
  "Prompt Injection": "Tries to take over the bot's instructions",
  "Data Exfiltration": "Sends data to an outside website",
  "Privilege Escalation": "Tries to get more access than it needs",
  "Supply Chain": "Downloads and runs outside code",
  "Excessive Agency": "Acts without asking first",
  "Output Handling": "Passes its output on in a risky way",
  "System Prompt Leakage": "Tries to reveal the bot's private instructions",
  "Memory Poisoning": "Tries to plant false memories",
  "Tool Misuse": "Uses tools in risky ways",
  "Rogue Agent": "Tries to act beyond its job",
  "Agent Snooping": "Looks into other bots' or apps' data",
  "Anti-Refusal": "Pressures the bot not to say no",
  "Server-Side Request Forgery": "Reaches into private network addresses",
  "Insecure Deserialization": "Loads data in a risky way",
  "Harmful Content": "Contains harmful instructions",
};
export function plainMessage(category: string): string {
  return MESSAGES[category] ?? "Contains something worth a look";
}
