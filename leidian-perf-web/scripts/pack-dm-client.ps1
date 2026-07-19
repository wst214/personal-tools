# Pack Linux DM8 client from dbserver into dm-client/ for Dockerfile.dameng
# Only packs bin/ + drivers/ (NOT data/log/doc)
# Usage: .\scripts\pack-dm-client.ps1

param(
    [string]$DbServer = $(if ($env:DBSERVER) { $env:DBSERVER } else { "192.168.1.41" }),
    [string]$SshUser = $(if ($env:SSH_USER) { $env:SSH_USER } else { "leidian" }),
    [string]$RemoteDmHome = "/opt/dmdbms",
    [switch]$UseSudo
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $Root "dm-client"

foreach ($cmd in @("ssh", "scp", "tar")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "$cmd not found."
    }
}

$remote = "${SshUser}@${DbServer}"
$remoteArchive = "/tmp/leidian-dmdbms-client.tgz"

Write-Host "Target: $Target"
Write-Host "Remote: ${remote}:${RemoteDmHome} (bin + drivers + include)"
Write-Host ""

Write-Host ">> [1/4] check remote disql..."
& ssh $remote "test -r ${RemoteDmHome}/bin/disql"
if ($LASTEXITCODE -ne 0) { $UseSudo = $true; Write-Host "    need sudo" } else { Write-Host "    OK" }

$packBody = "rm -f $remoteArchive; tar czhf $remoteArchive -C $RemoteDmHome bin drivers include && ls -lh $remoteArchive"
if ($UseSudo) {
    Write-Host ">> [2/4] pack on dbserver (sudo), wait for ls -lh..."
    & ssh -t $remote "sudo bash -lc '$packBody'"
} else {
    Write-Host ">> [2/4] pack on dbserver, wait for ls -lh..."
    & ssh $remote $packBody
}
if ($LASTEXITCODE -ne 0) { Write-Error "remote pack failed" }

Write-Host ">> [3/4] download via scp..."
$localArchive = Join-Path $env:TEMP ("dmdbms-client-" + [guid]::NewGuid().ToString("n") + ".tgz")
& scp "${remote}:${remoteArchive}" $localArchive
if ($LASTEXITCODE -ne 0) { Write-Error "scp failed" }

Write-Host ">> [4/4] extract bin + drivers only (skip doc/pdf with Chinese names)..."
$tmp = Join-Path $env:TEMP ("dm-client-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    # Extract only client dirs; never unpack doc/ (Windows tar breaks on some DM doc filenames)
    & tar -xzf $localArchive -C $tmp bin drivers include 2>$null
    if (-not (Test-Path (Join-Path $tmp "bin\disql"))) {
        & tar -xzf $localArchive -C $tmp dmdbms/bin dmdbms/drivers dmdbms/include 2>$null
    }

    if (Test-Path (Join-Path $tmp "dmdbms\bin\disql")) {
        $srcRoot = Join-Path $tmp "dmdbms"
    } elseif (Test-Path (Join-Path $tmp "bin\disql")) {
        $srcRoot = $tmp
    } else {
        Write-Error "bin/disql not found. Archive may be wrong; re-run pack-dm-client.bat"
    }

    Get-ChildItem $Target -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notin @(".gitignore", ".gitkeep") } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    foreach ($name in @("bin", "drivers", "include")) {
        $src = Join-Path $srcRoot $name
        if (-not (Test-Path $src)) { continue }
        $dest = Join-Path $Target $name
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Move-Item $src $dest
    }

    if (-not (Test-Path (Join-Path $Target "bin\disql"))) {
        Write-Error "dm-client\bin\disql missing after extract"
    }

    Write-Host ""
    Write-Host "OK: dm-client ready -> docker-start.bat --dameng"
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $localArchive) { Remove-Item $localArchive -Force -ErrorAction SilentlyContinue }
    & ssh $remote "rm -f $remoteArchive" 2>$null | Out-Null
}
