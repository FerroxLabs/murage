// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { fileUploadErrorCopy } from "./attachment-upload-copy";
afterEach(() => setLocale("en"));

it("keeps all five file upload sentences in every registered language", async () => {
  for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    await setLocale(code);
    for (const key of ["readFailed", "tooLarge", "invalidMindMap", "busy", "attachFailed"] as const) {
      const text = fileUploadErrorCopy(key, 8 * 1024 * 1024);
      expect(text).not.toContain("composer.files.");
      expect(text).not.toContain("{limit}");
      expect(text).not.toContain("—");
      if (key === "tooLarge") expect(text).toContain("8.0 MB");
    }
  }
});
