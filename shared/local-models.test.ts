import { describe, expect, it } from "vitest";

import {
  AGENT_MIN_CONTEXT_TOKENS,
  classifyIpAddress,
  classifyLocalHostname,
  contextPreflight,
  isValidLocalModelId,
  isValidLocalServerKey,
  isValidLocalServerName,
  llamaCppModelId,
  localEngineLabel,
  localEngineSupport,
  LOCAL_ENGINE_LABELS,
  LOCAL_ENGINE_SURFACE,
  localEnginesFor,
  localServerDisplayLabel,
  normalizeLocalServerAddress,
  plainHttpCandidate,
  type LocalToolTestResult,
} from "./local-models.ts";
import { engineToolSupport } from "./provider-engine.ts";

describe("local server address rule (spec A1)", () => {
  it.each([
    ["127.0.0.1:8080", "http://127.0.0.1:8080/v1", "loopback"],
    ["http://localhost:11434", "http://localhost:11434/v1", "loopback"],
    ["http://[::1]:1234/v1", "http://[::1]:1234/v1", "loopback"],
    ["192.168.1.20:8000", "http://192.168.1.20:8000/v1", "private"],
    ["http://10.0.0.5:30000/", "http://10.0.0.5:30000/v1", "private"],
    ["http://172.16.4.2:8080/v1/", "http://172.16.4.2:8080/v1", "private"],
    ["http://172.31.255.1:8080", "http://172.31.255.1:8080/v1", "private"],
    ["http://100.64.0.1:8080", "http://100.64.0.1:8080/v1", "tailnet"],
    ["http://100.127.255.254:18080", "http://100.127.255.254:18080/v1", "tailnet"],
    ["http://gpubox:11434/v1", "http://gpubox:11434/v1", "local-name"],
    ["http://gpubox.tail0000.ts.net:11434", "http://gpubox.tail0000.ts.net:11434/v1", "local-name"],
    ["nas.local:8080", "http://nas.local:8080/v1", "local-name"],
    ["http://[fd7a:115c:a1e0::5]:8080", "http://[fd7a:115c:a1e0::5]:8080/v1", "tailnet"],
    ["http://[fd12:3456::1]:8080", "http://[fd12:3456::1]:8080/v1", "private"],
    ["https://gpu.example.com/proxy", "https://gpu.example.com/proxy/v1", "public"],
    ["https://gpu.example.com/proxy/v1", "https://gpu.example.com/proxy/v1", "public"],
  ] as const)("accepts %s as %s (%s)", (typed, apiBase, addressClass) => {
    const result = normalizeLocalServerAddress(typed);
    expect(result).toMatchObject({ ok: true, apiBase, addressClass });
    if (result.ok) expect(result.root).toBe(apiBase.replace(/\/v1$/, ""));
  });

  it.each([
    ["http://gpu.example.com:8080", "https-required"],
    ["http://8.8.8.8:8080", "https-required"],
    ["http://172.32.0.1:8080", "https-required"],
    ["http://100.128.0.1:8080", "https-required"],
    ["http://gpu_box:8080", "https-required"],
    ["http://ts.net:8080", "https-required"],
    ["http://gpubox.example.net:8080", "https-required"],
    ["http://[2001:db8::1]:8080", "https-required"],
    ["http://[::ffff:8.8.8.8]:8080", "https-required"],
    ["http://user:pass@127.0.0.1:8080", "credentials-in-address"],
    ["ftp://127.0.0.1/v1", "unsupported-scheme"],
    ["file:///etc/passwd", "unsupported-scheme"],
    ["http://127.0.0.1:8080/v1?key=x", "invalid-address"],
    ["http://127.0.0.1:8080/#frag", "invalid-address"],
    ["http://127.0.0.1:8080/a b", "invalid-address"],
    ["", "invalid-address"],
    [42, "invalid-address"],
  ] as const)("refuses %s with %s", (typed, code) => {
    expect(normalizeLocalServerAddress(typed)).toEqual({ ok: false, code });
  });

  it("classifies only the spec's ranges as allowed over http", () => {
    expect(classifyLocalHostname("127.8.9.10")).toBe("loopback");
    expect(classifyLocalHostname("100.63.255.255")).toBe("public");
    expect(classifyLocalHostname("192.169.0.1")).toBe("public");
    expect(classifyLocalHostname("fd7a:115c:a1e0::1")).toBe("tailnet");
    expect(classifyLocalHostname("[::1]")).toBe("loopback");
  });

  it("marks names that look local as candidates the server must resolve", () => {
    for (const name of ["gpubox", "gpubox.", "gpubox.tail0000.ts.net", "nas.local", "router.lan", "db.internal", "printer.home.arpa"]) {
      expect(classifyLocalHostname(name), name).toBe("local-name");
    }
    for (const name of ["example.com", "gpubox.example.net", "ts.net", "123", "bad_name", "evil.local.example.com"]) {
      expect(classifyLocalHostname(name), name).not.toBe("local-name");
    }
    // "local" alone is a single label, so it is a candidate like any bare name.
    expect(classifyLocalHostname("local")).toBe("local-name");
  });

  it("classifies resolved IP addresses, v4 and v6", () => {
    // Link-local is autoconfiguration space, not somebody's network.
    expect(classifyIpAddress("169.254.10.1")).toBe("public");
    expect(classifyIpAddress("100.100.100.100")).toBe("tailnet");
    expect(classifyIpAddress("::1")).toBe("loopback");
    expect(classifyIpAddress("::ffff:192.168.1.2")).toBe("private");
    expect(classifyIpAddress("::ffff:8.8.8.8")).toBe("public");
    expect(classifyIpAddress("fd7a:115c:a1e0:ab12::1")).toBe("tailnet");
    expect(classifyIpAddress("fc00::1")).toBe("private");
    expect(classifyIpAddress("fe80::1")).toBe("public");
    expect(classifyIpAddress("2606:4700::1111")).toBe("public");
    expect(classifyIpAddress("1::2::3")).toBe("public");
    expect(classifyIpAddress("gpubox")).toBe("public");
  });

  // A cloud instance-metadata / credential endpoint answers plain http to
  // whatever asks and hands back the instance's cloud credentials. None of
  // them is ever a user's model server, so none of them may be classified
  // local — at 0.1.54 they were all `public`, and 0.1.55 widened link-local,
  // ULA and CGNAT until eight of them became plain-http candidates again.
  const METADATA_ENDPOINTS = [
    ["169.254.169.254", "AWS/GCP/Azure/Oracle/DigitalOcean/Hetzner/IBM/OpenStack IMDS"],
    ["169.254.170.2", "AWS ECS task-role credentials"],
    ["169.254.170.23", "AWS ECS/EKS task metadata v4"],
    ["169.254.169.253", "AWS VPC DNS"],
    ["169.254.169.123", "AWS Time Sync"],
    ["169.254.0.23", "Tencent Cloud metadata"],
    ["169.254.255.254", "legacy/Oracle metadata"],
    ["169.254.0.1", "link-local, nothing but autoconfiguration lives here"],
    ["169.254.1.1", "link-local"],
    ["169.254.255.255", "link-local"],
    ["100.100.100.200", "Alibaba Cloud ECS metadata (inside the CGNAT range)"],
    ["fd00:ec2::254", "AWS IMDS over IPv6 (inside the ULA range)"],
    ["fd00:ec2::23", "AWS ECS task metadata over IPv6"],
    ["[fd00:ec2::254]", "AWS IMDS over IPv6, bracketed"],
    ["fe80::a9fe:a9fe", "IPv6 link-local"],
    ["fe80::1", "IPv6 link-local"],
    ["::ffff:169.254.169.254", "IMDS smuggled through an IPv4-mapped v6 literal"],
    ["::ffff:169.254.170.2", "ECS credentials through an IPv4-mapped v6 literal"],
    ["::ffff:100.100.100.200", "Alibaba metadata through an IPv4-mapped v6 literal"],
  ] as const;

  it.each(METADATA_ENDPOINTS)("never classifies %s as local (%s)", (address) => {
    expect(classifyIpAddress(address), address).toBe("public");
    expect(classifyLocalHostname(address), address).toBe("public");
    expect(plainHttpCandidate(classifyIpAddress(address)), address).toBe(false);
  });

  it.each(METADATA_ENDPOINTS)("refuses plain http to %s (%s)", (address) => {
    const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
    expect(normalizeLocalServerAddress(`http://${host}:11434`), address).toEqual({ ok: false, code: "https-required" });
    expect(normalizeLocalServerAddress(`${host}:11434`), address).toEqual({ ok: false, code: "https-required" });
  });

  it("refuses the names a cloud gives its own metadata service", () => {
    for (const name of ["metadata.google.internal", "METADATA.GOOGLE.INTERNAL", "metadata.google.internal.", "metadata"]) {
      expect(classifyLocalHostname(name), name).toBe("public");
      expect(normalizeLocalServerAddress(`http://${name}:80`), name).toEqual({ ok: false, code: "https-required" });
    }
  });

  // The ranges that DO hold real machines keep plain http: closing them would
  // break the Tailscale and ULA setups lane W/X shipped for.
  it("keeps the ranges a real model server plausibly lives on", () => {
    expect(classifyIpAddress("100.64.0.1")).toBe("tailnet");
    expect(classifyIpAddress("100.100.100.199")).toBe("tailnet");
    expect(classifyIpAddress("100.100.100.201")).toBe("tailnet");
    expect(classifyIpAddress("100.100.99.200")).toBe("tailnet");
    expect(classifyIpAddress("100.127.255.254")).toBe("tailnet");
    expect(classifyIpAddress("fd12:3456::1")).toBe("private");
    expect(classifyIpAddress("fd00:ec3::254")).toBe("private");
    expect(classifyIpAddress("fd01:ec2::254")).toBe("private");
    expect(classifyIpAddress("fd7a:115c:a1e0::5")).toBe("tailnet");
    expect(classifyIpAddress("192.168.1.20")).toBe("private");
    expect(classifyIpAddress("10.0.0.5")).toBe("private");
    expect(classifyIpAddress("172.16.4.2")).toBe("private");
    expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
    expect(classifyLocalHostname("gpubox")).toBe("local-name");
    expect(classifyLocalHostname("nas.local")).toBe("local-name");
    expect(classifyLocalHostname("db.internal")).toBe("local-name");
    expect(classifyLocalHostname("gpubox.tail0000.ts.net")).toBe("local-name");
  });

  it("validates names and keys before they reach any engine config", () => {
    expect(isValidLocalServerName("SeanBeast")).toBe(true);
    expect(isValidLocalServerName("GPU box — upstairs")).toBe(true);
    expect(isValidLocalServerName("   ")).toBe(false);
    expect(isValidLocalServerName("line\nbreak")).toBe(false);
    expect(isValidLocalServerName("x".repeat(61))).toBe(false);
    expect(isValidLocalServerKey("sk-local-123")).toBe(true);
    expect(isValidLocalServerKey("has space")).toBe(false);
    expect(isValidLocalServerKey('quote"inside\n')).toBe(false);
  });

  it("names a server the way the picker and card show it", () => {
    expect(localServerDisplayLabel("llamacpp", "seanbeast")).toBe("llama.cpp on seanbeast");
    expect(localServerDisplayLabel("openai", "GPU box")).toBe("GPU box");
    expect(localServerDisplayLabel("ollama", "")).toBe("Ollama");
  });
});

