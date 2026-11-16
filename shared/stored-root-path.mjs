// S5's lexical resolver, shared by the server and desktop. Never reads a stored path.
function form(path, platform) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return;
  let value = path, root, rest;
  if (platform === 'win32') {
    if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith('\\\\?\\')) value = value.slice(4);
    value = value.replace(/\//g, '\\').toLowerCase();
    const drive = /^([a-z]):\\/.exec(value), unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(value);
    if (drive) { root = `${drive[1]}:`; rest = value.slice(3); }
    else if (unc) { root = `\\\\${unc[1]}\\${unc[2]}`; rest = value.slice(unc[0].length); }
    else return;
    rest = rest.replace(/\\+$/, '');
  } else {
    if (platform === 'darwin') value = value.normalize('NFC');
    if (!value.startsWith('/')) return;
    root = '/'; rest = value.slice(1).replace(/\/+$/, '');
  }
  const segments = rest === '' ? [] : rest.split(platform === 'win32' ? /\\/ : /\//);
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return;
  return { root, segments };
}
export function lexicalKey(path, platform) {
  const parsed = form(path, platform);
  return parsed && `${parsed.root}|${parsed.segments.join('/')}`;
}
function under(inner, outer, platform) {
  const fold = value => platform === 'darwin' ? value.toLowerCase() : value;
  const a = form(fold(inner), platform), b = form(fold(outer), platform);
  return !!a && !!b && a.root === b.root && a.segments.length >= b.segments.length && b.segments.every((part, i) => a.segments[i] === part);
}
function values(constructors, root) { try { return constructors(root); } catch { return []; } }
export function rebaseStoredPath(stored, constructors, { dataDir, previous = [], platform }) {
  const key = lexicalKey(stored, platform), current = values(constructors, dataDir);
  if (key !== undefined && current.some(value => value && lexicalKey(value, platform) === key)) return { keep: true };
  if (key === undefined) return [dataDir, ...previous].some(root => stored.startsWith(root)) ? { refused: true } : { keep: true };
  const distinct = new Map();
  for (const root of previous) values(constructors, root).forEach((value, index) => {
    const next = current[index];
    if (value && next && lexicalKey(value, platform) === key) distinct.set(lexicalKey(next, platform) ?? next, next);
  });
  if (distinct.size === 1) return { path: [...distinct.values()][0] };
  if (distinct.size > 1 || previous.some(root => under(stored, root, platform))) return { refused: true };
  return { keep: true };
}
