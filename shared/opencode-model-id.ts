/** Reserved provider owned by the Flux connector. */
export const OPENCODE_FLUX_PROVIDER = "flux";

const TYPED_PREFIX = "typed::";
const OPENCODE_MODEL = /^[A-Za-z0-9][\w.-]{0,63}\/[A-Za-z0-9][\w.:@+/-]{0,199}$/u;

function openCodeModelId(value: string): string | null {
  const id = value.trim();
  const provider = id.slice(0, id.indexOf("/")).toLowerCase();
  if (provider === OPENCODE_FLUX_PROVIDER || id.toLowerCase().startsWith("flux-")) return null;
  return OPENCODE_MODEL.test(id) && !id.endsWith("/") ? id : null;
}

/** The saved model id of a `provider/model` id typed by hand for OpenCode, or null when `value` cannot be one. OpenCode
 * (1.19.4) runs a model its catalog lacks once the model is declared under its provider in OpenCode's config, which the
 * server does for a typed id only: a plain saved id OpenCode no longer lists still falls back to its default. */
export function typedOpenCodeModelId(value: string): string | null {
  const id = openCodeModelId(value);
  return id ? `${TYPED_PREFIX}${id}` : null;
}

/** The OpenCode `provider/model` id inside a saved id typed by hand, or null for any other id. */
export function typedOpenCodeModel(savedId: string | undefined): string | null {
  if (!savedId?.startsWith(TYPED_PREFIX)) return null;
  const id = savedId.slice(TYPED_PREFIX.length);
  return openCodeModelId(id) === id ? id : null;
}

/** The same admission rule for a typed picker row and a submitted model selection. */
export function acceptsTypedOpenCodeModel(driverKind: string | undefined, model: string): boolean {
  return driverKind === "opencodeGo" && typedOpenCodeModel(model) !== null;
}
