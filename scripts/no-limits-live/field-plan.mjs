// Preserve the field tool/input identity; never substitute a harmless shell.
export function fieldPlan(spec) {
  if (!spec.tool || !Object.hasOwn(spec, 'input')) throw Error('Field row lacks full tool input');
  return { tool:spec.tool,input:structuredClone(spec.input),outside:spec.outside,
    instruction:`Use exactly the ${spec.tool} tool once with this input: ${JSON.stringify(spec.input)}. Do not substitute another tool or describe the result.` };
}
