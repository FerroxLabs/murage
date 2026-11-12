// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No limits copy follows the 1.0.19 ruling: wipe-only questions, saved permission rules bypassed, disabled features off,
// and Ask for other people unless the owner explicitly set the bot. No Windows exception.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OUTSIDE_SOURCE_KEYS, localizeCallCardText, localizeOutsideNote } from "@/lib/outside-note";
import { outsideTurnNote } from "../../server/auto-approve.ts";
import { callCardText } from "../../server/bot-calls-card.ts";
import type { CallIntent } from "../../server/bot-calls-machine.ts";
import { en as allEnglish } from "./index";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const codes = readdirSync(DIR).filter((file) => file.endsWith(".json") && file !== "source-hashes.json").map((file) => file.slice(0, -5)).sort();
const load = (code: string) => JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
const KEYS = ["noLimits.v1.warning", "noLimits.v1.outsideNote", "noLimits.v1.callOutside", "noLimits.v1.callOutsideUnnamed", "noLimits.v1.openclaw", "noLimits.v1.windows", "noLimits.v1.engineAsks", "permissionMenu.ownTools", ...Object.values(OUTSIDE_SOURCE_KEYS)];

describe("NOLIMITS v1 copy in every pack", () => {
  it("ships the 8 packs", () => {
    expect(codes).toEqual(["de", "en", "es", "fr", "hi", "ja", "pt-br", "zh"]);
  });
  for (const code of codes) {
    it(`${code} has the warning, engine and shell limits, and every source name; N keeps {source}`, () => {
      const pack = load(code);
      for (const key of KEYS) expect(pack[key], `${code}:${key}`).toBeTruthy();
      expect(pack["noLimits.v1.outsideNote"]).toContain("{source}");
      for (const key of KEYS) expect(pack[key]).not.toMatch(/—|\bfree\b|\bForge\b/i);
    });
  }
  const permissionAndFeatureCopy = {
  "en": {
    "run": "Saved permission rules do not block actions.",
    "off": "Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.",
    "wipe": "Only a likely wipe or catastrophe asks first.",
    "guest": "Other people's chats stay at Ask unless you explicitly set that bot's level."
  },
  "de": {
    "run": "Gespeicherte Berechtigungsregeln blockieren keine Aktionen.",
    "off": "Gespeicherte Berechtigungsregeln blockieren keine Aktionen. Vollständig ausgeschaltete Funktionen bleiben aus, bis du sie einschaltest.",
    "wipe": "Nur bei einer wahrscheinlichen vollständigen Löschung oder einer Katastrophe wird vorher gefragt.",
    "guest": "Chats anderer Personen bleiben bei „Fragen“, außer du hast die Stufe dieses Bots ausdrücklich festgelegt."
  },
  "es": {
    "run": "Las reglas de permisos guardadas no bloquean acciones.",
    "off": "Las reglas de permisos guardadas no bloquean acciones. Las funciones que desactivaste por completo siguen desactivadas hasta que las actives.",
    "wipe": "Solo se pregunta antes de un probable borrado total o una catástrofe.",
    "guest": "Los chats de otras personas siguen en Preguntar, salvo que hayas elegido expresamente el nivel de ese bot."
  },
  "fr": {
    "run": "Les règles d’autorisation enregistrées ne bloquent aucune action.",
    "off": "Les règles d’autorisation enregistrées ne bloquent aucune action. Les fonctions que tu as entièrement désactivées le restent jusqu’à leur réactivation.",
    "wipe": "Seul un effacement total probable ou une catastrophe déclenche une demande préalable.",
    "guest": "Les chats des autres restent sur Demander, sauf si tu as choisi explicitement le niveau de ce bot."
  },
  "hi": {
    "run": "सहेजे गए अनुमति नियम कार्रवाई नहीं रोकते।",
    "off": "सहेजे गए अनुमति नियम कार्रवाई नहीं रोकते। जिन सुविधाओं को आपने पूरी तरह बंद किया है, वे आपके चालू करने तक बंद रहती हैं।",
    "wipe": "केवल सारा डेटा मिटने या बड़ी तबाही की आशंका होने पर पहले पूछा जाता है।",
    "guest": "दूसरों की चैट पूछें पर रहती हैं, जब तक आपने उस बॉट का स्तर साफ़ तौर पर न चुना हो।"
  },
  "ja": {
    "run": "保存済みの権限ルールは操作を止めません。",
    "off": "保存済みの権限ルールは操作を止めません。完全にオフにした機能は、あなたがオンにするまでオフのままです。",
    "wipe": "全消去や重大な破壊の可能性が高い場合だけ、実行前に確認します。",
    "guest": "他の人のチャットは、あなたがそのボットの権限を明示的に設定していない限り、「確認する」のままです。"
  },
  "pt-br": {
    "run": "As regras de permissão salvas não bloqueiam ações.",
    "off": "As regras de permissão salvas não bloqueiam ações. Os recursos que você desativou por completo continuam desativados até você ativá-los.",
    "wipe": "Só pede confirmação antes de um provável apagamento total ou de uma catástrofe.",
    "guest": "Os chats de outras pessoas continuam em Perguntar, a menos que você tenha definido explicitamente o nível desse bot."
  },
  "zh": {
    "run": "已保存的权限规则不会阻止操作。",
    "off": "已保存的权限规则不会阻止操作。你完全关闭的功能会保持关闭，直到你重新开启。",
    "wipe": "只有可能清空全部数据或造成灾难性破坏时，才会先询问。",
    "guest": "其他人的聊天保持在询问级别，除非你明确设置了该机器人的权限级别。"
  }
};
  for (const code of codes) {
    it(`${code}: stored permission rules cannot block; disabled features stay off without a card`, () => {
      const pack = code === "en" ? allEnglish : load(code);
      const expected = permissionAndFeatureCopy[code as keyof typeof permissionAndFeatureCopy];
      for (const key of ["noLimits.v1.warning", "noLimits.v1.outsideNote", "noLimits.v1.windows", "noLimits.v1.engineAsks", "permissionMenu.ownTools", "ux.l1.level.unlimitedDetail", "ux.l1.confirm.unlimitedBody", "ux.lcopyb.level.unlimited", "ux.lcopyb.level.unlimitedHere"] as const) {
        expect(pack[key], `${code}:${key}`).toContain(expected.run);
        expect(pack[key], `${code}:${key}`).toContain(expected.off);
      }
    });
  }
  it("both level descriptions use the same wipe-only rule, including the computer controls", () => {
    const levels = JSON.parse(readFileSync(join(DIR, "en-ux/lcopyb.json"), "utf8")) as Record<string, string>;
    expect(levels["ux.lcopyb.level.unlimited"]).toBe("Your bots run commands and tools without asking, even with outside content or commands Murage cannot read. This can change protected files and read or send keys and passwords. Only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on. Murage says what is off and where to turn it on, without a card. Channel messages off stays off. Trigger links from other apps and routines use the bot's level. Other people's chats stay at Ask unless you explicitly set that bot's level. A setting carried over from 1.0.18 does not count.");
    expect(levels["ux.lcopyb.level.unlimitedHere"]).toBe("Your bots run commands and tools without asking, even with outside content or commands Murage cannot read. This can change protected files and read or send keys and passwords. Only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on. Murage says what is off and where to turn it on, without a card. Channel messages off stays off. Trigger links from other apps and routines use the bot's level. Other people's chats stay at Ask unless you explicitly set that bot's level. A setting carried over from 1.0.18 does not count. This includes clicking and typing on this computer.");
    expect(levels["ux.lcopyb.level.channelHint"]).toBe("On unless you turn it off. At No limits, your own channel messages run without asking. Other people's chats stay at Ask unless you explicitly set that bot's level. Trigger links from other apps and routines use the bot's level.");
    expect(levels["ux.lcopyb.level.peerSkip"]).toBe("On, but {level} skips this in your own chats and in routines at that level. Trigger links from other apps still ask at Full access. At No limits, trigger links from other apps and routines use the bot's level. Switch to Auto to be asked each time.");
  });
  it("the note under the level table promises only the wipe check at No limits", () => {
    const levels = JSON.parse(readFileSync(join(DIR, "en-ux/l1.json"), "utf8")) as Record<string, string>;
    expect(levels["ux.l1.level.underTable"]).toBe("At No limits, protected files can change and only a likely wipe or catastrophe asks first. Trigger links from other apps and routines use the bot's level. Other people's chats stay at Ask unless you explicitly set that bot's level. Saved permission rules do not block actions. Features you switched off entirely, including channel messages, stay off until you turn them on.");
  });
  it("English carries the approved text", () => {
    const en = load("en");
    expect(en["noLimits.v1.warning"]).toBe("No limits: Your bots run commands and tools without asking, even with outside content or commands Murage cannot read. This can change protected files and read or send keys and passwords. Only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on. Murage says what is off and where to turn it on, without a card. Channel messages off stays off. Trigger links from other apps and routines use the bot's level. Other people's chats stay at Ask unless you explicitly set that bot's level. A setting carried over from 1.0.18 does not count. Chats with no known sender stay at Ask. An unclear delete runs unless Murage can see it would wipe the whole computer, your home folder or system folders.");
    expect(en["noLimits.v1.outsideNote"]).toBe("This chat read outside content ({source}). At No limits, only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.");
    expect(en["noLimits.v1.openclaw"]).toBe("OpenClaw runs its own commands. Murage can check for a likely wipe or catastrophe only when OpenClaw sends it a request. Your OpenClaw settings still apply.");
    expect(en["noLimits.v1.windows"]).toBe("No limits works the same in bash, zsh, PowerShell and cmd. Only a likely wipe or catastrophe asks first. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.");
    expect(en["noLimits.v1.engineAsks"]).toBe("{engine} uses its own tools and settings. At No limits, Murage adds no permission cards except for a likely wipe or catastrophe in requests it receives. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.");
    expect(en["permissionMenu.ownTools"]).toBe("{engine} uses its own tools. At Ask, it only reads and answers. At other levels, your {engine} settings still apply. At No limits, Murage asks only about a likely wipe or catastrophe in requests it receives. Saved permission rules do not block actions. Features you switched off entirely stay off until you turn them on.");
  });
  it("H8 all No limits entry points describe the same wipe-only rule", () => {
    for (const key of ["ux.l1.level.unlimitedDetail", "ux.l1.confirm.unlimitedBody", "ux.lcopyb.level.unlimitedHere", "ux.lcopyb.level.unlimited"] as const) {
      const text = allEnglish[key];
      expect(text, key).toContain("Only a likely wipe or catastrophe asks first.");
      expect(text, key).toContain("Other people's chats stay at Ask unless you explicitly set that bot's level.");
      expect(text, key).not.toMatch(/still asks before|keep their own approvals|keeps its cards/);
      for (const code of codes.filter(code => code !== "en")) {
        const translated = load(code)[key];
        const expected = permissionAndFeatureCopy[code as keyof typeof permissionAndFeatureCopy];
        for (const phrase of [expected.wipe, expected.guest, expected.run, expected.off])
          expect(translated, `${code}:${key}`).toContain(phrase);
      }
    }
  });
});

