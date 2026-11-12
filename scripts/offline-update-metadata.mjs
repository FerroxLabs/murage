// Local updater files only. No publisher is registered with electron-builder.
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';

export async function writeAppUpdate(context, resources) {
  const packager = context.packager;
  if (!packager) return; // Partial resource-validation fixtures are not packages.
  if (packager.config.publish !== null) throw new Error('builder publishing must be disabled');
  const qualification = packager.config.extraMetadata?.murageQualification === true;
  let feed;
  if (qualification) {
    const url = new URL(process.env.MURAGE_QUALIFICATION_FEED_URL);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid qualification feed URL');
    feed = { provider: 'generic', url: url.href, channel: 'latest', updaterCacheDirName: 'murage-qualification-updater' };
  } else {
    feed = { provider: 'github', owner: 'FerroxLabs', repo: 'murage-releases', updaterCacheDirName: packager.appInfo.updaterCacheDirName };
  }
  if (context.electronPlatformName === 'win32' && packager.isForceCodeSigningVerification) {
    const publisherName = await (await packager.signingManager.value).computedPublisherName.value;
    if (publisherName != null) feed.publisherName = publisherName;
  }
  writeFileSync(join(resources, 'app-update.yml'), stringify(feed));
}

// afterAllArtifactBuild receives final installer paths, including both Mac
// architectures. Stapling later refreshes their hashes with regenerate-mac-feed.
export default function writeUpdateFeeds(result) {
  const groups = new Map();
  for (const file of result.artifactPaths) {
    const name = basename(file);
    const feed = /\.(?:zip|dmg)$/.test(name) ? 'latest-mac.yml' :
      /-setup\.exe$/.test(name) ? 'latest.yml' : /\.(?:AppImage|deb)$/.test(name) ? 'latest-linux.yml' : null;
    if (!feed) continue;
    const files = groups.get(feed) ?? [];
    files.push({ url: name, sha512: createHash('sha512').update(readFileSync(file)).digest('base64'), size: statSync(file).size });
    groups.set(feed, files);
  }
  for (const [feed, files] of groups) {
    // The legacy fallback must select an updater payload (zip, NSIS, AppImage).
    files.sort((a, b) => Number(/\.(?:dmg|deb)$/.test(a.url)) - Number(/\.(?:dmg|deb)$/.test(b.url)) || a.url.localeCompare(b.url));
    const versions = new Set(files.map(file => /^Murage-(\d+\.\d+\.\d+)-/.exec(file.url)?.[1]));
    if (versions.size !== 1 || versions.has(undefined)) throw new Error('update artifacts must have one canonical version');
    writeFileSync(join(result.outDir, feed), stringify({version: [...versions][0], files, path: files[0].url, sha512: files[0].sha512, releaseDate: new Date().toISOString()}));
  }
  // Do not return artifact paths: the builder could hand them to a publisher.
}
