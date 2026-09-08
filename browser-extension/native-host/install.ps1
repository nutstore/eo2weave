# Install script for CreatorWeave Native Host (Windows)
# Registers the Chrome Native Messaging host manifest + HKCU registry key.
# STATUS.md §8.2 (9). HKCU only — no admin rights required.
#
# Usage (from any directory):
#   .\install.ps1                      # auto-detect the exe (see below)
#   .\install.ps1 -BinaryPath C:\path\to\cw-native-host.exe
#
# Auto-detection order:
#   1. -BinaryPath parameter
#   2. <script dir>\cw-native-host.exe          (exe copied next to script)
#   3. <script dir>\target\release\cw-native-host.exe               (native build)
#   4. <script dir>\target\x86_64-pc-windows-gnu\release\...exe     (cross build)
#
# The exe is COPIED to %LOCALAPPDATA%\CreatorWeave\NativeMessagingHosts\ and
# the manifest points there — so `cargo clean` / rebuilding never breaks the
# registration silently.

param(
    [string]$BinaryPath = ""
)

$ErrorActionPreference = "Stop"

# Extension IDs allowed to talk to the native host:
#   kdnnh... : unpacked/dev loads (extension manifest pins a stable public key)
#   canpc... : Chrome Web Store listing (store-generated ID — see wxt.config.ts)
$ExtensionId = "kdnnhmagmghdhfinoipgbcddnpmffbkp"
$CwsExtensionId = "canpcddlognjbengiodekfbbfnjafeml"
$HostName = "com.creatorweave.nativehost"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Locate the binary ────────────────────────────────────────────────────
if (-not $BinaryPath) {
    $candidates = @(
        (Join-Path $ScriptDir "cw-native-host.exe"),
        (Join-Path $ScriptDir "target\release\cw-native-host.exe"),
        (Join-Path $ScriptDir "target\x86_64-pc-windows-gnu\release\cw-native-host.exe")
    )
    $BinaryPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $BinaryPath -or -not (Test-Path $BinaryPath)) {
    Write-Host "Error: cw-native-host.exe not found." -ForegroundColor Red
    Write-Host "Searched: script dir, target\release, target\x86_64-pc-windows-gnu\release"
    Write-Host "Or pass it explicitly: .\install.ps1 -BinaryPath C:\path\to\cw-native-host.exe"
    exit 1
}
$BinaryPath = (Resolve-Path $BinaryPath).Path
Write-Host "Found binary: $BinaryPath"

# ── Copy to a stable install dir (survives cargo clean) ─────────────────
$InstallDir = Join-Path $env:LOCALAPPDATA "CreatorWeave\NativeMessagingHosts"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstalledExe = Join-Path $InstallDir "cw-native-host.exe"
Copy-Item $BinaryPath $InstalledExe -Force
Write-Host "Installed binary to: $InstalledExe"

# ── Manifest ─────────────────────────────────────────────────────────────
$ManifestPath = Join-Path $InstallDir "$HostName.json"

$manifest = @{
    name = $HostName
    description = "CreatorWeave Native Host - disk file I/O"
    path = $InstalledExe
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://$ExtensionId/",
        "chrome-extension://$CwsExtensionId/"
    )
} | ConvertTo-Json -Depth 3

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8
Write-Host "Installed manifest: $ManifestPath"

# ── Registry (HKCU — no admin needed) ────────────────────────────────────
foreach ($Browser in @(
    @{ Name = "Chrome"; Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" },
    @{ Name = "Edge";   Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" }
)) {
    try {
        New-Item -Path $Browser.Key -Force | Out-Null
        Set-ItemProperty -Path $Browser.Key -Name "(default)" -Value $ManifestPath
        Write-Host "Registered $($Browser.Name): $($Browser.Key)"
    } catch {
        Write-Host "Skipped $($Browser.Name) registration: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Done! Fully restart Chrome (quit from the tray) for changes to take effect." -ForegroundColor Green
Write-Host "Verify: open chrome://native-internals — the host should be listed."
