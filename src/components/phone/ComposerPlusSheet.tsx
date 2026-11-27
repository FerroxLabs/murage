// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone composer's + (1.0.20): a bottom sheet that offers Camera, Photos and
// Files, then Finish together (rooms) and the approval level, the same two
// controls the pop-up menu holds. Every row is a real button at least 44 px
// tall. A source row closes the sheet and starts its picker from the same tap,
// so the phone's picker is never blocked; the row and the picker are the
// composer's (ComposerPlusMenu passes the callbacks, Composer owns the inputs).
import type { ReactNode } from "react";
import { Camera, Check, FileText, Image as ImageIcon } from "lucide-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { PhoneSheet } from "./PhoneSheet";

export interface ComposerPlusSources {
  camera?: () => void;
  photos?: () => void;
  files: () => void;
}

export interface ComposerPlusSheetRow {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  disabled?: boolean;
  /** present for a toggle: exposed as a pressed button */
  pressed?: boolean;
  onPress: () => void;
}

const ROW = "flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function composerSourceRows(sources: ComposerPlusSources, disabled: boolean | undefined): ComposerPlusSheetRow[] {
  return [
    ...(sources.camera ? [{ id: "camera", label: t("ux.l7.plus.camera"), description: t("ux.l7.plus.cameraHint"), icon: <Camera size={20} />, disabled, onPress: sources.camera }] : []),
    ...(sources.photos ? [{ id: "photos", label: t("ux.l7.plus.photos"), description: t("ux.l7.plus.photosHint"), icon: <ImageIcon size={20} />, disabled, onPress: sources.photos }] : []),
    { id: "files", label: t("ux.l7.plus.files"), description: t("ux.l7.plus.filesHint"), icon: <FileText size={20} />, disabled, onPress: sources.files },
  ];
}

/** `rows` run after the sheet is closed; `onClose` closes it and hands focus back to the +. */
export function ComposerPlusSheet({ rows, onClose }: { rows: readonly ComposerPlusSheetRow[]; onClose: () => void }) {
  return (
    <PhoneSheet title={t("ux.l7.plus.title")} onClose={onClose} bodyData={{ "data-composer-plus-sheet": "" }}>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            data-composer-plus-row={row.id}
            disabled={row.disabled}
            aria-pressed={row.pressed}
            onClick={() => { onClose(); row.onPress(); }}
            className={cn(ROW, row.disabled ? "cursor-not-allowed opacity-60" : "hover:bg-raised-hover")}
          >
            <span className="flex size-6 shrink-0 items-center justify-center text-ink-secondary" aria-hidden="true">{row.icon}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] text-ink">{row.label}</span>
              {row.description && <span className="text-[13px] text-ink-secondary">{row.description}</span>}
            </span>
            {row.pressed && <Check size={16} className="shrink-0 text-accent" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </PhoneSheet>
  );
}
