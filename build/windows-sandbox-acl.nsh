; Chromium's Windows LPAC processes must be able to read/execute installed
; application code even when the parent DACL carries package-specific SIDs.
; Only the package code tree is granted RX. Keep all prior ACEs and owners;
; never reset a user profile/ancestor ACL or grant write/control privileges.
!include "windows-upgrade-staging.nsh"
!macro customInstall
  !insertmacro murageRestoreUpgradeEnvironment
  Push $0
  Push $1
  DetailPrint "Preparing sandboxed application runtime permissions..."
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /T /L /Q'
  Pop $0
  Pop $1
  StrCmp $0 "0" murage_lpac_ready
  DetailPrint "Could not prepare sandboxed application runtime permissions."
  IfSilent murage_lpac_no_dialog
  MessageBox MB_OK|MB_ICONSTOP "Murage could not prepare its application folder permissions. Close Murage and run this installer again. Your workspace and account settings were not changed."
  murage_lpac_no_dialog:
  Pop $1
  Pop $0
  SetErrorLevel 2
  Abort "Unable to prepare Murage application folder permissions."
  murage_lpac_ready:
  Pop $1
  Pop $0
!macroend
