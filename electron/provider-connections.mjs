// Shared pure provider binding policy. No filesystem, credential reads or network.
export const PROVIDER_PRESETS = Object.freeze({
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", catalogUrl: "https://api.anthropic.com/v1/models", protocol: "anthropic" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", catalogUrl: "https://api.openai.com/v1/models", protocol: "openai" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", catalogUrl: "https://openrouter.ai/api/v1/models", protocol: "openai" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", catalogUrl: "https://api.deepseek.com/models", protocol: "openai" },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", catalogUrl: "https://api.mistral.ai/v1/models", protocol: "openai" },
  flux: { label: "Flux Router", baseUrl: "https://api.fluxrouter.ai/v1", catalogUrl: "https://api.fluxrouter.ai/v1/models", protocol: "openai" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", catalogUrl: "https://api.groq.com/openai/v1/models", protocol: "openai" },
  xai: { label: "xAI", baseUrl: "https://api.x.ai/v1", catalogUrl: "https://api.x.ai/v1/models", protocol: "openai" },
});
const plain = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const secret = value => typeof value === "string" && value.trim().length >= 8 && value.length <= 4096 && !/[\r\n\x00]/.test(value);
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\x00-\x1f]/.test(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function parseProviderBank(raw) {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string" || raw.length > 200000) fail("Saved model connections are unreadable. Original credentials were preserved.");
  let bank; try { bank = JSON.parse(raw); } catch { fail("Saved model connections are unreadable. Original credentials were preserved."); }
  if (!Array.isArray(bank) || bank.length > 32) fail("Saved model connections are invalid.");
  const seen = new Set();
  for (const row of bank) {
    if (!plain(row) || Object.keys(row).some(key => !["id", "preset", "label", "enabled", "key", "revision"].includes(key)) || !id(row.id) || seen.has(row.id) || !Object.hasOwn(PROVIDER_PRESETS, row.preset) || !label(row.label) || typeof row.enabled !== "boolean" || !secret(row.key) || !id(row.revision)) fail("Saved model connections are invalid.");
    seen.add(row.id);
  }
  return structuredClone(bank);
}
export function assertProviderKey(preset, key) {
  if (!Object.hasOwn(PROVIDER_PRESETS, preset) || !secret(key)) fail("Choose a provider and paste a valid model API key.");
  if (key.startsWith("sk-admin-")) fail("Use an inference API key, not an OpenAI admin key.");
  const known = key.startsWith("sk-ant-") ? "anthropic" : key.startsWith("sk-flux-") ? "flux" : key.startsWith("sk-or-") ? "openrouter" : /^sk-(?:proj|svcacct)-/.test(key) ? "openai" : key.startsWith("xai-") ? "xai" : key.startsWith("gsk_") ? "groq" : null;
  if (known && known !== preset) fail("This key appears to belong to a different provider. Choose its provider before saving.");
}
/** Caller supplies fresh opaque IDs; create/update never sends a key anywhere. */
export function mutateProviderBank(raw, input, createId) {
  const bank = parseProviderBank(raw);
  if (!plain(input)) fail("Invalid model connection change.");
  if (input.action === "create") {
    if (Object.keys(input).some(key => !["action", "preset", "label", "key"].includes(key))) fail("Only a provider, account label and key can be supplied.");
    assertProviderKey(input.preset, input.key);
    if (bank.length >= 32) fail("You can save up to 32 model connections.");
    const name = input.label === undefined ? PROVIDER_PRESETS[input.preset].label : input.label;
    if (!label(name)) fail("Use an account label of at most 80 characters.");
    bank.push({ id: createId(), preset: input.preset, label: name.trim(), enabled: true, key: input.key.trim(), revision: createId() });
  } else if (input.action === "update" || input.action === "remove") {
    const allowed = input.action === "remove" ? ["action", "id", "revision"] : ["action", "id", "revision", "label", "key", "enabled"];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail("The provider and endpoint cannot be changed in place.");
    const index = bank.findIndex(row => row.id === input.id);
    if (index < 0) fail("Model connection not found.", 404);
    if (bank[index].revision !== input.revision) fail("This connection changed. Refresh it before saving.", 409);
    if (input.action === "remove") bank.splice(index, 1);
    else {
      if (input.label !== undefined && !label(input.label)) fail("Use an account label of at most 80 characters.");
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail("Enabled must be true or false.");
      if (input.key !== undefined) assertProviderKey(bank[index].preset, input.key);
      bank[index] = { ...bank[index], ...(input.label === undefined ? {} : { label: input.label.trim() }), ...(input.key === undefined ? {} : { key: input.key.trim() }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }), revision: input.key !== undefined || input.enabled !== undefined ? createId() : bank[index].revision };
    }
  } else fail("Choose create, update or remove.");
  return parseProviderBank(JSON.stringify(bank));
}

export function providerBankRevision(raw) { return JSON.stringify(parseProviderBank(raw).map(row => [row.id, row.revision, row.label, row.enabled])); }
