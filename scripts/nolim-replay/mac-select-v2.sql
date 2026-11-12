-- One read-only SELECT; no key file, extension, ATTACH, or write.
-- 1.0.18 pin 292df98d: approval-text.ts:61-90,172-175;
-- index.ts:9708-9725; store.ts:121-140. See MAC-SELECT-V2.md.
WITH eligible AS (
  SELECT m.thread_id, m.id, m.at, m.json
  FROM messages m
  WHERE m.kind='options'
    AND m.at>=1794225600000 AND m.at<1794276900000
    AND json_type(m.json,'$.card.requestId')='text'
    AND json_type(m.json,'$.card.tool')='text'
), bounded AS (
  SELECT * FROM eligible ORDER BY at,thread_id,id LIMIT 2000
), output AS (
  SELECT 0 AS position, 0 AS stamp, '' AS thread, '' AS message,
    json_object('schema','murage.nolim-cards-count.v2',
      'total',(SELECT count(*) FROM eligible),
      'emitted',(SELECT count(*) FROM bounded),'limit',2000) AS line
  UNION ALL
  SELECT 1,m.at,m.thread_id,m.id,json_object(
    'schema','murage.nolim-card.v2','thread_id',m.thread_id,'id',m.id,'at',m.at,
    'requestId',json_extract(m.json,'$.card.requestId'),
    'tool',json_extract(m.json,'$.card.tool'),
    -- summary is only a discriminator, NEVER a projected value. A different
    -- summary is stamped when cardDetail supplied input/reason instead.
    -- JSON object shape excludes the labelled-reason/prose fallback.
    'boundedToolInput',CASE
      WHEN json_type(m.json,'$.card.subtitle')='text'
       AND json_type(m.json,'$.card.summary')='text'
       AND json_extract(m.json,'$.card.subtitle')<>json_extract(m.json,'$.card.summary')
      THEN CASE
        WHEN json_valid(json_extract(m.json,'$.card.subtitle')) THEN
          CASE WHEN json_type(json_extract(m.json,'$.card.subtitle'))='object'
            THEN json_extract(m.json,'$.card.subtitle') END
        WHEN json_extract(m.json,'$.card.toolInputTruncated')=1
          AND substr(json_extract(m.json,'$.card.subtitle'),1,2)='{"'
          AND json_extract(m.json,'$.card.subtitle') GLOB '*'||char(10)||'[[]truncated, [0-9]* bytes more]'
          THEN json_extract(m.json,'$.card.subtitle') END END,
    'toolInputTruncated',json_extract(m.json,'$.card.toolInputTruncated'),
    'origin',json_extract(m.json,'$.origin'),
    'cardClass',json_object('origin',json_extract(m.json,'$.card.cardClass.origin'),
      'unattended',json_extract(m.json,'$.card.cardClass.unattended'),
      'automated',json_extract(m.json,'$.card.cardClass.automated')),
    'actorKind',json_extract(m.json,'$.actorKind'),
    'memberBotId',json_extract(m.json,'$.memberBotId'),
    'answered',json_extract(m.json,'$.card.answered'),
    'dismissed',json_extract(m.json,'$.card.dismissed'),
    'parentId',json_extract(m.json,'$.parentId'),'turnId',json_extract(m.json,'$.turnId'),
    'threadNo',n.no,'lineLsn',l.lsn,'turnLsn',l.turn_lsn,
    'memoryLsn',l.mem_lsn,'footprintId',l.footprint)
  FROM bounded m
  LEFT JOIN memory_thread_no n ON n.thread_id=m.thread_id
  LEFT JOIN memory_line_lineage l ON l.thread_no=n.no AND l.message_id=m.id
)
SELECT line FROM output ORDER BY position,stamp,thread,message;
