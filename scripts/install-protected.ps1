param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'com.lx.psai.workbench'
$target = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.lx.psai.workbench'
$required = @('main.js', 'index.html', 'style.css', 'CSXS\manifest.xml', 'jsx\host.jsxbin', 'assets\sponsor\软件声明.txt', 'assets\sponsor\mm_facetoface_collect_qrcode_1789623023799.png', 'assets\sponsor\1789623042991.jpg')
try {
    foreach ($f in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $f))) { throw "Missing package file: $f" }
    }
    if ($CheckOnly) { Write-Host 'PASS: package files ready; no files or registry values changed.'; exit 0 }
    if (Get-Process Photoshop -ErrorAction SilentlyContinue) { throw 'Please save documents and close Photoshop before installation.' }
    $backup = $null
    if (Test-Path -LiteralPath $target) {
        $backupRoot = Join-Path $env:APPDATA 'DongPS\plugin-backups'
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $backup = Join-Path $backupRoot ('workbench-' + [Guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $target -Destination $backup
    }
    try {
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse
        foreach ($f in $required) {
            if ((Get-FileHash -LiteralPath (Join-Path $source $f)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $f)).Hash) { throw "Copy verification failed: $f" }
        }
        foreach ($v in 9..13) {
            $key = "HKCU:\Software\Adobe\CSXS.$v"
            New-Item -Path $key -Force | Out-Null
            New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
        }
    } catch {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        if ($backup) { Move-Item -LiteralPath $backup -Destination $target }
        throw
    }
    Write-Host 'DongPS protected package installed. Reopen Photoshop.'
    if ($backup) { Write-Host "Previous plugin backup: $backup" }
    Write-Host 'Existing API configuration was not changed.'
    exit 0
} catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
