// SPDX-License-Identifier: AGPL-3.0-or-later
// Frozen layout-4 columns from 2ef45fd03b: older releases require this exact trigger SQL.
export const INBOX_RAW_COLUMNS_V4 = `m.rowid AS source_row, m.thread_id, m.id AS message_id, m.at, m.kind,
    COALESCE(json_extract(m.json,'$.card.expired'),0) AS expired,
    json_extract(m.json,'$.routineRun.runId') AS run_id, json_extract(m.json,'$.routineRun.routineId') AS routine_id,
    json_array(m.thread_id,m.kind,CASE m.kind
      WHEN 'options' THEN COALESCE(json_extract(m.json,'$.card.requestId'),json_extract(m.json,'$.card.routineRequest.requestId'),json_extract(m.json,'$.card.skillRequest.requestId'),m.id)
      WHEN 'secret' THEN COALESCE(json_extract(m.json,'$.secret.requestKey'),m.id)
      WHEN 'connector' THEN COALESCE(json_extract(m.json,'$.connector.resumeKey') || ':' || json_extract(m.json,'$.connector.slug'),m.id)
      WHEN 'mcpSignIn' THEN COALESCE(json_extract(m.json,'$.mcpSignIn.resumeKey') || ':' || json_extract(m.json,'$.mcpSignIn.name'),m.id)
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.runId'),m.id)
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.runId'),m.id)
      WHEN 'text' THEN json_extract(m.json,'$.artifactIds[0]')
      -- RULE 3, WHERE THE GROUPING ALREADY HAPPENS. An engine that is not
      -- signed in writes one of these every time a turn tries to use it, and
      -- they were keyed by message id, so twenty attempts were twenty rows
      -- saying the same sentence. One key per thread per cause makes them one
      -- row carrying the count.
      WHEN 'activity' THEN CASE
        WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection'
        ELSE m.id END
      ELSE m.id END) AS source_key,
    CASE m.kind
      WHEN 'options' THEN CASE
        WHEN json_extract(m.json,'$.card.expired')=1 AND json_extract(m.json,'$.card.unattended')=1
          AND COALESCE(json_extract(m.json,'$.card.sentAsMessage'),0)=0 AND COALESCE(json_extract(m.json,'$.card.dismissed'),0)=0 THEN 'missed'
        WHEN json_type(m.json,'$.card.answered')='text' OR json_extract(m.json,'$.card.dismissed')=1 THEN 'resolved'
        -- D7: an approval whose request died with a previous process
        -- (index.ts boot sweep) is not waiting on anyone any more.
        WHEN json_extract(m.json,'$.card.orphaned')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'secret' THEN CASE WHEN json_extract(m.json,'$.secret.provided')=1 OR json_extract(m.json,'$.secret.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'connector' THEN CASE WHEN json_extract(m.json,'$.connector.status')='connected' OR json_extract(m.json,'$.connector.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      -- A link server's sign-in that ended mid-turn (MCP-LINK 3.12): owed until
      -- the owner signs in again or sets the card aside.
      WHEN 'mcpSignIn' THEN CASE WHEN json_extract(m.json,'$.mcpSignIn.status')='signed-in' OR json_extract(m.json,'$.mcpSignIn.dismissed')=1 THEN 'resolved' ELSE 'pending' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.goalStatus'),json_extract(m.json,'$.routineRun.status'))
      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'digest' ELSE 'failed' END
      WHEN 'goal.run' THEN json_extract(m.json,'$.goalRun.status') WHEN 'text' THEN 'completed' ELSE 'failed' END AS status,
    -- The projection keeps a PREVIEW (the list shows 280 characters, a digest 1000): capped in SQL so the full text of a huge message is never copied into the projection.
    substr(CASE m.kind WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN COALESCE(json_extract(m.json,'$.tool.name'),'') ELSE '' END
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.summary'),json_extract(m.json,'$.routineRun.error'),'')
      WHEN 'goal.run' THEN COALESCE(json_extract(m.json,'$.goalRun.detail'),'') WHEN 'text' THEN COALESCE(json_extract(m.json,'$.text'),'Saved file')
      WHEN 'mcpSignIn' THEN COALESCE(json_extract(m.json,'$.mcpSignIn.body'),'') ELSE '' END, 1, 2048) AS summary,
    substr(CASE m.kind WHEN 'options' THEN CASE
      WHEN json_type(m.json,'$.card.routineRequest')='object' THEN 'Routine proposal'
      WHEN json_type(m.json,'$.card.skillRequest')='object' THEN 'Skill proposal'
      -- Expired is checked before the tool, so every expired card called
      -- itself a question. Under a tab named Approvals that reads as though
      -- the wrong row arrived, and "whether it has expired" was the exact
      -- thing reported as impossible to tell.
      WHEN json_extract(m.json,'$.card.expired')=1 THEN
        CASE WHEN json_type(m.json,'$.card.tool')='text' THEN 'Approval expired' ELSE 'Question expired' END
      WHEN json_type(m.json,'$.card.tool')='text' THEN 'Approval requested' ELSE 'Question needs an answer' END
      WHEN 'secret' THEN 'Credential setup requested' WHEN 'connector' THEN 'Connection setup'
      WHEN 'mcpSignIn' THEN 'Sign in to ' || COALESCE(json_extract(m.json,'$.mcpSignIn.host'),'a server')
      WHEN 'routine.run' THEN COALESCE(json_extract(m.json,'$.routineRun.routineName'),'Routine result')
      WHEN 'goal.run' THEN 'Team goal result' WHEN 'text' THEN 'Saved file'
      -- A provider having a bad morning and an engine that is not signed in
      -- are not the same news, and only one of them is anybody's job.
      WHEN 'activity' THEN CASE
        WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'Daily digest'
        WHEN json_extract(m.json,'$.tool.authRequired')=1 THEN 'Sign in needed'
        WHEN json_extract(m.json,'$.tool.setup')=1 THEN 'Setup needed'
        ELSE 'Provider needs attention' END
      ELSE 'Provider needs attention' END, 1, 2048) AS title,
    -- WHICH OF THE FIVE LISTS THIS BELONGS IN.
    --
    -- The kind column says what SHAPE the message is. This says what it
    -- costs the owner to ignore it, which is the only question the Inbox is
    -- sorted on.
    --
    -- The split inside 'options' is the one the owner asked for: a card
    -- carrying a TOOL is permission to perform a specific, already drafted
    -- act ("send these four emails"), and everything else of that shape is a
    -- question wanting a judgement ("should this become a routine?"). They
    -- read the same in a list and are nothing alike to answer.
    --
    -- An 'activity' row that is a missing login or an unfinished setup is a
    -- CONNECTION, not provider news: it needs the owner's hands and no
    -- amount of waiting fixes it. A provider simply erroring is news.
    CASE m.kind
      WHEN 'options' THEN CASE WHEN json_type(m.json,'$.card.tool')='text' THEN 'approval' ELSE 'question' END
      WHEN 'secret' THEN 'connection' WHEN 'connector' THEN 'connection' WHEN 'mcpSignIn' THEN 'connection'
      WHEN 'activity' THEN CASE WHEN json_extract(m.json,'$.actorKind')='murage' AND json_extract(m.json,'$.murage.kind')='status' AND json_type(m.json,'$.murage.digestDay')='text' THEN 'result' WHEN json_extract(m.json,'$.tool.authRequired')=1 OR json_extract(m.json,'$.tool.setup')=1 THEN 'connection' ELSE 'routine' END
      WHEN 'routine.run' THEN 'routine' WHEN 'goal.run' THEN 'routine'
      ELSE 'result' END AS kind_segment`;
