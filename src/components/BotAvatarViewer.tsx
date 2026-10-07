// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// A bot's image avatar, enlargeable. Clicking (or Enter/Space on) the image
// opens it in the shared ImageLightbox, a native modal dialog that sits above
// the Bot settings window and already handles Esc, a click outside, the close
// button and the Tab trap. The mascot has nothing larger to show, so it is
// drawn exactly as BotAvatar draws it, with no button around it.
import { useLayoutEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { botAvatarProfile } from "../../shared/bot-avatar";
import { BotAvatar, type BotAvatarProps } from "./Avatar";
import { ImageLightbox, type ImageMediaItem } from "./ImageMedia";

/** The lightbox's view of an avatar: the stored image itself, never a
 * thumbnail, with nothing to download and no "use as reference" action. */
export function avatarLightboxItem(bot: BotAvatarProps["bot"]): ImageMediaItem {
  const name = bot.name?.trim() || t("media.image.untitled");
  const src = botAvatarProfile(bot).avatarUrl ?? "";
  return { id: src, src, name, alt: name, source: "avatar", download: false };
}

export function ViewableBotAvatar(props: BotAvatarProps) {
  const profile = botAvatarProfile(props.bot);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Back to the avatar once the dialog is gone. The lightbox restores the
  // element that was focused when it opened, but Safari does not focus a
  // button on click, so the avatar is focused explicitly as well.
  useLayoutEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (profile.avatarCrop === "mascot" || !profile.avatarUrl) return <BotAvatar {...props} />;
  const label = t("avatar.viewLarger");
  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className="block cursor-zoom-in rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <BotAvatar {...props} />
      </button>
      {open && <ImageLightbox items={[avatarLightboxItem(props.bot)]} index={0} onClose={() => setOpen(false)} />}
    </>
  );
}
