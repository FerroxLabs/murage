; Murage always installs for the current user. The assisted installer (needed
; for the license page) would otherwise ask "anyone who uses this computer, or
; only me?"; this tells electron-builder's install-mode page the answer, so it
; is skipped. Murage has never offered a per-machine install.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
