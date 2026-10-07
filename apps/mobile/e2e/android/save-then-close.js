// A chunked save that never ends: the workspace closes (showLauncher) between
// the chunk and the end, so the save must be dropped, not published.
await window.murageNative.saveFile({ kind: "begin", id: "p26-close", filename: args.filename, mime: "text/plain", size: 10 });
await window.murageNative.saveFile({ kind: "chunk", id: "p26-close", index: 0, base64: "aGVsbG8=" });
window.murageNative.showLauncher().catch(() => {});
return "closing";
