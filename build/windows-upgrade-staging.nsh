; Legacy uninstallers atomically move files into TEMP\ns*.tmp\old-install.
; That prefix can push a valid installed path past their MAX_PATH limit.
; Redirect only this installer's inherited child environment. NSIS keeps its
; own plugin directory and creates/cleans the legacy child's private directory.
!ifndef BUILD_UNINSTALLER
Var murageSavedTemp
Var murageSavedTmp
Var murageStageRoot
Var murageTempRedirected
Var murageRestoreFailed

Function MurageRestoreStagingEnvironment
  Push $0
  StrCpy $murageRestoreFailed "0"
  StrCmp $murageTempRedirected "1" 0 murage_restore_done
  StrCmp $murageSavedTemp "" 0 murage_restore_temp_value
    System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", p 0) i .r0'
    Goto murage_restore_temp_check
  murage_restore_temp_value:
    System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$murageSavedTemp") i .r0'
  murage_restore_temp_check:
    StrCmp $0 "0" 0 +2
      StrCpy $murageRestoreFailed "1"
  StrCmp $murageSavedTmp "" 0 murage_restore_tmp_value
    System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", p 0) i .r0'
    Goto murage_restore_tmp_check
  murage_restore_tmp_value:
    System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$murageSavedTmp") i .r0'
  murage_restore_tmp_check:
    StrCmp $0 "0" 0 +2
      StrCpy $murageRestoreFailed "1"
  StrCmp $murageRestoreFailed "0" 0 murage_restore_done
    StrCpy $murageTempRedirected "0"
  murage_restore_done:
  Pop $0
FunctionEnd

!macro customInit
  Push $0
  Push $1
  Push $2
  StrCpy $murageTempRedirected "0"
  ; A fresh installation has no legacy uninstaller to stage.
  IfFileExists "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" 0 murage_stage_done
  ReadEnvStr $murageSavedTemp "TEMP"
  ReadEnvStr $murageSavedTmp "TMP"
  GetFullPathName /SHORT $murageStageRoot "$PROFILE"
  StrCmp $murageStageRoot "" murage_stage_fail
  ; The legacy NSIS suffix is \nsXXXX.tmp\old-install\ (25 characters).
  ; Never admit a staging prefix longer than the existing installed prefix.
  StrLen $0 $murageStageRoot
  IntOp $0 $0 + 25
  StrLen $1 $INSTDIR
  IntOp $1 $1 + 1
  IntCmp $0 $1 murage_stage_probe murage_stage_probe murage_stage_fail
  murage_stage_probe:
  ClearErrors
  GetTempFileName $2 "$murageStageRoot"
  IfErrors murage_stage_fail
  Delete "$2"
  IfErrors murage_stage_fail
  StrCpy $murageTempRedirected "1"
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$murageStageRoot") i .r0'
  StrCmp $0 "0" murage_stage_fail
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$murageStageRoot") i .r0'
  StrCmp $0 "0" murage_stage_fail murage_stage_done
  murage_stage_fail:
  Call MurageRestoreStagingEnvironment
  Pop $2
  Pop $1
  Pop $0
  SetErrorLevel 2
  Abort "Murage cannot safely stage this upgrade. The existing installation and workspace were not removed."
  murage_stage_done:
  Pop $2
  Pop $1
  Pop $0
!macroend
!endif

!macro murageRestoreUpgradeEnvironment
  !ifndef BUILD_UNINSTALLER
    Call MurageRestoreStagingEnvironment
    StrCmp $murageRestoreFailed "0" murage_environment_restored
    SetErrorLevel 2
    Abort "Murage could not restore the installer environment. Close this installer before launching Murage."
    murage_environment_restored:
  !endif
!macroend
