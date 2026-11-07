// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U22 E20 (upstream 65bb767f0, #3606): the engine that takes over at a limit
// lets the owner choose its model, not only the engine's default. Upstream
// edits a multi-engine fallback list; Murage has one limit backup per bot
// (LimitBackupRow), whose model could not be changed after it was picked.
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ instances: [] as unknown[], api: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return { ...original, useState: <T,>(value: T) => [value, () => {}] as const };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: { ...original.initialState, instances: fixture.instances }, dispatch: vi.fn() }) };
});

const { LimitBackupRow, backupModelOptions } = await import("./ThreadFollowControls");

const engine = (instanceId: string, displayName: string, options: string[]) => ({
  instanceId, displayName, driverKind: "openai-compat", enabled: true,
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: options[0], options: options.map((id) => ({ id, label: id.toUpperCase() })) },
}) as unknown as InstanceInfo;

const bot = (limitBackup?: Bot["limitBackup"]) => ({ id: "bot-1", modelSelection: { instanceId: "claude", model: "opus" }, ...(limitBackup ? { limitBackup } : {}) }) as unknown as Bot;

type Picker = { props: { "aria-label"?: string; onChange(event: { target: { value?: string; checked?: boolean } }): void; children?: ReactNode } };
function find(node: ReactNode, label: string): Picker | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, label)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const props = node.props as Picker["props"];
  return props["aria-label"] === label ? (node as unknown as Picker) : find(props.children, label);
}
function findCheckbox(node: ReactNode): Picker | undefined {
  if (Array.isArray(node)) return node.map(findCheckbox).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const props = node.props as Picker["props"] & { type?: string };
  return props.type === "checkbox" ? (node as unknown as Picker) : findCheckbox(props.children);
}

beforeEach(() => {
  fixture.api.mockClear();
  fixture.instances.splice(0, fixture.instances.length, engine("claude", "Claude", ["opus"]), engine("codex", "Codex", ["gpt-a", "gpt-b"]));
});

describe("the limit backup's model", () => {
  it("lets the owner choose any model the backup engine offers", () => {
    const markup = renderToStaticMarkup(createElement(LimitBackupRow, { bot: bot({ selection: { instanceId: "codex", model: "gpt-a" }, routines: false, at: 1 }) }));
    const picker = markup.match(/<select[^>]*aria-label="Model for Codex"[^>]*>(.*?)<\/select>/)?.[1];
    expect(picker).toBeDefined();
    expect(picker).toContain('<option value="gpt-a" selected="">GPT-A</option>');
    expect(picker).toContain('<option value="gpt-b">GPT-B</option>');
  });

  it("shows no model picker until a backup engine is chosen", () => {
    expect(renderToStaticMarkup(createElement(LimitBackupRow, { bot: bot() }))).not.toContain("Model for");
  });

  it("keeps showing a saved model the engine no longer lists", () => {
    const markup = renderToStaticMarkup(createElement(LimitBackupRow, { bot: bot({ selection: { instanceId: "codex", model: "gpt-old" }, routines: false, at: 1 }) }));
    expect(markup).toMatch(/aria-label="Model for Codex"[^>]*>.*<option value="gpt-old" selected="">gpt-old<\/option>/);
    expect(backupModelOptions(undefined, "gone")).toEqual([{ id: "gone", label: "gone" }]);
  });

  it("saves the chosen model and keeps the routines choice", () => {
    const tree = LimitBackupRow({ bot: bot({ selection: { instanceId: "codex", model: "gpt-a" }, routines: true, at: 1 }) });
    find(tree, "Model for Codex")!.props.onChange({ target: { value: "gpt-b" } });
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bots/bot-1/limit-backup", {
      method: "PUT",
      body: JSON.stringify({ selection: { instanceId: "codex", model: "gpt-b" }, routines: true }),
    });
  });

  it("offers no engine model list for a backup on a provider account, and keeps the account (Astra r1 Medium)", () => {
    const tree = LimitBackupRow({ bot: bot({ selection: { instanceId: "codex", model: "acct-model", connectionId: "acct-2" }, routines: false, at: 1 }) });
    expect(find(tree, "Model for Codex")).toBeUndefined();
    findCheckbox(tree)!.props.onChange({ target: { checked: true } });
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bots/bot-1/limit-backup", {
      method: "PUT",
      body: JSON.stringify({ selection: { instanceId: "codex", model: "acct-model", connectionId: "acct-2" }, routines: true }),
    });
  });

  it("turning routines on keeps the chosen model instead of resetting it to the default", () => {
    const tree = LimitBackupRow({ bot: bot({ selection: { instanceId: "codex", model: "gpt-b" }, routines: false, at: 1 }) });
    findCheckbox(tree)!.props.onChange({ target: { checked: true } });
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bots/bot-1/limit-backup", {
      method: "PUT",
      body: JSON.stringify({ selection: { instanceId: "codex", model: "gpt-b" }, routines: true }),
    });
  });

  it("picking an engine still starts on its default model", () => {
    const tree = LimitBackupRow({ bot: bot() });
    find(tree, "When this engine is at its limit")!.props.onChange({ target: { value: "codex" } });
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bots/bot-1/limit-backup", {
      method: "PUT",
      body: JSON.stringify({ selection: { instanceId: "codex", model: "gpt-a" }, routines: false }),
    });
  });
});
