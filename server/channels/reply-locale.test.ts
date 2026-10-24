// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bare language choice with no region on the system formats channel times with the
// locale of the pack it shows: bare "pt" shows the pt-BR pack, so the tag is pt-BR
// (explicit, rather than relying on ICU reading bare "pt" as Brazil).
import { afterEach, describe, expect, it } from "vitest";
import { channelReplyLanguage, channelReplyLocale, setChannelReplyLanguage, setChannelReplySystemLanguage } from "./reply-text.ts";

afterEach(() => {
  setChannelReplyLanguage(() => undefined);
  setChannelReplySystemLanguage(() => undefined);
});

describe("channel reply locale for a bare language", () => {
  it("reads bare Portuguese as pt-BR on a system in another language", () => {
    setChannelReplySystemLanguage(() => "en-US");
    setChannelReplyLanguage(() => "pt");
    expect(channelReplyLocale()).toBe("pt-BR");
    setChannelReplyLanguage(() => "PT");
    expect(channelReplyLocale()).toBe("pt-BR");
  });

  it("reads bare Portuguese as pt-BR when the system language is bare pt", () => {
    setChannelReplySystemLanguage(() => "pt");
    setChannelReplyLanguage(() => "");
    expect(channelReplyLocale()).toBe("pt-BR");
  });

  it("reads a POSIX-style pt_BR setting as pt-BR, not English", () => {
    setChannelReplySystemLanguage(() => "en-US");
    setChannelReplyLanguage(() => "pt_BR");
    expect(channelReplyLanguage()).toBe("pt-br");
    expect(channelReplyLocale()).toBe("pt-BR");
    setChannelReplyLanguage(() => "en_GB");
    expect(channelReplyLanguage()).toBe("en");
    expect(channelReplyLocale()).toBe("en-GB");
  });

  it("keeps a chosen or system region and other bare packs unchanged", () => {
    setChannelReplySystemLanguage(() => "pt-PT");
    setChannelReplyLanguage(() => "pt");
    expect(channelReplyLocale()).toBe("pt-PT");
    setChannelReplySystemLanguage(() => "en-US");
    setChannelReplyLanguage(() => "pt-BR");
    expect(channelReplyLocale()).toBe("pt-BR");
    setChannelReplyLanguage(() => "de");
    expect(channelReplyLocale()).toBe("de");
    setChannelReplyLanguage(() => "en");
    expect(channelReplyLocale()).toBe("en-US");
    setChannelReplyLanguage(() => "it");
    expect(channelReplyLocale()).toBe("en-US");
  });
});
