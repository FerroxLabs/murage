// Reviewed electron-updater source: fail closed when Authenticode evidence is
// unavailable. Publisher DN/CN matching is deliberately left unchanged.
// PowerShell runs hidden, with a bound that fits a large installer on a busy
// machine, and one more try after a timeout only; a refusal says which check
// failed (murage-releases #2: a 20 s timeout read as "download again").
import { createHash } from "node:crypto";

export const WINDOWS_VERIFIER_VERSION = "6.8.9";
export const WINDOWS_VERIFIER_SHA256 = "4738e446904710a2497fd3408fdf6416c5515d9177c0add0f2427bd725969c21";

export function assertWindowsVerifierSource(version, source) {
  const hash = createHash("sha256").update(source).digest("hex");
  if (version !== WINDOWS_VERIFIER_VERSION || hash !== WINDOWS_VERIFIER_SHA256) {
    throw new Error("Windows signature verifier source changed; review version/hash before regenerating the updater");
  }
}

function replaceExactly(source, pattern, replacement, expected, label) {
  const count = [...source.matchAll(pattern)].length;
  if (count !== expected) {
    throw new Error(`Expected ${expected} Windows signature ${label} sites, found ${count}; review upstream before releasing`);
  }
  return source.replace(pattern, replacement);
}

export const WINDOWS_SIGNATURE_TIMEOUT_MS = 90_000;
export const WINDOWS_SIGNATURE_ATTEMPTS = 2;

export function patchWindowsSignatureVerifier(source) {
  const modulePattern = /var require_windowsExecutableCodeSignatureVerifier = __commonJS\(\{[\s\S]*?\n\}\);/g;
  const modules = [...source.matchAll(modulePattern)];
  if (modules.length !== 1) {
    throw new Error(`Expected 1 Windows signature module, found ${modules.length}; review upstream before releasing`);
  }
  let verifier = modules[0][0];
  verifier = replaceExactly(verifier,
    /    function handleError\(logger, error, stderr, reject\) \{[\s\S]*?    function isOldWin6\(\) \{[\s\S]*?\n    \}/g,
    `    function handleError(logger, error, stderr, reject) {
      const timedOut = error != null && typeof error === "object" && (error.killed === true || error.signal != null);
      const detail = error instanceof Error ? error.message : error || stderr || "Missing signature evidence";
      const failure = (0, builder_util_runtime_1.newError)(timedOut ? \`Windows signature check timed out: \${detail}\` : \`Windows signature verification unavailable: \${detail}\`, "ERR_UPDATER_INVALID_SIGNATURE");
      failure.signatureCheck = timedOut ? "timeout" : "unavailable";
      logger.warn(failure.message);
      reject(failure);
    }`, 1, "error handler");
  verifier = replaceExactly(verifier,
    /(handleError\(logger, [^\n]+, reject\);)\n\s*resolve\(null\);/g,
    "$1", 3, "error success removal");
  verifier = replaceExactly(verifier,
    /logger\.warn\(`Unable to verify LiteralPath of update asset due to missing data\.Path\. Skipping this step of validation\. Message: [^\n]+\);/g,
    "handleError(logger, error2, null, reject);\n                return;", 1, "missing path rejection");
  verifier = replaceExactly(verifier,
    /      const args = \["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", command\];\n      const options = \{\n        shell: true,\n        timeout\n      \};/g,
    `      const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-InputFormat", "None", "-Command", command];
      const options = {
        shell: true,
        windowsHide: true,
        timeout
      };`, 1, "hidden PowerShell");
  verifier = replaceExactly(verifier,
    /        \(0, child_process_1\.execFile\)\(\.\.\.preparePowerShellExec\(`"Get-AuthenticodeSignature -LiteralPath '\$\{tempUpdateFile\}' \| ConvertTo-Json -Compress"`, 20 \* 1e3\), \(error, stdout, stderr\) => \{\n/g,
    `        const attempt = (left) => (0, child_process_1.execFile)(...preparePowerShellExec(\`"Get-AuthenticodeSignature -LiteralPath '\${tempUpdateFile}' | ConvertTo-Json -Compress"\`, ${WINDOWS_SIGNATURE_TIMEOUT_MS}), (error, stdout, stderr) => {
          if (error != null && (error.killed === true || error.signal != null) && left > 1) {
            logger.warn("Windows signature check timed out; checking once more");
            attempt(left - 1);
            return;
          }
`, 1, "bounded retry");
  verifier = replaceExactly(verifier,
    /            handleError\(logger, e, null, reject\);\n            return;\n          \}\n        \}\);\n      \}\);\n/g,
    `            handleError(logger, e, null, reject);
            return;
          }
        });
        attempt(${WINDOWS_SIGNATURE_ATTEMPTS});
      });
`, 1, "retry start");
  // These imports/temporaries existed only for the removed compatibility bypass.
  verifier = replaceExactly(verifier, /    var os = require\("os"\);\n/g, "", 1, "obsolete OS import");
  verifier = replaceExactly(verifier, /          var _a;\n/g, "", 1, "obsolete catch temporary");
  return source.replace(modulePattern, () => verifier);
}
