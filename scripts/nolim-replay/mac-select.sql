-- REVIEW DRAFT. Requires Sean's approval AND MAIN's exact 120-key join file.
-- Run from the reviewed directory containing accepted-keys.json. No fallback.
WITH keys AS (
  SELECT json_extract(value,'$.diagnosticId') AS diagnostic_id,
         json_extract(value,'$.threadId') AS thread_id,
         json_extract(value,'$.messageId') AS message_id,
         json_extract(value,'$.requestId') AS request_id,
         json_extract(value,'$.botId') AS bot_id,
         json_extract(value,'$.tool') AS tool,
         json_extract(value,'$.at') AS at
  FROM json_each(CAST(readfile('accepted-keys.json') AS TEXT))
), admitted AS (
  SELECT * FROM keys
  WHERE (SELECT count(*) FROM keys)=120
    AND (SELECT count(DISTINCT diagnostic_id) FROM keys)=120
    AND (SELECT count(*) FROM (SELECT DISTINCT thread_id,message_id FROM keys))=120
    AND diagnostic_id GLOB 'd[0-9][0-9][0-9][0-9]'
    AND length(thread_id)>0 AND length(message_id)>0
    AND length(request_id)>0 AND length(bot_id)>0
    AND typeof(at)='integer'
    AND at>1794225600000 AND at<1794276900000
    AND at<>1794276000000
)
SELECT json_object(
  'schema','murage.nolim-store-row.v1',
  'diagnosticId',k.diagnostic_id,'threadId',m.thread_id,'messageId',m.id,
  'requestId',k.request_id,'censusBotId',k.bot_id,
  'storedMemberBotId',json_extract(m.json,'$.memberBotId'),
  'at',m.at,'tool',json_extract(m.json,'$.card.tool'),
  -- The production Message schema has NO typed arguments field. Do not parse
  -- subtitle/summary/allowKey, infer arguments, or export display prose.
  'arguments',NULL,'argumentsAvailable',json('false'),
  'storedOrigin',json_extract(m.json,'$.origin'),
  'cardOrigin',json_extract(m.json,'$.card.cardClass.origin'),
  'actorKind',json_extract(m.json,'$.actorKind'),
  'unattended',json_extract(m.json,'$.card.cardClass.unattended'),
  'automated',json_extract(m.json,'$.card.cardClass.automated'),
  'inputTruncated',json_extract(m.json,'$.card.toolInputTruncated'),
  'ownerStarted',NULL,'outsideRead',NULL,
  'parentId',json_extract(m.json,'$.parentId'),
  'turnId',json_extract(m.json,'$.turnId'),
  'threadNo',n.no,'lineLsn',l.lsn,'turnLsn',l.turn_lsn,
  'memoryLsn',l.mem_lsn,'footprintId',l.footprint
)
FROM admitted k
JOIN messages m ON m.thread_id=k.thread_id AND m.id=k.message_id
LEFT JOIN memory_thread_no n ON n.thread_id=m.thread_id
LEFT JOIN memory_line_lineage l ON l.thread_no=n.no AND l.message_id=m.id
WHERE m.kind='options' AND m.at=k.at
  AND json_extract(m.json,'$.card.requestId')=k.request_id
  AND json_extract(m.json,'$.card.tool')=k.tool
  AND (json_extract(m.json,'$.memberBotId') IS NULL
       OR json_extract(m.json,'$.memberBotId')=k.bot_id)
ORDER BY k.diagnostic_id;
