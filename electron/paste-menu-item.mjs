/** Chromium can report canPaste=false for macOS image/file clipboard data. */
export function pasteMenuItem(params, clipboard, webContents) {
  let attachment = false;
  if (params.isEditable && !params.editFlags.canPaste) {
    try {
      attachment = clipboard.availableFormats().some((format) =>
        ["public.file-url", "NSFilenamesPboardType", "text/uri-list"].includes(format),
      ) || !clipboard.readImage().isEmpty();
    } catch {
      // Unavailable clipboard access must not enable an otherwise disabled item.
    }
  }
  return {
    label: "Paste",
    enabled: Boolean(params.isEditable && (params.editFlags.canPaste || attachment)),
    ...(attachment ? { click: () => webContents.paste() } : { role: "paste" }),
  };
}
