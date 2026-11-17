import { Fragment } from "react";
import type { ModelOrderRow, OrderedModel } from "../../shared/model-order";

/** Native selects use the same visual and keyboard order. The quiet label is
 * an optgroup, so it cannot become a selectable model. */
export function OrderedModelOptions<T extends ModelOrderRow>({ rows, label, disabled }: {
  rows: readonly OrderedModel<T>[];
  label?: (row: T) => string;
  disabled?: (row: T) => boolean;
}) {
  const option = (row: OrderedModel<T>) => <option key={row.id} value={row.id} disabled={disabled?.(row)}>{label?.(row) ?? row.label}</option>;
  const firstOlder = rows.findIndex(row => row.older);
  if (firstOlder < 0) return <>{rows.map(option)}</>;
  // The shared function has already placed the older section after current rows.
  return <Fragment>{rows.slice(0, firstOlder).map(option)}<optgroup label="Older versions">{rows.slice(firstOlder).map(option)}</optgroup></Fragment>;
}
