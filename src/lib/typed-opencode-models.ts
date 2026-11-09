import { typedOpenCodeModel, typedOpenCodeModelId } from "../../shared/opencode-model-id";
import { t } from "./i18n";
import type { PickerEngine, PickerSelection } from "./provider-model-picker";

/** Add typed choices to the existing engine's rows without changing the engine order. */
export function withTypedOpenCodeModels<T extends PickerEngine>(engine: T, selection: PickerSelection, query: string): T {
  if (engine.driverKind !== "opencodeGo") return engine;
  const listed = (id: string) => engine.models.options.some(option => option.id === id);
  const selected = selection.instanceId === engine.instanceId && typedOpenCodeModel(selection.model) ? selection.model : null;
  const searched = typedOpenCodeModelId(query);
  const typed = [selected, searched && !listed(typedOpenCodeModel(searched)!) ? searched : null]
    .filter((id, index, all): id is string => id !== null && !listed(id) && all.indexOf(id) === index);
  return typed.length ? { ...engine, models: { ...engine.models, options: [...engine.models.options,
    ...typed.map(id => ({ id, label: t("model.typedByHand", { id: typedOpenCodeModel(id)! }) }))] } } : engine;
}
