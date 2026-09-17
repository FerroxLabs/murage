// A region of the app that takes a dropped file for itself, and the rules the
// avatar card applies to what was dropped. The composer listens for file drops
// on the whole window; a drop zone marks its element so the composer leaves
// that drop alone instead of also attaching the file to the next message.
import { isImageFile } from "./composer-attachments.ts";

export const FILE_DROP_ZONE_ATTRIBUTE = "data-file-drop-zone";

/** The chooser's own refusal, so a dropped file and a picked one read the same. */
export const AVATAR_IMAGE_TYPE_ERROR = "Choose a PNG, JPEG, GIF, or WebP image";
export const AVATAR_ONE_FILE_ERROR = "Drop one image at a time";

export function carriesFiles(dataTransfer: { types?: ArrayLike<string> | null } | null | undefined): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

export function insideFileDropZone(target: EventTarget | null | undefined): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null | undefined;
  return typeof element?.closest === "function" && Boolean(element.closest(`[${FILE_DROP_ZONE_ATTRIBUTE}]`));
}

export type DroppedAvatar = { file: File } | { error: string } | null;

/** Nothing dropped is no answer; more than one file or a non-image is refused
 *  before anything is uploaded. Size is left to the upload itself, which is
 *  where the chooser path enforces it. */
export function droppedAvatarFile(files: ArrayLike<File> | null | undefined): DroppedAvatar {
  const list = Array.from(files ?? []);
  if (list.length === 0) return null;
  if (list.length > 1) return { error: AVATAR_ONE_FILE_ERROR };
  const file = list[0]!;
  return isImageFile(file) ? { file } : { error: AVATAR_IMAGE_TYPE_ERROR };
}

export interface FileDropEvent {
  dataTransfer: { types?: ArrayLike<string> | null; files?: ArrayLike<File> | null; dropEffect?: string } | null;
  currentTarget: { contains?: (node: Node | null) => boolean } | null;
  relatedTarget?: EventTarget | null;
  preventDefault(): void;
}

/** Handlers for the avatar drop zone, separate from React so they can be
 *  driven with plain objects in a node test. */
export function avatarDropHandlers({
  disabled,
  setDragActive,
  onFile,
  onError,
}: {
  disabled: boolean;
  setDragActive: (active: boolean) => void;
  onFile: (file: File) => void;
  onError: (message: string) => void;
}) {
  const over = (event: FileDropEvent) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // Without this the drop navigates the window to the file.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    setDragActive(!disabled);
  };
  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (event: FileDropEvent) => {
      const next = event.relatedTarget as Node | null | undefined;
      if (next && event.currentTarget?.contains?.(next)) return;
      setDragActive(false);
    },
    onDrop: (event: FileDropEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(false);
      if (disabled) return;
      const dropped = droppedAvatarFile(event.dataTransfer?.files);
      if (!dropped) return;
      if ("error" in dropped) onError(dropped.error);
      else onFile(dropped.file);
    },
  };
}
