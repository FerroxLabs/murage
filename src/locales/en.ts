// English — the source-of-truth catalog. Every key the UI uses MUST exist
// here; other languages are partial overlays that fall back to these
// values. Keys are dotted namespaces: "<surface>.<string>".
export const en = {
  "noEngines.title": "Install an AI engine to get started",
  "noEngines.intro":
    "OpenMausBot doesn't ship a model of its own — your bots run on an AI CLI installed on this computer, using your existing login. Set up any one of these and your bots come alive.",
  "engines.cloud": "Cloud",
  "engines.local": "Local",
  "common.checkAgain": "Check again",
  "common.checking": "Checking…",
} as const;
