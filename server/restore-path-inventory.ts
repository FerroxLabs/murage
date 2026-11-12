import type {MoveClass} from "./test-support/restore-path-scan.ts";

/** Every enumerated move is classified. Generic helpers require caller classifications too. */
export const RESTORE_PATH_INVENTORY: Record<string,MoveClass> = {
  "server/channels/signal/park-fs.ts::move::renameWithRetry::0": {
    "kind": "generic"
  },
  "server/channels/signal/park-fs.ts::rename::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Atomically publishes Signal park journal metadata; this callback does not install a messages database."
  },
  "server/channels/signal/park-replacement.ts::setAsideLive::move::0": {
    "kind": "not-live-db",
    "reason": "Moves only the Signal channel and authentication components into a checked quarantine bundle."
  },
  "server/channels/signal/park.ts::reconcile::move::0": {
    "kind": "not-live-db",
    "reason": "Parks or restores only the Signal channel and authentication components, without replacing messages.db."
  },
  "server/connector-set-aside.ts::resume::move::0": {
    "kind": "not-live-db",
    "reason": "Moves only schema-validated connector health, journal and notice receipt files into their set-aside directory."
  },
  "server/email/send-service.ts::acceptApproval::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::decide::move::2": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/installation-decision-downgrade.ts::copy::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Preserves queue payloads and local archive bytes in a private sibling directory; never installs them as the live database."
  },
  "deploy/cloud-home/install-launchers.py::install::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Installs checked launcher executables into the image launcher directory."
  },
  "deploy/cloud-home/murage-backup::_backup::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the  backup record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-browser-namespace.py::write::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-commands::carry_credentials::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Moves credentials and restore archives into the incoming candidate."
  },
  "deploy/cloud-home/murage-commands::carry_credentials::os.rename::1": {
    "kind": "not-live-db",
    "reason": "Moves credentials and restore archives into the incoming candidate."
  },
  "deploy/cloud-home/murage-commands::extract_validated::shutil.copyfileobj::0": {
    "kind": "not-live-db",
    "reason": "Extracts archive members into a private staging directory before the classified live installation swap."
  },
  "deploy/cloud-home/murage-commands::flip_current::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the application release symlink under the releases directory."
  },
  "deploy/cloud-home/murage-commands::place_database_snapshot::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Moves the snapshot inside the restored staging directory before swap_in and marker consumption."
  },
  "deploy/cloud-home/murage-commands::rollback_swap::os.rename::0": {
    "kind": "restores-outgoing",
    "reason": "Runs only before the swap is committed; the interrupted reset returns the outgoing installation."
  },
  "deploy/cloud-home/murage-commands::rollback_swap::os.rename::1": {
    "kind": "restores-outgoing",
    "reason": "Runs only before the swap is committed; the interrupted reset returns the outgoing installation."
  },
  "deploy/cloud-home/murage-commands::rollback_swap::os.rename::2": {
    "kind": "restores-outgoing",
    "reason": "Runs only before the swap is committed; the interrupted reset returns the outgoing installation."
  },
  "deploy/cloud-home/murage-commands::swap_in::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Moves the outgoing installation aside before the incoming installation is installed."
  },
  "deploy/cloud-home/murage-commands::swap_in::os.rename::1": {
    "kind": "installs-live-db",
    "drop": "server/email/restore-marker.ts::consumeRestoreMarker",
    "test": "P1"
  },
  "deploy/cloud-home/murage-commands::write_bytes_private::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Writes the release manifest and its signature before the application update."
  },
  "deploy/cloud-home/murage-commands::write_private::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write private record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-control::atomic_private::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the pending Flux key acknowledgement in the private control state directory."
  },
  "deploy/cloud-home/murage-control::atomic_public::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the atomic public record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-control::compact::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Compacts the control event journal with pending, sent and floor records."
  },
  "deploy/cloud-home/murage-control::save_spool_state::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes control event spool state for heartbeat retry and acknowledgement."
  },
  "deploy/cloud-home/murage-control::write_flux_subkey::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the sealed Flux subkey handoff file for the supervisor."
  },
  "deploy/cloud-home/murage-control::write_state::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write state record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-enroll::publish::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the publish record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-enroll::write_tunnel_token::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write tunnel token record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-miner-watch.py::write_event::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write event record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::agy_ledger_write::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the Antigravity credential ledger within its checked directory descriptor."
  },
  "deploy/cloud-home/murage-turn-launch.py::cleanup_browser::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the cleanup browser record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::publish_generation::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the publish generation record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::publish_generation::os.rename::1": {
    "kind": "not-live-db",
    "reason": "Publishes the publish generation record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::store_digest::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the store digest record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::write_fuigo_seed::os.replace::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write fuigo seed record or tool output outside the live messages database."
  },
  "deploy/cloud-home/murage-turn-launch.py::write_state_file::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the write state file record or tool output outside the live messages database."
  },
  "deploy/cloud-home/qualify/engine-start-check.py::fetch::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the fetch record or tool output outside the live messages database."
  },
  "deploy/cloud-home/qualify/engine-start-check.py::fetch::shutil.copyfileobj::0": {
    "kind": "not-live-db",
    "reason": "Publishes the fetch record or tool output outside the live messages database."
  },
  "deploy/cloud-home/qualify/engine-start-check.py::fetch::shutil.copyfileobj::1": {
    "kind": "not-live-db",
    "reason": "Publishes the fetch record or tool output outside the live messages database."
  },
  "deploy/cloud-home/qualify/j5b-journal-edit::<module>::os.rename::0": {
    "kind": "not-live-db",
    "reason": "Rewrites the stopped control journal in the local J5b qualification fixture."
  },
  "deploy/cloud-home/testdata/murage-control-20f95f742a.py::atomic_private::os.replace::0": {
    "kind": "not-live-db",
    "reason": "The released-control test fixture publishes only its private control state."
  },
  "deploy/cloud-home/testdata/murage-control-20f95f742a.py::atomic_public::os.replace::0": {
    "kind": "not-live-db",
    "reason": "The released-control test fixture publishes only its public control response."
  },
  "deploy/cloud-home/testdata/murage-control-20f95f742a.py::write_flux_subkey::os.replace::0": {
    "kind": "not-live-db",
    "reason": "The released-control test fixture publishes only its sealed Flux subkey handoff."
  },
  "deploy/cloud-home/testdata/murage-control-20f95f742a.py::write_state::os.replace::0": {
    "kind": "not-live-db",
    "reason": "The released-control test fixture publishes only its control state record."
  },
  "server/artifacts.ts::registerArtifact::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes an artifact under the artifact content store."
  },
  "server/atomic.ts::renameWithRetry::rename::0": {
    "kind": "generic"
  },
  "server/atomic.ts::writeFileAtomicInner::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Publishes bytes written to a new inode, not an installation directory."
  },
  "server/attachments.ts::writeImage::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes an image attachment in the attachments store."
  },
  "server/attachments.ts::writeImage::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes an image attachment in the attachments store."
  },
  "server/backup-coordinator.ts::recordFirstRun::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Writes the first-run backup receipt, a JSON record."
  },
  "server/backup-restic.ts::clearRetentionReview::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves the retention review JSON record."
  },
  "server/bot-package-archive.ts::writeBotPackageArchive::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the bot package archive outside the live database."
  },
  "server/browser-engine.ts::installAgentBrowserBinary::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Installs the browser executable into its tools directory."
  },
  "server/browser-extension-activity.ts::compact::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Rotates a browser activity log before compaction."
  },
  "server/browser-extension-approvals.ts::save::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Persists browser extension permissions and service records."
  },
  "server/browser-extension-service.ts::createBrowserExtensionService::rename::0": {
    "kind": "not-live-db",
    "reason": "Persists browser extension permissions and service records."
  },
  "server/browser-extension-service.ts::persist::rename::0": {
    "kind": "not-live-db",
    "reason": "Persists browser extension permissions and service records."
  },
  "server/browser-extension-sites.ts::save::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Persists browser extension permissions and service records."
  },
  "server/browser-window-chrome.ts::downloadOnce::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the verified Chrome download under the browser-window executable store."
  },
  "server/browser-window-chrome.ts::verifyLinux::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the Linux Chrome package verification record in the browser evidence directory."
  },
  "server/channels/signal/process-host.ts::prepareFiles::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Rotates the Signal CLI process log under the signal log directory."
  },
  "server/channels/whatsapp/bridge.ts::compact::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Persists WhatsApp authentication and bridge event records."
  },
  "server/channels/whatsapp/bridge.ts::save::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Persists WhatsApp authentication and bridge event records."
  },
  "server/channels/whatsapp/core/auth-store.ts::writeFileAtomic::rename::0": {
    "kind": "not-live-db",
    "reason": "Persists WhatsApp authentication and bridge event records."
  },
  "server/cloud-computer-turns.ts::startUnknown::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Copies the turn credential record into the turn workspace."
  },
  "server/cloud-home/engine-signins.ts::useEngineAfterSignIn::move::0": {
    "kind": "not-live-db",
    "reason": "Calls the engine-selection callback with an engine name after a completed sign-in; this is no filesystem move."
  },
  "server/cloud-home/flux-subkey-delivery.ts::completeFluxSubkey::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the Flux subkey receipt in the sealed delivery directory."
  },
  "server/cloud-home/own-server.ts::writeAtomic::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Writes only own-server SSH shims, configuration, host keys and connection records."
  },
  "server/cloud-home/server-instance.ts::writeServerInstance::rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the server instance JSON record."
  },
  "server/cloud-home/signin-offers.ts::write::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the JSON record of engine sign-in offers."
  },
  "server/connector-cache.ts::bumpGeneration::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes connector cache data and its generation record."
  },
  "server/connector-cache.ts::writeCacheEntry::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes connector cache data and its generation record."
  },
  "server/coordination-budget.ts::<module>::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Persists the coordination budget JSON record."
  },
  "server/data-roots.ts::loadAndRotateRecord::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Rotates and publishes the data roots registry record."
  },
  "server/data-roots.ts::writeRecord::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Rotates and publishes the data roots registry record."
  },
  "server/decision-log.ts::writeDecision::rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes a decision log record."
  },
  "server/drivers/acp/droid.ts::applyDroidHostComputerGrant::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/antigravity-scope.ts::adopt::moveInto::0": {
    "kind": "not-live-db",
    "reason": "Reconciles engine scoped home files and retained engine entries."
  },
  "server/drivers/antigravity-scope.ts::copyFile::copyFileSync::0": {
    "kind": "generic"
  },
  "server/drivers/antigravity-scope.ts::keep::moveInto::0": {
    "kind": "not-live-db",
    "reason": "Reconciles engine scoped home files and retained engine entries."
  },
  "server/drivers/antigravity-scope.ts::keepCopy::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/antigravity-scope.ts::link::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/antigravity-scope.ts::mirrorDirectory::copyFile::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/antigravity-scope.ts::moveInto::cpSync::0": {
    "kind": "generic"
  },
  "server/drivers/antigravity-scope.ts::moveInto::renameSync::0": {
    "kind": "generic"
  },
  "server/drivers/antigravity-scope.ts::recoverScopedHome::moveInto::0": {
    "kind": "not-live-db",
    "reason": "Reconciles engine scoped home files and retained engine entries."
  },
  "server/drivers/antigravity-scope.ts::writeManifest::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/antigravity-scope.ts::writeThrough::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/claude-private.ts::writePrivateFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/claude-signin-answers.ts::save::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/claude.ts::isolationSettingsFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/murage-exec.ts::installMurageExec::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/murage-exec.ts::writeExecEnvFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/native.ts::writeRecord::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::carryEntry::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::carryEntry::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::carryGeneration::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::migrateAsideLogins::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::quarantine::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::refreshAsideStamp::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::replaceGenerated::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::startGeneration::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::writeMarker::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/scoped-cli-home.ts::writeMarkerFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/shared-login-link.ts::linkSharedEntry::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/shared-login-link.ts::linkSync::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/shared-login-link.ts::renameSync::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/shared-login-link.ts::renameSync::renameSync::1": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/drivers/turn-credentials.ts::put::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves engine configuration, credentials or scoped engine workspace entries."
  },
  "server/email/caps-file.ts::writeCapsFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the email capability JSON record."
  },
  "server/email/restore-job-effects.ts::install::renameSync::0": {
    "kind": "installs-live-db",
    "drop": "server/email/restore-job-effects.ts::stage",
    "test": "P2"
  },
  "server/email/restore-job-effects.ts::stage::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Copies the archive into a private stage before the final installation rename."
  },
  "server/email/restore-job-effects.ts::stage::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Copies the archive into a private stage before the final installation rename."
  },
  "server/email/restore-job.ts::writeRecordAtomic::rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes a newly written operations JSON record with a new inode."
  },
  "server/email/send-service.ts::afterEventGap::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::afterEventGap::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::applyEvent::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::applyEvent::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::approve::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::approve::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::approve::move::2": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::approve::move::3": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::approve::move::4": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::decide::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::decide::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::dispatch::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::dontSend::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::fromEvents::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::landSend::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::landSend::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::ownerSend::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::ownerSend::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::reconcile::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::reconcile::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::reconcile::move::2": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::reconcile::move::3": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::rereadHold::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::rereadHold::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::retry::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::retry::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::retry::move::2": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::retry::move::3": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::retry::move::4": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::settle::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::uncertain::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::withdraw::move::0": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/email/send-service.ts::withdraw::move::1": {
    "kind": "not-live-db",
    "reason": "Transitions an email send state in SQLite; this move method does not move a file."
  },
  "server/folder-trust-seed.ts::writeFuigoSeed::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the folder trust seed record."
  },
  "server/fuigo-turn-logs.ts::copyRegular::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Copies a turn log into the diagnostic collection."
  },
  "server/harness/event-log.ts::replaceFile::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Replaces the harness event stream during compaction."
  },
  "server/harness/event-log.ts::rewriteStreamed::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Rewrites the harness event log stream."
  },
  "server/health/publisher.ts::append::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Publishes health JSON manifests and rotates health event segments."
  },
  "server/health/publisher.ts::replaceManifest::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Publishes health JSON manifests and rotates health event segments."
  },
  "server/health/stats-publisher.ts::publish::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Publishes the separate diagnostic statistics database."
  },
  "server/highlevel/approval-idempotency.ts::#publish::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes an immutable HighLevel approval idempotency record in its journal."
  },
  "server/highlevel/journal-file.ts::#compactIfLong::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Replaces the provider journal with compacted JSON lines."
  },
  "server/highlevel/opportunity-recovery-plan.ts::saveOpportunityPlan::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the HighLevel opportunity recovery plan beside its approval records."
  },
  "server/highlevel/private-token.ts::writeAtomic::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the private provider token record."
  },
  "server/highlevel/rpc-approval-replay.ts::bindRpc::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the HighLevel RPC approval binding in its replay journal."
  },
  "server/home-events.ts::compact::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Compacts the app event outbox with live entries, tombstones and floors."
  },
  "server/home-events.ts::firstStuckAt::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the legacy timestamp marker for a stuck restore incident."
  },
  "server/home-events.ts::noteRestoreStuck::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the timestamp and nonce marker for one durable restore alert incident."
  },
  "server/home-events.ts::spoolHomeEvent::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes an operations event spool record."
  },
  "server/hook-canon.ts::moveAside::rename::0": {
    "kind": "not-live-db",
    "reason": "Moves aside a checked engine hook file within its validated configuration root."
  },
  "server/hook-canon.ts::rename::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Renames checked engine hook files with path revalidation on each attempt."
  },
  "server/hook-canon.ts::repairFile::rename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the repaired hook file within its validated engine configuration root."
  },
  "server/hook-canon.ts::repairFile::rename::1": {
    "kind": "not-live-db",
    "reason": "Retries publication of the repaired hook after moving aside the checked previous file."
  },
  "server/hook-canon.ts::restoreOne::copyFile::0": {
    "kind": "not-live-db",
    "reason": "Clones a hook declaration object before applying its checked repair plan; this call copies no filesystem bytes."
  },
  "server/image-library.ts::storePackImage::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a reference pack image."
  },
  "server/imported-team.ts::tidyImportedTeams::rename::0": {
    "kind": "not-live-db",
    "reason": "Moves imported team directories during normalization."
  },
  "server/installation-app-schema-downgrade.ts::readJsonFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves a malformed application JSON record into quarantine."
  },
  "server/installation-archive.ts::writeInstallationStageArchive::publishNoReplace::0": {
    "kind": "not-live-db",
    "reason": "Publishes a ZIP archive outside the installation directory."
  },
  "server/installation-damaged-export.ts::writeInstallationDamagedExport::publishNoReplace::0": {
    "kind": "not-live-db",
    "reason": "Publishes a diagnostic archive outside the installation directory."
  },
  "server/installation-database-snapshot.ts::snapshotSqliteWhileOwned::publishNoReplace::0": {
    "kind": "installs-live-db",
    "drop": "server/installation-database-snapshot.ts::sanitizeStagedRestoreMarks",
    "test": "S5"
  },
  "server/installation-encrypted-backup.ts::execute::publishNoReplace::0": {
    "kind": "not-live-db",
    "reason": "Publishes encrypted backup ciphertext outside the installation directory."
  },
  "server/installation-encrypted-backup.ts::restoreEncryptedInstallationNew::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves encrypted archive or intermediate recovery staging files before installation preparation."
  },
  "server/installation-encrypted-backup.ts::writeEncryptedInstallationBackup::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves encrypted archive or intermediate recovery staging files before installation preparation."
  },
  "server/installation-memory-downgrade.ts::preservePhoneCallsForDowngrade::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Preserves phone-calls.db beside the installation before schema removal."
  },
  "server/installation-restore-preparation.ts::materializeOwnerEntries::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Materializes owner documents or moves quarantine and review-marker files in the prepared candidate."
  },
  "server/installation-restore-preparation.ts::materializeOwnerEntries::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Materializes owner documents or moves quarantine and review-marker files in the prepared candidate."
  },
  "server/installation-restore-preparation.ts::prepareInstallationRestore::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Materializes owner documents or moves quarantine and review-marker files in the prepared candidate."
  },
  "server/installation-restore-preparation.ts::quarantine::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Materializes owner documents or moves quarantine and review-marker files in the prepared candidate."
  },
  "server/installation-restore.ts::move::renameSync::0": {
    "kind": "generic"
  },
  "server/installation-restore.ts::publishJournal::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::restoreInstallation::move::0": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::restoreInstallation::move::1": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::restoreInstallation::move::2": {
    "kind": "installs-live-db",
    "drop": "server/installation-restore-preparation.ts::prepareInstallationRestore",
    "test": "S5p"
  },
  "server/installation-restore.ts::restoreInstallation::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::rollbackInstallationRestore::move::0": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::rollbackInstallationRestore::move::1": {
    "kind": "installs-live-db",
    "drop": "server/installation-restore.ts::dropUndoNotice",
    "test": "P5a"
  },
  "server/installation-restore.ts::rollbackInstallationRestore::move::2": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::rollbackInstallationRestore::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/installation-restore.ts::rollbackInstallationRestore::renameSync::1": {
    "kind": "not-live-db",
    "reason": "Moves a transaction receipt or candidate aside; this call does not install the live database."
  },
  "server/link-removal.ts::relink::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves link target entries while relinking owner paths."
  },
  "server/link-removal.ts::relink::renameSync::1": {
    "kind": "not-live-db",
    "reason": "Moves link target entries while relinking owner paths."
  },
  "server/link-removal.ts::rename::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves link target entries while relinking owner paths."
  },
  "server/mcp-grants.ts::save::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the MCP permission grants JSON record."
  },
  "server/mcp-listed.ts::writeCatalogDocument::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the MCP catalogue JSON document beside its checked temporary file."
  },
  "server/memory/index-quarantine.ts::quarantineIndex::rename::0": {
    "kind": "not-live-db",
    "reason": "Moves the derived memory index into quarantine."
  },
  "server/memory/index-quarantine.ts::quarantineIndex::rename::1": {
    "kind": "not-live-db",
    "reason": "Moves the derived memory index into quarantine."
  },
  "server/memory/keepall-unwedge.ts::markUnwedged::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the memory repair receipt."
  },
  "server/memory/lessons-local.ts::createLearningLocalLessonSink::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a local lesson record."
  },
  "server/memory/model-adoption.ts::writeMarker::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the model adoption marker."
  },
  "server/memory/pip-transport.ts::bindReflectionRoute::copyFileSync::0": {
    "kind": "not-live-db",
    "reason": "Copies reflection transport configuration."
  },
  "server/memory/schema.ts::renameWithRetry::renameSync::0": {
    "kind": "generic"
  },
  "server/memory/schema.ts::snapshotBeforeMigration::renameWithRetry::0": {
    "kind": "not-live-db",
    "reason": "Preserves a migration snapshot outside the live database."
  },
  "server/memory/settings.ts::downloadModel::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a downloaded memory model file."
  },
  "server/memory/upgrade-overall.ts::overallWriter::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the memory upgrade progress record."
  },
  "server/memory/upgrade-status.ts::blocking::move::0": {
    "kind": "not-live-db",
    "reason": "Publishes the memory upgrade progress record."
  },
  "server/memory/upgrade-status.ts::step::move::0": {
    "kind": "not-live-db",
    "reason": "Publishes the memory upgrade progress record."
  },
  "server/memory/upgrade-status.ts::writeNote::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the memory upgrade progress record."
  },
  "server/message-db.ts::importLegacy::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Renames the imported legacy message JSON file after import."
  },
  "server/output-publication.ts::retainImageOutput::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a retained image output file."
  },
  "server/package-import-transaction.ts::replace::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves bot package staging and imported owner documents."
  },
  "server/pending-delegations-schema.ts::importLegacyDelegations::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Renames the legacy delegation JSON after import."
  },
  "server/procedure-bundles.ts::createProcedurePin::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a procedure revision pin file."
  },
  "server/project-migration.ts::snapshotProjectRows::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the project rows JSON snapshot."
  },
  "server/publish-file.ts::publishNoReplace::linkSync::0": {
    "kind": "generic"
  },
  "server/publish-file.ts::publishNoReplace::renameSync::0": {
    "kind": "generic"
  },
  "server/sentinel/paths.ts::writeDescriptor::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/sentinel/publication.ts::publishView::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/sentinel/scan-fixtures.ts::rotate::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/sentinel/scan-fixtures.ts::writeBackup::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/sentinel/scan-fixtures.ts::writeStats::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/sentinel/scan.ts::recordScanFailure::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes diagnostic descriptors, scan records or test fixture statistics."
  },
  "server/settle-copy.ts::settleFtsCopy::renameSync::0": {
    "kind": "installs-live-db",
    "drop": "server/installation-database-snapshot.ts::sanitizeStagedRestoreMarks",
    "test": "S5"
  },
  "server/skill-collection.ts::importCollectionSkill::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skill-collection.ts::importCollectionSkill::renameSync::1": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skill-collection.ts::writeRecords::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skill-search.ts::buildIndexFile::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skills.ts::commitNewSkillFiles::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skills.ts::publishReviewedRevision::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skills.ts::publishReviewedRevision::renameSync::1": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/skills.ts::publishReviewedRevision::renameSync::2": {
    "kind": "not-live-db",
    "reason": "Moves reviewed skill revisions, collection records or the derived skill search index."
  },
  "server/stop-line-state.ts::rememberRecipients::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the notification recipient record."
  },
  "server/team-library.ts::writeCachedCatalog::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes the cached team catalog."
  },
  "server/voice/voice-notes.ts::createVoiceNote::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes a voice note audio file."
  },
  "server/workspace-files.ts::writeWorkspaceMarkdown::linkSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes or renames an owner workspace document."
  },
  "server/workspace-files.ts::writeWorkspaceMarkdown::renameSync::0": {
    "kind": "not-live-db",
    "reason": "Publishes or renames an owner workspace document."
  },
  "server/workspace.ts::checkedRename::renameSync::0": {
    "kind": "generic"
  },
  "server/workspace.ts::checkedRename::renameWithRetry::0": {
    "kind": "generic"
  },
  "server/workspace.ts::saveMemoryFile::checkedRename::0": {
    "kind": "not-live-db",
    "reason": "Publishes the owner memory Markdown document in a bot workspace."
  },
  "server/workspace.ts::saveMemoryFile::checkedRename::1": {
    "kind": "not-live-db",
    "reason": "Publishes the owner memory Markdown document in a bot workspace."
  }
};
