import { forwardRef, type ImgHTMLAttributes } from "react";

import { useDesktopResourceUrl } from "@/lib/use-desktop-resource";

export type DesktopImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | null | undefined };

/** An <img> whose /api source loads as the desktop: through a single-use
 * ticket in the desktop window (useDesktopResourceUrl), unchanged everywhere
 * else. A failed load gets one fresh ticket before `onError` is told. */
export const DesktopImg = forwardRef<HTMLImageElement, DesktopImgProps>(function DesktopImg({ src, onError, ...rest }, ref) {
  const resource = useDesktopResourceUrl(src);
  return (
    // src first, as the plain <img> it replaced rendered it (the markup the image tests read)
    <img
      src={resource.src}
      {...rest}
      ref={ref}
      onError={(event) => {
        if (resource.retry()) return;
        onError?.(event);
      }}
    />
  );
});
