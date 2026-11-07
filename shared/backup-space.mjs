/** One calculation for admission and display, including uncertain device identity. */
const known = value => Number.isFinite(value) && value >= 0;
export function volumeLayout(backup, data) {
  const reliable = value => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'bigint' && value > 0n);
  return reliable(backup) && reliable(data) ? (backup === data ? 'shared' : 'split') : 'unknown';
}
export function floorFor(free, leftover = 0) {
  return known(free) ? free + (known(leftover) ? leftover : 0) + Math.max(256 * 1024 ** 2, Math.ceil(0.2 * free)) : null;
}
export function implicatedVolumes(step, platform) {
  if (['stage', 'inventory', 'manifest', 'readback'].includes(step)) return ['data'];
  if (['encrypt', 'flush', 'publish'].includes(step) || (step === 'private-stage' && platform !== 'win32')) return ['backup'];
  return ['backup', 'data'];
}
export function spaceRequirement({layout, estimates = {}, room, free = {}}) {
  const sum = (estimates.backup ?? 0) + (estimates.data ?? 0);
  let floors = {...room?.floors}, mode = room?.mode;
  if (layout === 'shared' && room) {
    const values = Object.values(floors).filter(known);
    floors = {shared: values.length ? Math.max(...values) : null};
    mode = 'pinned';
  } else if (Object.hasOwn(floors, 'shared')) {
    floors = {backup: floors.shared, data: floors.shared}; mode = 'either';
  }
  const rows = (layout === 'shared' ? ['shared'] : ['backup','data']).map(kind => {
    const estimate = layout !== 'split' ? sum : estimates[kind] ?? 0;
    const available = known(free[kind]) ? free[kind] : undefined;
    const floored = Object.hasOwn(floors, kind), floor = floors[kind];
    return {kind, estimate, available, floored, floor,
      estimateShort: available === undefined ? !!room : available < estimate,
      floorShort: floored && (available === undefined || available < Math.max(estimate, floor ?? 0))};
  });
  const candidates = rows.filter(row => row.floored);
  const floorBlocks = mode === 'either' ? candidates.length > 0 && candidates.every(row => row.floorShort) : candidates.some(row => row.floorShort);
  const volumes = rows.map(row => {
    const floorActive = floorBlocks && row.floorShort;
    const requiredBytes = Math.max(row.estimate, floorActive ? row.floor ?? 0 : 0);
    const blocking = row.estimateShort || floorActive;
    return {kind:row.kind, requiredBytes, blocking, alternative:mode === 'either' && row.floored,
      ...(row.floored ? {floorBytes:row.floor} : {}),
      ...(row.available === undefined ? {} : {freeBytes:row.available, neededBytes:blocking ? Math.max(1,requiredBytes-row.available) : 0})};
  });
  const headlineIndex = rows.findIndex(row => row.estimateShort);
  const headline = headlineIndex >= 0 ? volumes[headlineIndex] : volumes.find(row => row.blocking);
  return {short:!!headline, drive:headline ? (headline.kind === 'data' ? 'data' : 'backup') : null,
    ...(headline?.freeBytes === undefined ? {} : {requiredBytes:headline.requiredBytes,neededBytes:headline.neededBytes}), volumes};
}
