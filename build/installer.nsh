; Electron applications may leave renderer/GPU helper processes behind while an
; NSIS upgrade is replacing files. Match only the installed gpt-plus.exe.
!include "getProcessInfo.nsh"
Var pid

; Older app versions launch updates without /S. Switch only update installs to
; silent mode so this upgrade also finishes without wizard clicks.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endIf}
!macroend

!macro GPTPLUS_FIND_APP _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Name -ieq '${APP_EXECUTABLE_FILENAME}' -and $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${_RETURN}
  ${endIf}
!macroend

!macro GPTPLUS_KILL_PROCESS_TREE
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | ? {$$_.Name -ieq '${APP_EXECUTABLE_FILENAME}' -and $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { & taskkill.exe /PID $$_.ProcessId /T /F | Out-Null }"`
  ${else}
    nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F /FI "USERNAME eq %USERNAME%"`
  ${endIf}
  Pop $0
!macroend

!macro GPTPLUS_REQUEST_EXIT
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit' $R0
    Sleep 700
  ${endIf}
!macroend

; Uninstalling the old version removes $INSTDIR, so the installer must be able to
; recreate it inside the parent directory afterwards. When the parent is read-only
; for the current user the old app is deleted and nothing can be written back, which
; leaves the product uninstalled but still registered. Probe both paths first.
; Non-ASCII text is avoided here: NSIS reads includes in the system codepage.
!macro GPTPLUS_ENSURE_INSTALL_WRITABLE _RETURN
  Push $R7
  Push $R8
  StrCpy ${_RETURN} 0
  ${if} ${FileExists} "$INSTDIR\*.*"
    ClearErrors
    FileOpen $R7 "$INSTDIR\gptplus-install-probe.tmp" "w"
    ${ifNot} ${Errors}
      FileClose $R7
      Delete "$INSTDIR\gptplus-install-probe.tmp"
      ClearErrors
      FileOpen $R7 "$INSTDIR\..\gptplus-install-probe.tmp" "w"
      ${ifNot} ${Errors}
        FileClose $R7
        Delete "$INSTDIR\..\gptplus-install-probe.tmp"
        StrCpy ${_RETURN} 1
      ${endIf}
    ${endIf}
  ${else}
    ClearErrors
    CreateDirectory "$INSTDIR"
    ${if} ${FileExists} "$INSTDIR\*.*"
      StrCpy ${_RETURN} 1
    ${endIf}
  ${endIf}
  Pop $R8
  Pop $R7
!macroend

; NSIS upgrades keep an existing shortcut when its target still exists. Rewrite
; both shortcuts so an older external .ico path cannot survive an upgrade.
!macro customInstall
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "${PRODUCT_NAME}"
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL "" "${PRODUCT_NAME}"
  ${endIf}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro GPTPLUS_FIND_APP $R0
    ${if} $R0 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:
      DetailPrint "$(appClosing)"
      !insertmacro GPTPLUS_REQUEST_EXIT
      !insertmacro GPTPLUS_KILL_PROCESS_TREE
      Sleep 500

      StrCpy $R1 0
      loop:
        IntOp $R1 $R1 + 1
        !insertmacro GPTPLUS_FIND_APP $R0
        ${if} $R0 == 0
          Sleep 1000
          !insertmacro GPTPLUS_KILL_PROCESS_TREE
          !insertmacro GPTPLUS_FIND_APP $R0
          ${if} $R0 == 0
            ${if} $R1 > 1
              MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
              Quit
            ${else}
              Goto loop
            ${endIf}
          ${endIf}
        ${endIf}
    ${endIf}
  ${endIf}

  !insertmacro GPTPLUS_ENSURE_INSTALL_WRITABLE $R6
  ${if} $R6 != 1
    MessageBox MB_OK|MB_ICONSTOP "gpt++ cannot be installed into:$\r$\n$INSTDIR$\r$\n$\r$\nThis folder, or the folder above it, is read-only for the current user, so the installer cannot recreate it after removing the old version. Setup was aborted and the existing installation was left untouched. Run the installer as administrator, or choose a folder you can write to." /SD IDOK
    Quit
  ${endIf}
!macroend
