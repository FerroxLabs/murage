// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { classifyLevel, type LevelFacts, type LevelInput } from "./browser-levels.ts";

function decide(facts: LevelFacts, extra: Partial<LevelInput> = {}) {
  return classifyLevel({ operation: facts.operation, key: facts.key, facts, floor: null,
    category: "normal", mode: "full", routine: false, grants: { l1: true, l2: true },
    siteAllowedAlways: true, intent: "pass", checker: "allow", ...extra });
}

describe("CLS D1 decisions", () => {
  const ownerActions = ["Change password", "Reset password", "Enable 2FA", "Disable two-factor authentication",
    "Sharing settings", "Change permissions", "Make public", "Revoke", "Close account", "Delete account", "Grant access",
    "Cambiar contraseña", "Changer le mot de passe", "Passwort ändern", "Alterar senha", "パスワードを変更", "修改密码", "पासवर्ड बदलें"];

  it.each(ownerActions)("hands %s to the owner despite Full and allowing checks", name => {
    for (const mode of ["step", "task", "full"] as const) {
      for (const routine of [false, true]) {
        for (const shape of [
          { operation: "click" }, { operation: "press", key: "Enter" },
          { operation: "press", key: " " }, { operation: "check" },
        ]) {
          const result = decide({ ...shape, name }, { mode, routine });
          expect(result.level, `${name} ${mode} ${shape.operation}`).toBe("floor");
          expect(result.needsCard).toBe(false);
        }
      }
    }
  });

  it.each(["Delete", "DeleteForever", "Remove", "RemoveItem", "Eliminar", "Supprimer", "Löschen", "Excluir", "削除", "删除", "हटाएं",
    "De\u2066lete", "x".repeat(200) + " Delete"])("always asks for %s", name => {
    for (const facts of [{ operation: "click", name }, { operation: "press", key: "Enter", tag: "button", name },
      { operation: "click", ...(name.length < 200 ? { name: "Next", ariaLabel: name } : { name }), submits: true },
      { operation: "dialog_accept", dialog: { kind: "confirm", text: name + " this item?" } }]) {
      const result = decide(facts);
      expect(result.level).toBe("L3");
      expect(result.needsCard).toBe(true);
    }
  });

  it("leaves recipient and send decisions to the recipient facts", () => {
    expect(decide({ operation: "click", name: "Send" })).toMatchObject({ level: "L3", needsCard: false });
  });

  it("rechecks resolved labels and accepted dialogs", () => {
    expect(decide({ operation: "click", tag: "label", name: "Next", labelControl: { tag: "button", name: "Make public" } }).level).toBe("floor");
    expect(decide({ operation: "dialog_accept", dialog: { kind: "confirm", text: "Revoke access?" } }).level).toBe("floor");
    expect(decide({ operation: "click", name: "Change password", frame: { host: "embedded.example.test", readable: false } }).level).toBe("floor");
  });

  it("keeps reads and ordinary Full actions available", () => {
    expect(decide({ operation: "snapshot", name: "Change password" })).toMatchObject({ level: "L1", needsCard: false });
    expect(decide({ operation: "click", tag: "button", name: "Post" })).toMatchObject({ level: "L3", needsCard: false });
    expect(decide({ operation: "dialog_dismiss", dialog: { kind: "confirm", text: "Close account?" } })).toMatchObject({ level: "L2", needsCard: false });
  });
});
