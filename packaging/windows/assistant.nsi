; -*- coding: utf-8 -*-
; Generated file lists contain only program files. Product data is never removed.
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ManifestDPIAware true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "小助手 ${APP_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\XiaoZhuShou"
InstallDirRegKey HKCU "Software\XiaoZhuShou\Installer" "InstallDirectory"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "小助手"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "FileDescription" "小助手 Windows 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "小助手项目"
BrandingText "小助手 · DSH 个人工作空间"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "把小助手放到你的电脑上"
!define MUI_WELCOMEPAGE_TEXT "安装任务、微信、邮箱与能力中心工作台。小助手始终由 DSH 提供核心能力，请先安装并登录 DSH。$\r$\n$\r$\n仅安装到当前 Windows 用户，不需要管理员权限。已有账号和记录保留在原个人数据目录。$\r$\n$\r$\n升级前请从托盘正常退出旧版小助手；安装程序不会强制结束任务。"
!define MUI_FINISHPAGE_TITLE "小助手已安装"
!define MUI_FINISHPAGE_TEXT "可以从桌面或开始菜单打开小助手。DSH 继续使用原登录。$\r$\n$\r$\n关闭工作台后小助手留在托盘；卸载只移除程序，保留个人数据、DSH 和微信。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\小助手.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_RUN_TEXT "打开小助手"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var Isolated
Var Parameters
Var ExistingOwner

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    SetErrorLevel 1633
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 Windows x64。" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\XiaoZhuShouInstaller") p .r0 ?e'
  Pop $1
  ${If} $1 = 183
    SetErrorLevel 1618
    MessageBox MB_OK|MB_ICONINFORMATION "另一个小助手安装程序正在运行，请等它完成。" /SD IDOK
    Abort
  ${EndIf}
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/ISOLATED" $0
  ${IfNot} ${Errors}
    StrCpy $Isolated "1"
  ${EndIf}
FunctionEnd

!macro RefuseRunning PREFIX
  IfFileExists "$INSTDIR\小助手.exe" 0 ${PREFIX}not_running
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\小助手.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 P= -1
    SetErrorLevel 32
    MessageBox MB_OK|MB_ICONINFORMATION "小助手仍在运行，或程序文件暂时被占用。请从系统托盘正常退出小助手后再试；当前任务和数据没有被更改。" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  ${PREFIX}not_running:
!macroend

Function CheckInstallDirectory
  ; NSIS GetFullPathName requires existing directories. The Win32 resolver
  ; also accepts a not-yet-created custom installation directory.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i .r1'
  ${If} $1 = 0
    SetErrorLevel 87
    Abort "安装目录无效。"
  ${EndIf}
  StrCpy $INSTDIR $0
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
    SetErrorLevel 87
    Abort "请选择专门用于小助手的文件夹。"
  ${EndIf}
  ; Do not traverse directory links or overwrite an unrelated existing folder.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    ${If} $1 != 0
      SetErrorLevel 87
      Abort "安装目录不能是链接或重定向目录。"
    ${EndIf}
    ReadINIStr $ExistingOwner "$INSTDIR\.xiaozhushou-install.ini" "Product" "Id"
    ${If} $ExistingOwner != "local.xiaozhushou.desktop"
      FindFirst $0 $1 "$INSTDIR\*.*"
      loop_directory:
        ${If} $1 == ""
          FindClose $0
          Goto directory_checked
        ${EndIf}
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          FindClose $0
          SetErrorLevel 87
          Abort "该文件夹包含其他文件。请选择空文件夹或原小助手安装目录。"
        ${EndIf}
        FindNext $0 $1
        Goto loop_directory
    ${EndIf}
  ${EndIf}
  directory_checked:
  !insertmacro RefuseRunning "install_"
FunctionEnd

Section "安装小助手" Main
  Call CheckInstallDirectory
  SetOverwrite on
  !include "install-files.nsh"
  WriteINIStr "$INSTDIR\.xiaozhushou-install.ini" "Product" "Id" "local.xiaozhushou.desktop"
  WriteINIStr "$INSTDIR\.xiaozhushou-install.ini" "Product" "Version" "${APP_VERSION}"
  WriteINIStr "$INSTDIR\.xiaozhushou-install.ini" "Product" "Isolated" "$Isolated"
  WriteUninstaller "$INSTDIR\卸载小助手.exe"
  SetOutPath "$INSTDIR"
  ${If} $Isolated != "1"
    CreateDirectory "$SMPROGRAMS\小助手"
    CreateShortCut "$SMPROGRAMS\小助手\小助手.lnk" "$INSTDIR\小助手.exe" "" "$INSTDIR\小助手.exe" 0
    CreateShortCut "$SMPROGRAMS\小助手\卸载小助手.lnk" "$INSTDIR\卸载小助手.exe"
    CreateShortCut "$DESKTOP\小助手.lnk" "$INSTDIR\小助手.exe" "" "$INSTDIR\小助手.exe" 0
    WriteRegStr HKCU "Software\XiaoZhuShou\Installer" "InstallDirectory" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "DisplayName" "小助手"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "Publisher" "小助手项目"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "DisplayIcon" "$INSTDIR\小助手.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "UninstallString" '$\"$INSTDIR\卸载小助手.exe$\"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "QuietUninstallString" '$\"$INSTDIR\卸载小助手.exe$\" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "NoRepair" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou" "EstimatedSize" ${APP_SIZE_KIB}
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  ReadINIStr $ExistingOwner "$INSTDIR\.xiaozhushou-install.ini" "Product" "Id"
  ${If} $ExistingOwner != "local.xiaozhushou.desktop"
    SetErrorLevel 87
    Abort "无法核验小助手安装目录，没有删除任何文件。"
  ${EndIf}
  ReadINIStr $Isolated "$INSTDIR\.xiaozhushou-install.ini" "Product" "Isolated"
  !insertmacro RefuseRunning "uninstall_"
FunctionEnd

Section "Uninstall"
  ; Explicit generated file list: never recursively remove install or data dirs.
  !include "uninstall-files.nsh"
  Delete "$INSTDIR\.xiaozhushou-install.ini"
  Delete "$INSTDIR\卸载小助手.exe"
  ${If} $Isolated != "1"
    ReadRegStr $0 HKCU "Software\XiaoZhuShou\Installer" "InstallDirectory"
    ${If} $0 == $INSTDIR
      Delete "$DESKTOP\小助手.lnk"
      Delete "$SMPROGRAMS\小助手\小助手.lnk"
      Delete "$SMPROGRAMS\小助手\卸载小助手.lnk"
      RMDir "$SMPROGRAMS\小助手"
      DeleteRegKey HKCU "Software\XiaoZhuShou\Installer"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\XiaoZhuShou"
    ${EndIf}
  ${EndIf}
  RMDir "$INSTDIR"
SectionEnd
