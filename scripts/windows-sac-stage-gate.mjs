// Extraction producer/consumer owner: Builder A; protected pins, controller keys and deployment owner: MAIN.
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readWindowsPeSnapshot, peSha256 } from './windows-pe-signing.mjs';
import { pathToFileURL } from 'node:url';
import { verifyWindowsSacPromotion, windowsSacPromotionOptions } from './windows-sac-promotion.mjs';

const read = async file => (await readWindowsPeSnapshot(file)).bytes;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function invocationOptions(command, options) {
  if (!['stage', 'publish-prepared'].includes(command)) throw Error('WINDOWS_SAC_EXTRACTION_INVOCATION');
  return {...options, publication: options.publication ?? {runId: options.identity.runId, runAttempt: options.identity.runAttempt}, extractionInvocation: command};
}
function context(options) {
  return {identity: options.identity, publication: options.publication, candidateSha256: options.candidateSha256,
    evidenceSha256: options.evidenceSha256, extractorSha256: options.extractor.sha256, bundleSha256: options.extractor.bundleSha256};
}

// The shared verifier authenticates the extraction-result key, materializes the archive and rehashes every PE.
export async function consumeWindowsSacInvocation(command, options, input = path.resolve(command === 'stage' ? 'sac-extraction-stage' : 'sac-extraction-publish')) {
  options = invocationOptions(command, options);
  let consumed = false;
  return verifyWindowsSacPromotion(options, {async run(_file, args) {
    if (consumed) throw Error('WINDOWS_SAC_EXTRACTION_REPLAY');
    consumed = true;
    const invocation = JSON.parse(await read(path.join(input, 'invocation.json')));
    if (invocation.schema !== 1 || invocation.command !== command || !same(invocation.context, context(options)))
      throw Error('WINDOWS_SAC_EXTRACTION_INVOCATION');
    const target = flag => args[args.indexOf(flag) + 1];
    const expected = JSON.parse(await read(target('--request'))), request = await read(path.join(input, 'request.json'));
    if (!same(JSON.parse(request), expected) || peSha256(request) !== invocation.requestSha256)
      throw Error('WINDOWS_SAC_EXTRACTION_REQUEST');
    for (const [name, flag, digest] of [['result.json', '--result', invocation.resultSha256], ['archive.zip', '--archive', invocation.archiveSha256]]) {
      const bytes = await read(path.join(input, name));
      if (peSha256(bytes) !== digest) throw Error('WINDOWS_SAC_EXTRACTION_DIGEST');
      await writeFile(target(flag), bytes, {flag: 'wx', mode: 0o600});
    }
  }});
}

export async function windowsSacStageGate(options = windowsSacPromotionOptions(), input) {
  const prepared = await consumeWindowsSacInvocation('stage', options, input);
  await mkdir('release-sac/extraction-stage');
  for (const name of ['invocation.json', 'request.json', 'result.json', 'archive.zip'])
    await writeFile(path.join('release-sac/extraction-stage', name), await read(path.join(input ?? path.resolve('sac-extraction-stage'), name)), {flag: 'wx', mode: 0o600});
  await writeFile('release-sac/prepared.json', JSON.stringify(prepared) + '\n', {flag: 'wx'});
  // This data travels only in this attempt's authenticated stage artifact, fetched by the existing guard download.
  await writeFile('release-sac/inputs.json', JSON.stringify(context(invocationOptions('stage', options))) + '\n', {flag: 'wx'});
  return prepared;
}

export async function retainedWindowsSacOptions(env = process.env) {
  const input = JSON.parse(await read(path.resolve('release-sac/inputs.json')));
  const review = JSON.parse(await read(path.resolve('release-review/review.json')));
  if (input.identity?.sourceRevision !== review.SHA || input.identity?.version !== env.VERSION
    || !same(input.publication, {runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT}))
    throw Error('WINDOWS_SAC_EXTRACTION_INVOCATION');
  const bundleFile = path.resolve(env.RUNNER_TEMP, 'windows-extraction/bundle.json'), bytes = await read(bundleFile);
  if (peSha256(bytes) !== input.bundleSha256) throw Error('WINDOWS_SAC_EXTRACTION_DIGEST');
  const bundle = JSON.parse(bytes);
  if (![bundle.directory, bundle.client].every(value => typeof value === 'string' && value && !['.', '..'].includes(value) && path.basename(value) === value))
    throw Error('WINDOWS_SAC_EXTRACTION_INVOCATION');
  return {...windowsSacPromotionOptions(env), ...Object.fromEntries(['identity', 'publication', 'candidateSha256', 'evidenceSha256'].map(key => [key, input[key]])),
    extractor: {bundleFile, bundleSha256: input.bundleSha256, file: path.join(path.dirname(bundleFile), bundle.directory, bundle.client), sha256: input.extractorSha256}};
}

export async function extractWindowsSacInvocation(command, options = windowsSacPromotionOptions(), output = path.resolve('sac-extraction')) {
  if (!['stage', 'publish-prepared'].includes(command) || !path.isAbsolute(output)) throw Error('WINDOWS_SAC_EXTRACTION_INVOCATION');
  await mkdir(output);
  options = invocationOptions(command, options);
  let invocation;
  await verifyWindowsSacPromotion(options, {async run(file, args, settings) {
    if (invocation) throw Error('WINDOWS_SAC_EXTRACTION_REPLAY');
    await promisify(execFile)(file, args, settings);
    const request = await read(args[args.indexOf('--request') + 1]), result = await read(args[args.indexOf('--result') + 1]), archive = await read(args[args.indexOf('--archive') + 1]);
    invocation = {schema: 1, command, context: context(options), requestSha256: peSha256(request), resultSha256: peSha256(result), archiveSha256: peSha256(archive)};
    for (const [name, bytes] of [['request.json', request], ['result.json', result], ['archive.zip', archive]])
      await writeFile(path.join(output, name), bytes, {flag: 'wx', mode: 0o600});
  }});
  if (!invocation) throw Error('WINDOWS_SAC_EXTRACTION_REQUIRED');
  await writeFile(path.join(output, 'invocation.json'), JSON.stringify(invocation) + '\n', {flag: 'wx'});
  return invocation;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const operation = args.length === 0 ? windowsSacStageGate()
    : args.length === 1 && args[0] === 'extract-stage' ? extractWindowsSacInvocation('stage')
    : args.length === 1 && args[0] === 'extract-publish' ? extractWindowsSacInvocation('publish-prepared')
    : Promise.reject(Error('WINDOWS_SAC_GATE_USAGE'));
  operation.catch(() => { console.error('WINDOWS_SAC_STAGE_GATE_FAILED'); process.exitCode = 1; });
}
