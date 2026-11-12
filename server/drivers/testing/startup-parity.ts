// Complete native startup snapshots, with only ephemeral identity values normalized.
// No argv flag or turn/start field is removed from the comparison.
export function normalizeStartup(value: unknown, cwd: string): unknown {
 const text = (s: string) => s.split(cwd).join('<cwd>')
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
  .replace(/claude-private\/[a-f0-9]+\.json/g, 'claude-private/<settings>.json')
  .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:<port>')
  .replace(/\/tmp\/[^\s"']+/g, s => s.replace(/-[A-Za-z0-9]{6}(?=\/|$)/g, '-<temp>'));
 if (typeof value === 'string') return text(value);
 if (Array.isArray(value)) return value.map(v => normalizeStartup(v, cwd));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalizeStartup(v,cwd)]));
 return value;
}
