// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n";
import { formatSize, type FileUploadErrorLine } from "./composer-attachments";

export const fileUploadErrorCopy: FileUploadErrorLine = (code, limit) =>
  t(`composer.files.${code}`, { limit: formatSize(limit) });
