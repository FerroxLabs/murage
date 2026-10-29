// Company that receives the phone's data for an engine, shown in the phone sheet (A9, App Store 5.1.2(i)). In-app only.
// It names whoever actually receives the data, never the router in between, and never Ferrox Labs.
type Company = { id: string; name: string };
const co = (id: string, name: string): Company => ({ id, name });

/** Engines tied to one vendor: that vendor receives the data whatever the model. */
const FIXED: Record<string, Company> = {
  claude: co("anthropic", "Anthropic"),
  claudeAgent: co("anthropic", "Anthropic"),
  codex: co("openai", "OpenAI"),
  geminiAgent: co("google", "Google"),
  antigravityAgent: co("google", "Google"),
  grokAgent: co("xai", "xAI"),
  kimiAgent: co("moonshot", "Moonshot AI"),
  qwenAgent: co("alibaba", "Alibaba Cloud"),
  cursorAgent: co("cursor", "Cursor"),
  droidAgent: co("factory", "Factory"),
};

/** Model id prefix -> the model's maker. */
const MAKERS: ReadonlyArray<readonly [string[], Company]> = [
  [["claude"], co("anthropic", "Anthropic")],
  [["gpt-", "o1", "o3", "o4", "chatgpt"], co("openai", "OpenAI")],
  [["gemini"], co("google", "Google")],
  [["grok"], co("xai", "xAI")],
  [["kimi", "moonshot"], co("moonshot", "Moonshot AI")],
  [["qwen"], co("alibaba", "Alibaba Cloud")],
  [["deepseek"], co("deepseek", "DeepSeek")],
  [["glm", "zai"], co("zhipu", "Zhipu AI")],
  [["mistral", "codestral"], co("mistral", "Mistral AI")],
  [["llama"], co("meta", "Meta")],
];

function makerOfModel(model: string | undefined): Company | null {
  const id = (model ?? "").trim().toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1);
  if (bare.length === 0) return null;
  for (const [prefixes, company] of MAKERS) if (prefixes.some((p) => bare.startsWith(p))) return { ...company };
  return null;
}

/**
 * A fixed-vendor engine names its company whatever the model. Every other kind is a router: it names the model's maker,
 * else the endpoint host (lower case, no port), else a neutral name.
 */
export function aiProviderName(
  driverKind: string,
  opts?: { model?: string; endpointHost?: string },
): { id: string; name: string } {
  if (Object.hasOwn(FIXED, driverKind)) return { ...FIXED[driverKind] };
  const maker = makerOfModel(opts?.model);
  if (maker) return maker;
  const host = (opts?.endpointHost ?? "").trim().toLowerCase().replace(/:\d+$/, "").slice(0, 120);
  if (host.length > 0) return { id: `host:${host}`.slice(0, 64), name: host };
  return { id: "unknown", name: "another AI service" };
}
