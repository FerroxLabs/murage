// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The installers show a short terms notice (a license page on Windows, a
// license agreement in the macOS disk image), keep the per-user install and
// the permission hook, and never embed the legal text.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const builder = read("../electron-builder.yml");
const notice = read("../build/license.txt");
const section = (name) => builder.slice(builder.indexOf(`\n${name}:\n`) + 1).split(/\n(?=\S)/)[0];

describe("installer terms notice", () => {
  it("is a short pointer to the published terms, not the legal text", () => {
    expect(notice).toContain("https://murage.ai/terms-of-service");
    expect(notice).toContain("https://murage.ai/privacy-policy");
    expect(notice).toContain("AGPL-3.0-or-later");
    expect(notice.length).toBeLessThan(500);
  });

  it("Windows shows a license page but stays per-user and keeps its hook", () => {
    const nsis = section("nsis");
    expect(nsis).toMatch(/^  oneClick: false$/m);
    expect(nsis).toMatch(/^  perMachine: false$/m);
    expect(nsis).toMatch(/^  license: build\/license\.txt$/m);
    expect(nsis).toMatch(/^  include: build\/windows-sandbox-acl\.nsh$/m);
    expect(nsis).not.toMatch(/allowToChangeInstallationDirectory: true/);
  });

  it("the install-mode question is answered up front, so the only extra page is the notice", () => {
    expect(read("../build/windows-install-mode.nsh")).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"/);
    expect(read("../build/windows-sandbox-acl.nsh")).toContain('!include "windows-install-mode.nsh"');
  });

  it("the macOS disk image carries the same notice", () => {
    expect(section("dmg")).toMatch(/^  license: build\/license\.txt$/m);
  });
});
