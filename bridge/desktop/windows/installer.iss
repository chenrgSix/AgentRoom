#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef BundleVersion
  #error BundleVersion is required
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef OutputBaseFilename
  #error OutputBaseFilename is required
#endif
#ifndef IconFile
  #error IconFile is required
#endif

[Setup]
AppId={{2FA4C87B-E4E4-4929-B229-8F2B13DB1EF6}
AppName=ConveneWire Bridge
AppVersion={#AppVersion}
AppVerName=ConveneWire Bridge {#AppVersion}
AppPublisher=ConveneWire
AppPublisherURL=https://github.com/chenrgSix/ConveneWire
AppSupportURL=https://github.com/chenrgSix/ConveneWire/issues
AppUpdatesURL=https://github.com/chenrgSix/ConveneWire/releases
DefaultDirName={localappdata}\Programs\ConveneWire Bridge
DefaultGroupName=ConveneWire Bridge
DisableDirPage=auto
DisableProgramGroupPage=yes
AllowNoIcons=no
AlwaysUsePersonalGroup=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
CloseApplicationsFilter=ConveneWire Bridge.exe,AgentRoom Bridge.exe
RestartApplications=no
Uninstallable=yes
UninstallDisplayName=ConveneWire Bridge
UninstallDisplayIcon={app}\ConveneWire Bridge.exe
UsePreviousAppDir=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#IconFile}
SetupLogging=yes
VersionInfoVersion={#BundleVersion}
VersionInfoProductVersion={#BundleVersion}
VersionInfoProductTextVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductName=ConveneWire Bridge
VersionInfoCompany=ConveneWire
VersionInfoDescription=ConveneWire Bridge per-user installer
LicenseFile={#SourceDir}\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\ConveneWire Bridge.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\NOTICE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\COMMERCIAL-LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\TRADEMARKS.md"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
Type: files; Name: "{app}\AgentRoom Bridge.exe"

[Icons]
Name: "{group}\ConveneWire Bridge"; Filename: "{app}\ConveneWire Bridge.exe"; WorkingDir: "{app}"; IconFilename: "{app}\ConveneWire Bridge.exe"; IconIndex: 0
Name: "{autodesktop}\ConveneWire Bridge"; Filename: "{app}\ConveneWire Bridge.exe"; WorkingDir: "{app}"; IconFilename: "{app}\ConveneWire Bridge.exe"; IconIndex: 0; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\convenewire"; ValueType: string; ValueName: ""; ValueData: "URL:ConveneWire Device Pairing"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\convenewire"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\convenewire\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\ConveneWire Bridge.exe,0"
Root: HKCU; Subkey: "Software\Classes\convenewire\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\ConveneWire Bridge.exe"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\agentroom"; ValueType: string; ValueName: ""; ValueData: "URL:ConveneWire Device Pairing (legacy scheme)"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\agentroom"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\agentroom\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\ConveneWire Bridge.exe,0"
Root: HKCU; Subkey: "Software\Classes\agentroom\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\ConveneWire Bridge.exe"" ""%1"""

[Run]
Filename: "{app}\ConveneWire Bridge.exe"; Description: "{cm:LaunchBridge}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent; Check: WebView2RuntimeInstalled
Filename: "https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section"; Description: "{cm:DownloadWebView2}"; Flags: shellexec postinstall skipifsilent unchecked; Check: not WebView2RuntimeInstalled

[CustomMessages]
english.LaunchBridge=Launch ConveneWire Bridge
english.DownloadWebView2=Open the official Microsoft WebView2 Runtime download page
english.WebView2Missing=Microsoft Edge WebView2 Runtime was not detected. ConveneWire Bridge can still be installed, but it needs WebView2 before first launch. The final page can open Microsoft's official download page.

[Code]
const
  WebView2ClientKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function RuntimeVersionPresent(const RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebView2ClientKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2RuntimeInstalled: Boolean;
begin
  Result := RuntimeVersionPresent(HKLM32) or RuntimeVersionPresent(HKCU);
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if not WebView2RuntimeInstalled then
    MsgBox(ExpandConstant('{cm:WebView2Missing}'), mbInformation, MB_OK);
end;
