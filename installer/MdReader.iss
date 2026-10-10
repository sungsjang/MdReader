; MdReader 설치 프로그램 (Inno Setup 6)
; 빌드: installer\build-installer.ps1  (dotnet publish → ISCC)
; 관리자 권한 없이 현재 사용자에게 설치하고, .md 연결 프로그램을 등록한다.

#define AppName "MdReader"
#ifndef AppVersion
  #define AppVersion "0.3.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\publish\installer"
#endif

[Setup]
AppId={{8F6C1E52-3B7A-4C1D-9E7A-6D2B5C4A9F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MdReader
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=MdReader-Setup-{#AppVersion}
SetupIconFile=..\src\MdReader\app.ico
UninstallDisplayIcon={app}\MdReader.exe
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
CloseApplications=yes
RestartApplications=no

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#endif
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
AssocTask=.md 파일을 MdReader로 열 수 있게 등록 (연결 프로그램)
AssocGroup=파일 연결:
english.AssocTask=Register MdReader for .md files (Open with)
english.AssocGroup=File association:

[Tasks]
Name: "assoc"; Description: "{cm:AssocTask}"; GroupDescription: "{cm:AssocGroup}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\MdReader.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\MdReader.exe"; Tasks: desktopicon

[Registry]
; ProgId
Root: HKA; Subkey: "Software\Classes\MdReader.Markdown"; ValueType: string; ValueName: ""; ValueData: "Markdown 문서"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MdReader.Markdown"; ValueType: string; ValueName: "FriendlyTypeName"; ValueData: "Markdown 문서"; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MdReader.Markdown\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\MdReader.exe"",0"; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\MdReader.Markdown\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\MdReader.exe"" ""%1"""; Tasks: assoc
; 확장자 → 연결 프로그램 목록
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "MdReader.Markdown"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "MdReader.Markdown"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.mdown\OpenWithProgids"; ValueType: string; ValueName: "MdReader.Markdown"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
; 앱 등록 (Windows '다른 앱 선택' 목록에 표시)
Root: HKA; Subkey: "Software\Classes\Applications\MdReader.exe"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "MdReader"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\MdReader.exe\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\MdReader.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Applications\MdReader.exe\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\MdReader.exe\SupportedTypes"; ValueType: string; ValueName: ".markdown"; ValueData: ""

[Run]
Filename: "{app}\MdReader.exe"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Key = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(): Boolean;
var
  V: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not HasWebView2() then
    MsgBox('Microsoft Edge WebView2 런타임이 설치되어 있지 않은 것 같습니다.' + #13#10 +
           'MdReader가 실행되지 않으면 아래 주소에서 "Evergreen Bootstrapper"를 설치하세요.' + #13#10#13#10 +
           'https://developer.microsoft.com/microsoft-edge/webview2/',
           mbInformation, MB_OK);
end;
