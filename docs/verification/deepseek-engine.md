# DeepSeek Harness

U22 C24 adapts OpenMausBot commit 404a36b37. Murage runs the owner's installed
`dsh --profile acp`; it does not bundle dsh. The Settings install card offers
`npm install -g @deepseek-ai/dsh` and links to the upstream project. Configure the key in dsh's own home or set
`DEEPSEEK_API_KEY` in the engine's launch environment. A key saved for a Murage
provider account is a separate account and is not silently selected for dsh.

Fuigo remains first. DeepSeek appears in new and existing product fleets.
Explicit model Refresh opens an empty ACP discovery session, reads each
model's native thinking options, closes it and stops the process. Startup
uses the last catalog without starting dsh. Model IDs stay `provider/model`
in Murage and become the native JSON pair on the wire. Resume uses
`session/resume` with the same binding, model-confirmation and submission
fences as the other ACP drivers. Phone tools use the shared scoped MCP mount.

Container fixture proof: `server/drivers/acp/deepseek.test.ts` covers an
isolated two-turn conversation with a model pair and different thinking
choices, explicit discovery, fleet registration, native credentials and
credential stripping. It uses no real key or owner's home. This is protocol
fixture evidence, not packaged real-engine or Cloud qualification. Cloud
launching remains subject to the existing runnable-engine qualification.