describe("context preflight (spec T2)", () => {
  it("is unknown when the server did not report a window", () => {
    expect(contextPreflight({ promptTokens: 16_000 }).status).toBe("unknown");
  });

  it("flags windows below the agent minimum as too small", () => {
    expect(contextPreflight({ contextWindow: 4_096, promptTokens: 1_000 }).status).toBe("too-small");
    expect(contextPreflight({ contextWindow: AGENT_MIN_CONTEXT_TOKENS - 1, promptTokens: 1_000 }).status).toBe("too-small");
  });

  it("warns when the prompt takes more than 70% of the window", () => {
    const tight = contextPreflight({ contextWindow: 32_768, promptTokens: 24_000 });
    expect(tight.status).toBe("tight");
    expect(tight.ratio).toBeCloseTo(24_000 / 32_768);
    expect(contextPreflight({ contextWindow: 65_536, promptTokens: 16_000 }).status).toBe("ok");
    expect(contextPreflight({ contextWindow: 40_000, promptTokens: 40_000 }).status).toBe("too-small");
  });
});

function test(surfaces: LocalToolTestResult["surfaces"], outcome: LocalToolTestResult["outcome"] = "tools-work"): LocalToolTestResult {
  return { serverId: "srv_abcdef012345", apiBase: "http://127.0.0.1:18080/v1", model: "m", outcome, checks: [], surfaces, testedAt: 1, durationMs: 1 };
}

