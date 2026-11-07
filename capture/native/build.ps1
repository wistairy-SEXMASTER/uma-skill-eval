param(
    [string]$Zig = "zig",
    [string]$Out = "",
    [switch]$Install,
    [string]$GameDir = "C:\Program Files (x86)\STEAM\steamapps\common\UmamusumePrettyDerby_Jpn"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$mh = Join-Path $root "third_party\minhook"
$capture = Join-Path $root "capture\capture.c"
$proxy = Join-Path $root "proxy\winhttp_proxy.c"
$def = Join-Path $root "proxy\cri_mana_vpx.def"

if (-not $Out) {
    $Out = Join-Path $root "proxy\cri_mana_vpx.dll"
}

$sources = @(
    $proxy,
    $capture,
    (Join-Path $mh "src\buffer.c"),
    (Join-Path $mh "src\hook.c"),
    (Join-Path $mh "src\trampoline.c"),
    (Join-Path $mh "src\hde\hde64.c")
)

Write-Host "Building $Out"
& $Zig cc -target x86_64-windows-gnu -shared `
    -I"$mh\include" -I"$mh\src" -I(Join-Path $root "capture") `
    -o $Out @sources $def -lws2_32 -lntdll

if ($LASTEXITCODE -ne 0) {
    throw "Build failed."
}

Write-Host "Built: $Out"
if ($Install) {
    $target = Join-Path $GameDir "cri_mana_vpx.dll"
    Copy-Item $Out $target -Force
    Write-Host "Installed: $target"
}
