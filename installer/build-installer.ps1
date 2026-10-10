# MdReader 설치 파일 만들기
#   1) .NET 런타임 없이도 돌아가도록 self-contained 로 publish
#   2) Inno Setup(ISCC)으로 dist\MdReader-Setup-<버전>.exe 생성
# 사용법:  powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 [-Version 0.2.0]
param([string]$Version = "0.2.0")
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "publish\installer"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }

dotnet publish (Join-Path $root "src\MdReader\MdReader.csproj") `
  -c Release -r win-x64 --self-contained true `
  -p:Version=$Version -p:DebugType=none `
  -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish 실패" }

$iscc = $null
$cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
if ($cmd) { $iscc = $cmd.Source }
foreach ($p in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
                 "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
                 "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe")) {
  if (-not $iscc -and (Test-Path $p)) { $iscc = $p }
}
if (-not $iscc) { throw "Inno Setup 6이 필요합니다: https://jrsoftware.org/isdl.php (또는 winget install JRSoftware.InnoSetup)" }

& $iscc "/DAppVersion=$Version" "/DSourceDir=$out" (Join-Path $PSScriptRoot "MdReader.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC 실패" }
Write-Host "완료: $(Join-Path $root "dist\MdReader-Setup-$Version.exe")"