describe("engine eligibility (spec E3/E4)", () => {
  it("offers chat engines before any test, but not Codex or Claude Code", () => {
    const engines = localEnginesFor(undefined);
    expect(engines).toEqual(expect.arrayContaining(["fuigoAgent", "piAgent", "opencodeGo", "qwenAgent", "hermesAgent"]));
    expect(engines).not.toContain("codex");
    expect(engines).not.toContain("claudeAgent");
  });

  it("adds Codex only after /v1/responses passed and Claude Code only after /v1/messages passed", () => {
    expect(localEnginesFor(test({ chat: true, responses: true, messages: false }))).toContain("codex");
    expect(localEnginesFor(test({ chat: true, responses: true, messages: false }))).not.toContain("claudeAgent");
    expect(localEnginesFor(test({ chat: true, responses: false, messages: true }))).toContain("claudeAgent");
    expect(localEnginesFor(test({ chat: true, responses: false, messages: true }))).not.toContain("codex");
  });

  it("offers nothing for an unreachable server", () => {
    expect(localEnginesFor(test({ chat: false, responses: false, messages: false }, "unreachable"))).toEqual([]);
  });

  it("labels openai-compat and the grok API as chat-only and never offers Antigravity local rows", () => {
    expect(localEngineSupport("openai-compat")).toBe("chat-only");
    expect(localEngineSupport("grok")).toBe("chat-only");
    expect(localEngineSupport("antigravityAgent")).toBe("none");
    expect(localEngineSupport("piAgent")).toBe("tools");
    expect(engineToolSupport("openai-compat")).toBe("chat-only");
    expect(engineToolSupport("grok")).toBe("chat-only");
    for (const driver of ["piAgent", "opencodeGo", "droidAgent", "kimiAgent", "grokAgent", "fuigoAgent"]) {
      expect(engineToolSupport(driver)).toBe("tools");
    }
  });
});

