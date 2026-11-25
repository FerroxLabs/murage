// SPDX-License-Identifier: AGPL-3.0-or-later
// Observation only, appended to the eval worker after activate(). The real
// scheduler, DB operations, reset protocol and retry decisions are untouched.
// This is needed while qualification is built in parallel with production's
// stepped telemetry. Production fields take precedence when present.
export const telemetry = String.raw`
const qualTimes = {};
let qualScrubs = 0;
for (const name of ['apply','drop','rebuild','cleanup']) {
  const original = eval(name);
  const wrapped = (...args) => {
    const at = performance.now();
    let merging = false;
    if (name === 'cleanup') { try { merging = String(state('debt')).endsWith(':0'); } catch {} }
    try { return original(...args); }
    finally { qualTimes[merging ? 'merge' : name] = performance.now() - at; }
  };
  if (name === 'apply') apply = wrapped;
  if (name === 'drop') drop = wrapped;
  if (name === 'rebuild') rebuild = wrapped;
  if (name === 'cleanup') cleanup = wrapped;
}
const qualPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = qualPrepare.call(this,sql);
  if (/^PRAGMA wal_checkpoint\(TRUNCATE\)/i.test(sql)) {
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      qualScrubs++;
      return get(...args);
    };
  }
  return statement;
};
const qualPost = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = event => {
  if (event.type === 'stepped') {
    event['step-ms'] ??= (qualTimes.apply || 0) + (qualTimes.rebuild || 0) + (qualTimes.cleanup || 0);
    event['merge-ms'] ??= qualTimes.merge || 0;
    event['qual-phases'] = {...qualTimes};
    event['qual-scrubs'] = qualScrubs;
    for (const key of Object.keys(qualTimes)) delete qualTimes[key];
    qualScrubs = 0;
  }
  return qualPost(event);
};
`;
