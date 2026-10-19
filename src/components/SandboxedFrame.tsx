// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An iframe that shows an untrusted page with no sandbox allowances at all. React writes a srcDoc prop with
// setAttribute and a plain string, which a page that requires Trusted Types (the Cloud home) refuses, so the page
// is written to the frame's srcdoc property instead, as the trusted value src/lib/trusted-html.ts made.
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import type { TrustedMarkup } from "@/lib/trusted-html";

export function SandboxedFrame({ html, ...props }: Omit<ComponentProps<"iframe">, "srcDoc" | "sandbox" | "ref"> & { sandbox: ""; html: TrustedMarkup }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => { if (frame.current) frame.current.srcdoc = html; }, [html]);
  return <iframe ref={frame} {...props} sandbox="" />;
}
