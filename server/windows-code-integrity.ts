/** Only known loader/code-integrity evidence selects the component-block copy. Generic missing/ABI errors retain their copy. */
export function windowsCodeIntegrityBlock(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
  const fields = [value.code, value.errno, value.message];
  const codes = new Set([0x800711c7, 0xc0e90002, 0xc0000142, 0xc0000428, 577, 1114, 4551]);
  return fields.some(field => typeof field === "number" && codes.has(field >>> 0)
    || typeof field === "string" && (/\b(?:ERROR_DLL_INIT(?:_FAILED)?|ERROR_INVALID_IMAGE_HASH|STATUS_INVALID_IMAGE_HASH|0x800711c7|0xc0e90002|0xc0000142|0xc0000428)\b/i.test(field)
      || /Smart App Control|code integrity|digital signature.*(?:could not|cannot|couldn't).*verif|Windows cannot verify the digital signature|part of this app has been blocked|dynamic link library \(DLL\) initialization routine failed|application control policy has blocked this file|blocked because it did not have a valid digital signature/i.test(field)))
    || (value.cause !== error && value.cause != null && windowsCodeIntegrityBlockCause(value.cause));
}

// Bound nested causes: native loader wrappers sometimes include the original Windows status here.
function windowsCodeIntegrityBlockCause(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const { code, errno, message } = cause as { code?: unknown; errno?: unknown; message?: unknown };
  return windowsCodeIntegrityBlock({ code, errno, message });
}
