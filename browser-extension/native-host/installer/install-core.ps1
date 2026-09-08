# EO2Weave Native Host - core installer logic (parameterized).
# Invoked by launch.ps1 inside the self-extracting package, or standalone:
#   powershell -ExecutionPolicy Bypass -File install-core.ps1 -SourceDir <dir with exe>
#
# Steps (STATUS.md 8.2 (9)):
#   1. Copy cw-native-host.exe to %LOCALAPPDATA%\EO2Weave\NativeMessagingHosts
#   2. Write the Chrome NM manifest JSON next to it
#   3. Register HKCU\Software\Google\Chrome\NativeMessagingHosts (no admin)
#   4. Also register Edge when present

# Extension IDs allowed to talk to the native host:
#   kdnnh... : unpacked/dev loads (extension manifest pins a stable public key)
#   canpc... : Chrome Web Store listing (the store generates its own ID because
#              it rejects the pinned `key` field, see wxt.config.ts)
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,
    [string]$ExtensionId = "kdnnhmagmghdhfinoipgbcddnpmffbkp"
)

$CwsExtensionId = "canpcddlognjbengiodekfbbfnjafeml"

$ErrorActionPreference = "Stop"

$HostName = "com.creatorweave.nativehost"
$Exe = Join-Path $SourceDir "cw-native-host.exe"
if (-not (Test-Path $Exe)) {
    Write-Host "Error: cw-native-host.exe not found in $SourceDir" -ForegroundColor Red
    exit 1
}

# -- 1. Copy binary to a stable install dir (survives temp cleanup) --------
$InstallDir = Join-Path $env:LOCALAPPDATA "EO2Weave\NativeMessagingHosts"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstalledExe = Join-Path $InstallDir "cw-native-host.exe"
Copy-Item $Exe $InstalledExe -Force
Write-Host "Installed binary: $InstalledExe"

# -- 2. Chrome NM manifest -------------------------------------------------
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = @{
    name = $HostName
    description = "EO2Weave Native Host - disk file I/O"
    path = $InstalledExe
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://$ExtensionId/",
        "chrome-extension://$CwsExtensionId/"
    )
} | ConvertTo-Json -Depth 3
Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8
Write-Host "Manifest: $ManifestPath"

# -- 3. Chrome registration (HKCU) -----------------------------------------
$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $ChromeKey -Force | Out-Null
Set-ItemProperty -Path $ChromeKey -Name "(default)" -Value $ManifestPath
Write-Host "Registered: $ChromeKey"

# -- 4. Edge registration (best effort) -------------------------------------
$EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
try {
    New-Item -Path $EdgeKey -Force | Out-Null
    Set-ItemProperty -Path $EdgeKey -Name "(default)" -Value $ManifestPath
    Write-Host "Registered: $EdgeKey"
} catch {
    Write-Host "Skipped Edge: $_" -ForegroundColor Yellow
}

# -- Uninstall entry (Add/Remove Programs, per-user) ------------------------
$UninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$HostName"
New-Item -Path $UninstKey -Force | Out-Null
Set-ItemProperty -Path $UninstKey -Name "DisplayName" -Value "EO2Weave Native Host"
Set-ItemProperty -Path $UninstKey -Name "DisplayVersion" -Value "1.2.0"
Set-ItemProperty -Path $UninstKey -Name "Publisher" -Value "EO2Weave"
Set-ItemProperty -Path $UninstKey -Name "InstallLocation" -Value $InstallDir
Set-ItemProperty -Path $UninstKey -Name "UninstallString" -Value "powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
Set-ItemProperty -Path $UninstKey -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $UninstKey -Name "NoRepair" -Value 1 -Type DWord

# -- Drop the uninstaller next to the binary --------------------------------
$uninstaller = @'
# EO2Weave Native Host uninstaller (created by install-core.ps1)
$ErrorActionPreference = "Continue"
$HostName = "com.creatorweave.nativehost"
$InstallDir = Join-Path $env:LOCALAPPDATA "EO2Weave\NativeMessagingHosts"

foreach ($Key in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$HostName"
)) {
    if (Test-Path $Key) { Remove-Item $Key -Recurse -Force; Write-Host "Removed: $Key" }
}
if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force; Write-Host "Removed: $InstallDir"
}
Write-Host "Done. Restart Chrome to complete removal."
'@
Set-Content -Path (Join-Path $InstallDir "uninstall.ps1") -Value $uninstaller -Encoding UTF8

Write-Host ""
Write-Host "Install complete. Fully restart Chrome (quit from the tray) to activate." -ForegroundColor Green
Write-Host "Verify at chrome://native-internals - com.creatorweave.nativehost should be listed."
exit 0
