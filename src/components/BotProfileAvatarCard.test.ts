// The avatar panel's four states, rendered.
//
// TEST RIG: this file runs in vitest's node environment, and importing the
// card reaches @/state/store, so `window` has to exist before the module graph
// is walked. Same shape as the other component suites here.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.window ??= { location: { href: "http://localhost/" } } as unknown as Window & typeof globalThis;

import { AVATAR_COPY, avatarGeneratorPlan, type AvatarGeneratorFacts } from "@/lib/avatar-generation";
import { AVATAR_IMAGE_TYPE_ERROR, AVATAR_ONE_FILE_ERROR, avatarDropHandlers, type FileDropEvent } from "@/lib/file-drop-zone";
import { AvatarDropZone, AvatarGenerateSection, type AvatarGenerateSectionProps } from "./BotProfileAvatarCard";

const facts = (over: Partial<AvatarGeneratorFacts> = {}): AvatarGeneratorFacts => ({
  flux: false,
  openAiImageKey: false,
  lastAttemptFailed: false,
  ...over,
});

const render = (over: Partial<AvatarGenerateSectionProps> = {}) =>
  renderToStaticMarkup(
    createElement(AvatarGenerateSection, {
      plan: avatarGeneratorPlan(facts()),
      direction: "",
      onDirection: vi.fn(),
      directionPlaceholder: "Optional direction",
      generating: false,
      uploading: false,
      onGenerate: vi.fn(),
      imageKey: "",
      onImageKey: vi.fn(),
      savingKey: false,
      onSaveKey: vi.fn(),
      onOpenSettings: vi.fn(),
      ...over,
    }),
  );

describe("the avatar panel with a Flux key", () => {
  const html = () => render({ plan: avatarGeneratorPlan(facts({ flux: true, openAiImageKey: true })) });

  it("says Flux is doing it, and offers no OpenAI key to paste", () => {
    expect(html()).toContain(AVATAR_COPY.fluxHeading);
    expect(html()).toContain("Generate avatar");
    expect(html()).not.toContain(AVATAR_COPY.keyDrawerLabel);
    expect(html()).not.toContain('type="password"');
  });

  it("offers the key again once an attempt has failed", () => {
    const failed = render({ plan: avatarGeneratorPlan(facts({ flux: true, lastAttemptFailed: true })) });
    expect(failed).toContain(AVATAR_COPY.keyDrawerLabel);
    expect(failed).toContain('type="password"');
  });
});

describe("the avatar panel without a Flux key", () => {
  it("keeps the OpenAI path working for someone already using it", () => {
    const html = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(html).toContain(AVATAR_COPY.openAiHeading);
    expect(html).toContain("Generate avatar");
    expect(html).toContain(AVATAR_COPY.keyDrawerLabel);
  });

  it("points at Settings for the easier path, without blocking the panel", () => {
    const html = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(html).toContain(AVATAR_COPY.fluxHint);
    expect(html).toContain(AVATAR_COPY.fluxHintAction);
    // An offer, not a gate: the generate control is still right there.
    expect(html).toContain("Generate avatar");
  });

  it("asks for a key when there is nothing at all, and still offers Flux", () => {
    const html = render({ plan: avatarGeneratorPlan(facts()) });
    expect(html).toContain("Paste OpenAI image API key");
    expect(html).toContain(AVATAR_COPY.fluxHintAction);
    expect(html).not.toContain("Generate avatar");
  });
});

describe("the panel never renders a secret", () => {
  it("holds no saved key: the only value in the markup is what was just typed", () => {
    // FluxKeyCard's precedent is about what the RENDERER IS GIVEN. GET
    // /api/config answers `imageGen: { configured }` and never the key, so a
    // configured panel with an empty box has no key material in it anywhere.
    const configured = render({ plan: avatarGeneratorPlan(facts({ openAiImageKey: true })) });
    expect(configured).toContain(AVATAR_COPY.keyDrawerLabel);
    expect(configured).not.toMatch(/value="[^"]/);
    // And the box it would be typed into is masked and off autocomplete.
    expect(configured).toContain('type="password"');
    // react-dom/server keeps the camelCase spelling; match either.
    expect(configured).toMatch(/autocomplete="off"/i);
  });

  it("POSITIVE control: the rig would notice key material in the markup", () => {
    // A controlled input DOES serialise what the person is currently typing.
    // That is the field they are typing in, not a stored secret, but it proves
    // the assertion above is reading real markup rather than an empty string.
    const typed = render({
      plan: avatarGeneratorPlan(facts({ openAiImageKey: true })),
      imageKey: "sk-typed-just-now",
    });
    expect(typed).toContain("sk-typed-just-now");
    expect(() => expect(typed).not.toMatch(/value="[^"]/)).toThrow();
  });
});

