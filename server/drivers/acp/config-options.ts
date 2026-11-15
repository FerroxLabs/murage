import type { ModelCatalog, ModelVariantOption } from "../../contracts.ts";

type SelectValue = { id: string; label: string; provider?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export const ACP_OPTION_LIMIT = 128;
export const ACP_LABEL_LIMIT = 256;
export const ACP_ID_LIMIT = 200;

function nonempty(value: unknown, limit = ACP_ID_LIMIT): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= limit ? value : undefined;
}

/** Shared by native discovery/session controls and persisted startup catalogs. */
export function decodeChoices(value: unknown, limit = ACP_OPTION_LIMIT): SelectValue[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, limit).flatMap(raw => {
    const entry = record(raw);
    const id = nonempty(entry?.id);
    const label = entry?.label === undefined ? id : nonempty(entry.label, ACP_LABEL_LIMIT);
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    const provider = nonempty(entry?.provider, ACP_LABEL_LIMIT);
    return [{ id, label, ...(provider ? { provider } : {}) }];
  });
}

function configOptions(result: unknown): Record<string, unknown>[] {
  const options = record(result)?.configOptions;
  return Array.isArray(options) ? options.slice(0, ACP_OPTION_LIMIT).flatMap((entry) => { const value = record(entry); return value ? [value] : []; }) : [];
}

function selectValues(value: unknown): SelectValue[] {
  const values: SelectValue[] = [];
  const seen = new Set<string>();
  const collect = (entries: unknown, provider?: string, depth = 0) => {
    if (!Array.isArray(entries) || depth > 8) return;
    for (const raw of entries.slice(0, ACP_OPTION_LIMIT)) {
      if (values.length >= ACP_OPTION_LIMIT) break;
      const entry = record(raw);
      if (!entry) continue;
      const id = nonempty(entry.value);
      if (id && !seen.has(id)) {
        seen.add(id);
        const source = nonempty(entry.provider) ?? provider;
        values.push({ id, label: typeof entry.name === "string" ? entry.name : id, ...(source ? { provider: source } : {}) });
      } else if (!id) {
        collect(entry.options, nonempty(entry.provider) ?? nonempty(entry.name) ?? nonempty(entry.group) ?? provider, depth + 1);
      }
    }
  };
  collect(value);
  return decodeChoices(values);
}

export function acpVariantOption(result: unknown): { configId: string; options: ModelVariantOption[]; currentValue?: string; defaultValue?: string } | undefined {
  const option = configOptions(result).find((entry) => entry.type === "select" && nonempty(entry.id)
    && (entry.id === "effort" || entry.id === "reasoning_effort" || entry.id === "thought_level" || entry.category === "thought_level"));
  if (!option) return;
  const options = selectValues(option.options).map(({ id, label }) => ({ id, label }));
  const currentValue = options.some(({ id }) => id === option.currentValue) ? nonempty(option.currentValue) : undefined;
  return {
    configId: option.id as string,
    options,
    ...(options.some(({ id }) => id === option.defaultValue) ? { defaultValue: option.defaultValue as string } : {}),
    ...(currentValue ? { currentValue } : {}),
  };
}

export function acpModelOption(result: unknown, configId = "model"): {
  configId?: string;
  currentValue?: string;
  options: ModelCatalog["options"];
} | undefined {
  const configs = configOptions(result);
  const option = configs.find((entry) => entry.type === "select" && entry.id === configId)
    ?? configs.find((entry) => entry.type === "select" && entry.category === "model" && nonempty(entry.id));
  if (option) {
    const options = selectValues(option.options);
    const currentValue = options.some(({ id }) => id === option.currentValue) ? nonempty(option.currentValue) : undefined;
    return { configId: option.id as string, options, ...(currentValue ? { currentValue } : {}) };
  }
  const models = record(record(result)?.models);
  if (!models || !Array.isArray(models.availableModels)) return;
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const raw of models.availableModels.slice(0, ACP_OPTION_LIMIT)) {
    const model = record(raw);
    const id = nonempty(model?.modelId);
    if (!model || !id || seen.has(id)) continue;
    seen.add(id);
    const provider = nonempty(model.provider);
    options.push({ id, label: nonempty(model.name) ?? id, ...(provider ? { provider } : {}) });
  }
  const bounded = decodeChoices(options);
  const currentValue = bounded.some(({ id }) => id === models.currentModelId) ? nonempty(models.currentModelId) : undefined;
  return { options: bounded, ...(currentValue ? { currentValue } : {}) };
}

export function offeredModels(result: unknown, configId: string): string[] {
  return acpModelOption(result, configId)?.options.map(({ id }) => id) ?? [];
}
