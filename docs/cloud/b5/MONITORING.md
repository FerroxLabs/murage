# Monitoring v1

- **Heartbeat**: the existing `POST /v1/machines/<id>/heartbeat` (every 60 s, `murage-control`) now carries an optional
  `health` block: `diskUsedPercent` (int 0-100, `/data`), `lastBackupAt` (ms, from `/var/lib/murage-home/backup-last`),
  `events` (max 5, allowlist, no free text). Schema is strict: unknown fields, free text and credential-looking content are rejected.
  No credential content is ever collected: the home copies only a fixed event name and a timestamp out of spool files.
- **Alerts** (control plane cron, every 5 min; table `cloud_alerts`, one open alert per home and kind):
  `home.heartbeat_missed` (>5 min), `home.disk_high` (>=85%), `home.backup_stale` (>26 h, only for homes that report backups),
  `abuse.mining_suspected` (home event; stays open until an operator resolves it).
  Recoveries send `<kind>.resolved`.
- **Mining flag from lane 1**: the detector drops `{"type":"abuse.mining_suspected","at":<ms>}` as a file in
  `/var/lib/murage-home/events/` (root-owned dir; the control transport sends it on the next heartbeat and deletes it).
- **Daily summary**: first cron tick after 07:00 UTC, once per UTC day.
- **Webhook**: Worker var/secret `ALERT_WEBHOOK_URL` (https only). Body: `{kind, severity, homeId?, text, at}`; `text` works as-is for
  Slack/Discord-style hooks; a Telegram or email relay maps `text`. Undelivered alerts retry every 5 min (20 attempts). Set it with
  `printf %s "$URL" | wrangler secret put ALERT_WEBHOOK_URL`. Until set, alerts are stored and retried, not lost.
