# agent-browser 0.36.0: alert and beforeunload dialogs are never accepted on Windows

## Summary
On Windows the daemon's auto-dismiss task for `alert` and `beforeunload` dialogs never sends
`Page.handleJavaScriptDialog`. The page stays blocked until the client times out.

## Cause
- `cli/src/connection.rs:889-918` (Windows branch of `ensure_daemon`) starts the daemon with
  `.stderr(Stdio::piped())`. The CLI holds the read end in `daemon_child` and drops it as soon as
  `ensure_daemon` returns, so the daemon's stderr is a broken pipe from then on.
- `cli/src/native/daemon.rs:35-61` redirects stderr to a log file or `/dev/null`, but only under
  `#[cfg(unix)]`. Windows keeps the broken pipe. `main.rs` also ignores SIGPIPE only on Unix.
- `cli/src/native/actions.rs:908` (`start_dialog_handler`) calls
  `eprintln!("[auto-dismiss] {} dialog: {}", ...)` BEFORE sending `Page.handleJavaScriptDialog`.
  On Windows `eprintln!` panics on a write to a broken pipe (std ignores only
  `ERROR_INVALID_HANDLE`), the spawned task ends, and the dialog is never answered.

## Reproduce (Windows)
1. `agent-browser open <page that calls alert() on click>`; `agent-browser click <button>`.
2. The click does not return until its timeout; `agent-browser dialog status` shows nothing for
   the alert because it is treated as auto-handled (`actions.rs:1880-1889`).

## Suggested fix
- Mirror the Unix handling on Windows in `run_daemon`: when not debugging, `SetStdHandle(STD_ERROR_HANDLE)`
  to `NUL` (or a log file when `AGENT_BROWSER_DEBUG` is set).
- Independently, use `let _ = writeln!(std::io::stderr(), ...)` instead of `eprintln!` in background
  tasks so a failed log write can never stop the dialog answer.

## Workaround
Set `AGENT_BROWSER_NO_AUTO_DIALOG=1` and answer with `dialog status` / `dialog accept`.