describe("llama-server's model name (0.1.52 LM2, live finding)", () => {
  // Observed on SeanBeast, llama.cpp b1-192067b, 2026-09-11: /v1/models and
  // /props both name the loaded model `D:\Qwen\models\Qwen3.8-27B-UD-Q4_K_M.gguf`.
  // Every id Murage listed was then dropped by the `host::model` grammar, so a
  // running server showed up as "detected, no models" and could not be picked
  // for any bot. The same build answered a request naming `totally-made-up`
  // from the loaded model, which is why the file's own name is a safe stand-in.
  it("recovers a usable id from a Windows path", () => {
    expect(llamaCppModelId("D:\\Qwen\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf")).toBe("Qwen3.8-27B-UD-Q4_K_M");
  });

  it("recovers one from a POSIX path, and leaves a plain id alone", () => {
    expect(llamaCppModelId("/srv/models/gemma-4-31b.gguf")).toBe("gemma-4-31b");
    expect(llamaCppModelId("qwen3.8-27b")).toBe("qwen3.8-27b");
  });

  it("produces an id the picker's own grammar accepts", () => {
    for (const raw of ["D:\\Qwen\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf", "/srv/models/gemma-4-31b.gguf", "C:\\a b\\model name.gguf"]) {
      const id = llamaCppModelId(raw)!;
      expect(id, raw).toBeTruthy();
      expect(isValidLocalModelId(id), raw).toBe(true);
    }
  });

  it("keeps the honest empty answer rather than inventing a name", () => {
    for (const raw of ["", "   ", "/", "D:\\models\\.gguf", 7, null, undefined]) {
      expect(llamaCppModelId(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("engine names (spec V2)", () => {
  it("names every engine that can use a local server the way the app names it", () => {
    expect(Object.keys(LOCAL_ENGINE_SURFACE).every((driver) => LOCAL_ENGINE_LABELS[driver])).toBe(true);
    expect(localEngineLabel("fuigoAgent")).toBe("Fuigo");
    expect(localEngineLabel("piAgent")).toBe("pi");
    expect(localEngineLabel("claudeAgent")).toBe("Claude");
  });

  it("falls back to the driver id rather than rendering nothing", () => {
    expect(localEngineLabel("somethingNew")).toBe("somethingNew");
  });
});