describe("dropping an image onto the avatar", () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], "portrait.png", { type: "image/png" });
  const text = () => new File(["hello"], "notes.txt", { type: "text/plain" });
  const event = (files: File[], over: Partial<FileDropEvent> = {}) => {
    const preventDefault = vi.fn();
    const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
    return { preventDefault, dataTransfer, currentTarget: { contains: () => false }, relatedTarget: null, ...over };
  };
  const rig = (disabled = false) => {
    const calls = { setDragActive: vi.fn(), onFile: vi.fn(), onError: vi.fn() };
    return { calls, handlers: avatarDropHandlers({ disabled, ...calls }) };
  };

  it("hands a dropped PNG to the same upload the chooser uses, and stops the window navigating to it", () => {
    const { calls, handlers } = rig();
    const file = png();
    const drop = event([file]);
    handlers.onDrop(drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(calls.onFile).toHaveBeenCalledWith(file);
    expect(calls.onError).not.toHaveBeenCalled();
    expect(calls.setDragActive).toHaveBeenLastCalledWith(false);
  });

  it("refuses a non-image with the chooser's own words and uploads nothing", () => {
    const { calls, handlers } = rig();
    handlers.onDrop(event([text()]));
    expect(calls.onFile).not.toHaveBeenCalled();
    expect(calls.onError).toHaveBeenCalledWith(AVATAR_IMAGE_TYPE_ERROR);
    expect(AVATAR_IMAGE_TYPE_ERROR).toBe("Choose a PNG, JPEG, GIF, or WebP image");
  });

  it("refuses several files at once rather than guessing which one was meant", () => {
    const { calls, handlers } = rig();
    handlers.onDrop(event([png(), png()]));
    expect(calls.onFile).not.toHaveBeenCalled();
    expect(calls.onError).toHaveBeenCalledWith(AVATAR_ONE_FILE_ERROR);
  });

  it("shows the drop affordance on dragover and clears it when the drag leaves the zone", () => {
    const { calls, handlers } = rig();
    const over = event([]);
    handlers.onDragOver(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer?.dropEffect).toBe("copy");
    expect(calls.setDragActive).toHaveBeenLastCalledWith(true);
    // Moving onto the avatar inside the zone is not leaving it.
    handlers.onDragLeave(event([], { currentTarget: { contains: () => true }, relatedTarget: {} as EventTarget }));
    expect(calls.setDragActive).toHaveBeenLastCalledWith(true);
    handlers.onDragLeave(event([]));
    expect(calls.setDragActive).toHaveBeenLastCalledWith(false);
  });

  it("ignores drags that carry no files, such as selected text", () => {
    const { calls, handlers } = rig();
    const over = event([], { dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } });
    handlers.onDragOver(over);
    handlers.onDrop(over);
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(calls.setDragActive).not.toHaveBeenCalled();
    expect(calls.onFile).not.toHaveBeenCalled();
  });

  it("takes nothing while an upload or generation is already running", () => {
    const { calls, handlers } = rig(true);
    const over = event([png()]);
    handlers.onDragOver(over);
    expect(over.dataTransfer?.dropEffect).toBe("none");
    expect(calls.setDragActive).toHaveBeenLastCalledWith(false);
    handlers.onDrop(event([png()]));
    expect(calls.onFile).not.toHaveBeenCalled();
  });

  it("renders the affordance only while a file is over the zone, and marks the zone for the composer", () => {
    const zone = (active: boolean) =>
      renderToStaticMarkup(createElement(AvatarDropZone, { active, handlers: rig().handlers, children: createElement("span", null, "avatar") }));
    const idle = zone(false);
    const hovering = zone(true);
    expect(idle).toContain('data-file-drop-zone="avatar"');
    expect(idle).not.toContain("Drop image to set avatar");
    expect(idle).toContain("border-transparent");
    expect(hovering).toContain("Drop image to set avatar");
    expect(hovering).toContain("border-accent");
    expect(hovering).toContain('data-drag-active="true"');
  });
});
