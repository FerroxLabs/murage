// Same-origin image thumbnails and an in-app lightbox. Transcript text can
// contain arbitrary strings, so callers pass saved paths and this component
// resolves them through attachmentImageUrl rather than loading them as URLs.
// Rendering and the lightbox itself live in ImageMedia, shared with Markdown
// images, screen frames and the Files preview (0.1.52 F5-T2).
import { useMemo } from "react";
import { FileText } from "lucide-react";

import { attachmentBasename, attachmentImageUrl, type TranscriptFileAttachment } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { attachmentImageItem, ImageGallery, ImageLightbox, type ImageMediaItem } from "./ImageMedia";

export interface PreviewImage {
  src: string;
  name: string;
}

export function previewImage(path: string): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  return { src, name: attachmentBasename(path) };
}

/** The composer's single-image preview. Same dialog as every other image. */
export function AttachmentPreviewDialog({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const items = useMemo<ImageMediaItem[]>(
    () => [{ id: `attachment:${image.src}`, src: image.src, name: image.name, alt: image.name, source: "attachment", download: true }],
    [image.src, image.name],
  );
  return <ImageLightbox items={items} index={0} onClose={onClose} />;
}

export function AttachedImageGallery({ paths, className }: { paths: string[]; className?: string }) {
  const items = useMemo(() => paths.flatMap((path, index) => {
    const item = attachmentImageItem(path, attachmentBasename(path), index);
    return item ? [item] : [];
  }), [paths]);
  if (items.length === 0) return null;
  return (
    <ImageGallery
      items={items}
      className={cn("mb-2 flex flex-wrap justify-end gap-2", className)}
      thumbClassName="max-w-[260px] rounded-lg border border-hairline/40 bg-inset"
      imgClassName="max-h-[220px] w-full object-contain"
      label={(item) => t("media.thumb.openAttached", { name: item.name })}
    />
  );
}

/** A transcript file is a local prompt reference, not a public download.
 * Show what was sent without turning an untrusted stored path into a link. */
export function AttachedFileChips({ files, className }: { files: TranscriptFileAttachment[]; className?: string }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-1.5", className)}>
      {files.map((file, index) => (
        <span
          key={`${file.path}:${index}`}
          title={file.name}
          className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-hairline/40 bg-inset/70 px-2.5 py-1.5 text-[12px] text-ink-secondary"
        >
          <FileText size={13} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-ink">{file.name}</span>
        </span>
      ))}
    </div>
  );
}
