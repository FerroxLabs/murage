# Local models and your own engines

## Local models (Ollama, LM Studio, llama.cpp, vLLM, SGLang)

Local servers already do tool calling. Murage uses them through engines that
already run tools (Fuigo, Pi, OpenCode, Qwen, Hermes, Droid, Kimi and, when the
server supports it, Codex and Claude Code), so a bot on a local model can use
files, agents, memory, computers and connected apps just like a cloud bot.

**Settings → Models → Local models** is the one place to manage them.

- **Automatic detection.** Murage looks for Ollama at `127.0.0.1:11434`,
  LM Studio at `:1234`, llama.cpp (or oMLX) at `:8080`, vLLM at `:8000`,
  SGLang at `:30000`, EXO at `:52415` and Unsloth at `:8888`. A server that
  answers shows up on its own, with its models and the context each one
  loaded. If nothing answers, the section says where it looked.
- **Add a server.** For a server on another port, on your home network, on
  your tailnet or behind https, choose **Add a server** and enter its address,
  e.g. `192.168.1.20:8080` or `https://gpu.example.com`. Murage detects the
  server type (you can override it), and takes an optional API key and name.
  - Plain `http://` is allowed only for this computer, home-network addresses
    (10.x, 172.16–31.x, 192.168.x) and tailnet addresses (100.64–127.x).
    Everything else must be `https://`.
  - The key is only ever sent to that server's own address. Murage refuses
    redirects, so a server cannot forward the key somewhere else.
  - Removing a server also removes the engine entries Murage wrote for it.
- **Test.** Pick a model and choose **Test**. Murage checks tool calling the
  way agents use it: tool calls with and without `tool_choice`, streamed tool
  calls, sending a tool result back, a 41-tool schema, plus the Anthropic
  `/v1/messages` and OpenAI `/v1/responses` surfaces. You get one answer:
  - *Tools work — ready for agents*
  - *This model answers but can't use tools* (it replied in text)
  - *Context too small for agents* (with the fix)
  - *Server rejects tools* (with the exact flag to add)
- **Engines.** Fuigo, Pi, OpenCode, Qwen, Hermes, Droid and Kimi can use any
  live local model. **Codex** is offered for a model only after its
  `/v1/responses` test passed, and **Claude Code** only after `/v1/messages`
  passed. Antigravity cannot use local models and does not list them.

### Server flags that make tools work

| Server | What to set |
| --- | --- |
| llama.cpp (`llama-server`) | `--jinja` (the default in current builds), `-c 65536`, and keep the KV cache at `q8_0` or better (`--cache-type-k q8_0 --cache-type-v q8_0`) |
| vLLM | `--enable-auto-tool-choice --tool-call-parser <parser>` (for example `qwen3_coder`, `hermes`, `openai` for gpt-oss, `glm47`, `kimi_k2`), and a `--max-model-len` of 32k or more |
| SGLang | `--tool-call-parser <parser>` and `--context-length` of 32k or more |
| Ollama | a model whose template supports tools (`ollama show <model>` lists `tools`), and enough context: see below |
| LM Studio | a model with native tool support (hammer badge), loaded with a context length of 32k or more |

**Context.** Agents send a system prompt plus every tool schema up front,
often 15k–40k tokens. Below about 32k of loaded context a model silently loses
its tools; 64k is the comfortable size. Murage reads the loaded context from
each server (llama.cpp `/props`, Ollama `/api/ps` and `/api/show`, LM Studio,
vLLM `max_model_len`) and warns before a turn when the prompt would take more
than 70% of it. Pi and Kimi are told the real window instead of a fixed
131k/262k.

**Ollama context.** Ollama's OpenAI-style endpoint cannot raise the context
per request, and its default depends on your GPU memory (4k below 24 GB).
Either:

- choose **Create a 64k copy** on the model in Local models, which runs
  `ollama create` with `num_ctx 65536` for you (Murage checks the copy
  really has it, and shows the exact steps if your Ollama is too old), or
- start Ollama with `OLLAMA_CONTEXT_LENGTH=65536` to raise it for every model.

**KV cache.** Extreme KV-cache quantization (`q4_0`) noticeably degrades tool
calling. Use `q8_0`.

## The OpenAI-compatible endpoint is chat only

The built-in `openai-compat` driver (and the Grok API driver) talks to any
OpenAI-compatible endpoint, hosted or local, but it is **chat only**: no tool
calls, no agents, no files, computers or connected apps. For tools on a local
model, use Local models above. It is labelled "chat only" in the picker and
in Settings → Engines.

It supports multiple instances in `~/.murage/config.json` (restart after
editing):

```json
{
  "instances": {
    "my-endpoint": {
      "driver": "openai-compat",
      "displayName": "My Endpoint",
      "environment": { "MY_ENDPOINT_KEY": "sk-…" },
      "config": {
        "url": "https://api.example.com/v1",
        "apiKeyEnv": "MY_ENDPOINT_KEY",
        "model": "my-model"
      }
    }
  }
}
```

- `apiKeyEnv` names which `environment` value carries the key, so several
  instances can hold different keys without colliding.
- An endpoint on this computer (`127.0.0.1`, `localhost`) needs no key.
  Every other endpoint needs one.
- The driver lists the endpoint's `/models` when it can and keeps your
  `model` as a custom option either way.

## Any ACP agent (a CLI you spawn)

If an agent CLI speaks [ACP](https://agentclientprotocol.com) over stdio (such as
`fx acp`, a Zed-style agent server, or your own wrapper), point a `customAcp`
instance at it:

```json
{
  "instances": {
    "my-agent": {
      "driver": "customAcp",
      "displayName": "My Agent",
      "environment": { "MY_AGENT_TOKEN": "…" },
      "config": { "cli": "my-agent acp" }
    }
  }
}
```

- **`config.cli`** is the whole command, args included (`"npx -y some-agent acp"`
  works). You can also set it from the app: Settings → Engines → *Set CLI…* on
  the instance's row. An instance without a command shows up with exactly that
  hint instead of failing at first message.
- **Sign in first.** The driver has no auth flow of its own; run the CLI once
  in a terminal and log in there; Murage spawns it with your login intact.
- **Model choice stays inside the agent.** The picker shows a single
  "Agent default" entry; whatever the CLI is configured to run is what runs.
- **`environment`** is passed to the CLI child. Foreign provider keys
  (XAI_API_KEY, OPENAI_COMPAT_API_KEY, …) are deliberately stripped so a
  custom CLI can never bill against another engine's login.
- **Permissions** ride ACP's own `session/request_permission`: if your agent
  asks, the request becomes a normal approval card in chat.
- Multiple instances are fine, one per agent.

## Notes

- `config.json` is written with mode 0600; values in `environment` are stored
  as plaintext in that file. Prefer keys scoped to the one engine.
- Local server keys are kept in the data folder with mode 0600 and are never
  shown again after you save them.
- A typo'd `driver` or invalid `config` never breaks the app: the instance
  shows as unavailable with the reason, and the rest of the fleet loads.
