// Keep platform diagnostics in the updater log; the app surfaces a small,
// consistent recovery step without changing any updater control flow.
export function updateErrorMessage(error) {
  const message = String(error?.message ?? error);
  const detail = `${error?.code ?? ""} ${message}`;

  // Explicit updater integrity codes take precedence over every incidental
  // certificate, network, or filesystem detail in the diagnostic.
  if (/ERR_UPDATER_(?:INVALID_SIGNATURE|CHECKSUM_MISMATCH)/i.test(detail)) {
    return "The update failed verification. Download a fresh installer from the official Murage release page.";
  }

  // A TLS leaf-signature failure verifies the connection; it is not evidence
  // that the downloaded installer failed its integrity check.
  if (/CERT_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SSL_ERROR|SELF_SIGNED_CERT_IN_CHAIN/i.test(detail)) {
    return "The update connection could not be verified. Check your clock, VPN or proxy; do not disable certificate checks.";
  }
  if (/checksum|signature|codesign/i.test(detail)) {
    return "The update failed verification. Download a fresh installer from the official Murage release page.";
  }
  if (/\bENOSPC\b|no space left|disk (?:is )?full/i.test(detail)) {
    return "Not enough disk space to prepare the update. Free some space, then try again.";
  }
  if (/\b(?:EACCES|EPERM)\b|read.only (?:volume|file system)|permission denied|access is denied/i.test(detail)) {
    return "The update could not write to the app or its cache. Check folder permissions, or use an official Murage installer.";
  }
  if (/\bEBUSY\b|being used by another process/i.test(detail)) {
    return "An update file is in use. Close other copies of Murage, then try again.";
  }
  if (/\b404\b|cannot find .*\.yml|cannot parse update info|no files provided|ERR_UPDATER_INVALID_RELEASE_FEED/i.test(detail)) {
    return "The update files are missing or invalid. Check the official Murage release page, or try again later.";
  }
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|net::ERR_|\bHTTP[^\n]*\b5\d\d\b|status(?: code)?[: ]+5\d\d\b/i.test(detail)) {
    return "The update download was interrupted or the server is unavailable. Check your connection and try again.";
  }
  return message;
}
