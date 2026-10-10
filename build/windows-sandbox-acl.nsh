; Chromium's Windows LPAC processes must be able to read/execute installed
; application code even when the parent DACL carries package-specific SIDs.
; Only the package code tree is granted RX. Keep all prior ACEs and owners;
; never reset a user profile/ancestor ACL or grant write/control privileges.
;
; The grant is set once on $INSTDIR as an inheritable (OI)(CI) entry and
; Windows passes it down to every file and folder inside. Re-granting each of
; the ~126,000 entries with /T made the step outlast its time limit on a busy
; machine, which stopped the whole install. A grant that still cannot be set
; is logged and the install finishes: only the bundled browser's sandbox
; depends on it, and the app reports that case on its own.
!include "windows-upgrade-staging.nsh"
!macro customInstall
  !insertmacro murageRestoreUpgradeEnvironment
  Push $0
  Push $1
  DetailPrint "Preparing sandboxed application runtime permissions..."
  nsExec::ExecToStack /TIMEOUT=600000 '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /C /Q'
  Pop $0
  Pop $1
  StrCmp $0 "0" murage_lpac_ready
  DetailPrint "Retrying sandboxed application runtime permissions..."
  nsExec::ExecToStack /TIMEOUT=600000 '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /C /Q'
  Pop $0
  Pop $1
  StrCmp $0 "0" murage_lpac_ready
  DetailPrint "Sandboxed application runtime permissions were not set ($0). Murage will finish installing."
  murage_lpac_ready:
  Pop $1
  Pop $0
!macroend
