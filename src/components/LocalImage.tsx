import { useEffect, useRef, useState } from 'react';
import type { WorkspaceScopeRef, FileRevision } from '../../shared/workspace-files';
import { LocalImageController, type LocalImageState, type LocalImageView } from '@/lib/local-image-controller';
import { api } from '@/state/store';
import { t } from '@/lib/i18n';
import { ImageLightbox, type ImageMediaItem } from './ImageMedia';
import { UseAsReferenceButton } from './UseAsReferenceButton';
const words: Partial<Record<LocalImageState, string>> = { outside: 'onlyWorkspace', remote: 'desktopOnly', 'not-listed': 'missing', missing: 'missing', changed: 'changed', denied: 'denied', unsupported: 'unsupported', unanswered: 'unreachable', 'load-failed': 'changed', 'save-failed': 'unreachable', 'budget-wait': 'budget', 'ready-large': 'large' };
export function LocalImage({ candidate, scope, alt }: { candidate: string; scope: WorkspaceScopeRef; alt: string }) {
  const [view, setView] = useState<LocalImageView>({ state: 'waiting', surface: 'thumbnail', node: 0 });
  const root = useRef<HTMLSpanElement>(null), controller = useRef<LocalImageController | null>(null);
  useEffect(() => {
    const request = candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) ? { scope, absolutePath: candidate } : { scope, relativePath: candidate };
    const current = new LocalImageController(request, api, () => setView({ ...current.view })); controller.current = current; setView({ ...current.view });
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined' && root.current) { observer = new IntersectionObserver(entries => { for (const entry of entries) current.visibility(entry.isIntersecting); }, { rootMargin: '100% 0px' }); observer.observe(root.current); }
    return () => { observer?.disconnect(); current.dispose(); controller.current = null; };
  }, [candidate, scope.botId, scope.threadId]);
  const ready = view.ready, asset = ready?.asset;
  const item: ImageMediaItem | undefined = ready && asset ? { id: `workspace:${asset.id}:${asset.revision}`, src: ready.url, name: asset.name, alt, source: 'workspace', download: !!asset.capabilities.download, ...(asset.capabilities.imageReference ? { reference: { threadId: scope.threadId, botId: scope.botId, source: { kind: 'workspace', relativePath: ready.relativePath, revision: asset.revision! as FileRevision } } } : {}) } : undefined;
  const node = view.node;
  const key = words[view.state];
  return <span ref={root} className="my-1 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-hairline/40 p-2 text-[12px] text-ink-secondary" data-image-media-state={view.state}>
    <span>{alt}</span>
    {key && <span>{t(`media.local.${key}` as Parameters<typeof t>[0], { width: asset?.width ?? 0, height: asset?.height ?? 0 })}</span>}
    {view.changedShown && <span>{t('media.local.changedShown')}</span>}
    {item && node > 0 && view.surface === 'thumbnail' && <button type="button" onClick={() => controller.current?.open()} aria-label={t('media.thumb.open', { name: item.name })}>
      <img key={`${item.id}#${item.src}#${node}`} ref={element => controller.current?.attach(element, node)} src={item.src} alt={alt} sizes="(max-width: 767.98px) 90vw, 640px" referrerPolicy="no-referrer" className="max-h-96 max-w-full rounded-lg" onLoad={() => controller.current?.loaded(node)} onError={() => controller.current?.error(node)} />
    </button>}
    {item && node > 0 && view.surface === 'lightbox' && <ImageLightbox items={[item]} index={0} onClose={() => controller.current?.close()} onLoad={() => controller.current?.loaded(node)} onError={() => controller.current?.error(node)} onImageRef={element => controller.current?.attach(element, node)} onDownload={() => controller.current?.save()} downloadDisabled={!!view.saving} />}
    {(view.state === 'ready-large' || view.state === 'budget-wait') && <button type="button" onClick={() => controller.current?.open()}>{t('media.local.showIt')}</button>}
    {view.surface === 'lightbox' && node === 0 && <button type="button" onClick={() => controller.current?.close()}>{t('media.lightbox.close')}</button>}
    {item && node > 0 && <><span>{t('media.source.workspace')}</span>{item.download && <button type="button" disabled={!!view.saving} onClick={() => controller.current?.save()}>{t('media.lightbox.downloadTitle')}</button>}{item.reference && <UseAsReferenceButton {...item.reference} name={item.name} />}</>}
    {!['outside', 'remote', 'denied', 'disposed'].includes(view.state) && <button type="button" onClick={() => controller.current?.retry()}>{t('media.local.tryAgain')}</button>}
  </span>;
}