describe("N on the card: the server's English note, shown in the owner's language", () => {
  const packT = (code: string) => {
    const pack = load(code);
    const en = load("en");
    return (key: string, params?: Record<string, string>) => (pack[key] ?? en[key]!).replace(/\{(\w+)\}/g, (m, name: string) => params?.[name] ?? m);
  };
  it("every source the server can name has a translated name", () => {
    for (const source of Object.keys(OUTSIDE_SOURCE_KEYS)) {
      const held = outsideTurnNote(source as never);
      expect(localizeOutsideNote(held, packT("en"))).toBe(packT("en")("noLimits.v1.outsideNote", { source }));
      const de = localizeOutsideNote(held, packT("de"));
      expect(de).not.toBe(held);
      expect(de).toBe(packT("de")("noLimits.v1.outsideNote", { source: packT("de")(OUTSIDE_SOURCE_KEYS[source]!) }));
      expect(de).toContain("geht die Arbeit weiter");
    }
  });
  it("a call card's outside line, as the server really writes it, shows in the owner's language; the older call words stay as they came", () => {
    const card = (outside: unknown) => callCardText({ state: "waiting", createdAt: 0, rangAt: null, factFields: { runId: "r", outside } } as unknown as CallIntent, "Scout", () => "14:02")!;
    expect(localizeCallCardText(card("web page"), packT("en"))).toBe(card("web page"));
    expect(localizeCallCardText(card("web page"), packT("de"))).toBe("Scout needs you\nDieser Chat hat zuvor Inhalte von außen gelesen (Webseite).");
    expect(localizeCallCardText(card("not a label"), packT("de"))).toBe("Scout needs you\nDieser Chat hat zuvor Inhalte von außen gelesen.");
    // a line a bot could have typed elsewhere with a source Murage never names is left alone, never turned into our sentence
    expect(localizeCallCardText("Earlier, this chat read outside content (moon rock).", packT("fr"))).toBe("Earlier, this chat read outside content (moon rock).");
    expect(localizeCallCardText("Scout tried to call you at 14:02", packT("ja"))).toBe("Scout tried to call you at 14:02");
    for (const code of codes) {
      expect(load(code)["noLimits.v1.callOutside"], code).toContain("{source}");
      expect(load(code)["noLimits.v1.callOutsideUnnamed"], code).not.toContain("{source}");
    }
  });
  it("a note that is not N is shown as it came", () => {
    expect(localizeOutsideNote("Murage could not read this action whole. Review it before allowing it.", packT("ja"))).toBe("Murage could not read this action whole. Review it before allowing it.");
    // an unknown source name keeps the sentence, with the name as the server wrote it
    expect(localizeOutsideNote("This chat read outside content (moon rock), so Murage asks before running this. Allow to run it.", packT("fr"))).toContain("(moon rock)");
  });
});
