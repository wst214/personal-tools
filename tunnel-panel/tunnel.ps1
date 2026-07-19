param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Continue"

$env:NO_PROXY = "localhost,127.0.0.1,trycloudflare.com,api.trycloudflare.com,cloudflare.com,.cloudflare.com"
$env:no_proxy = $env:NO_PROXY

$cloudflared = $null
if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    $cloudflared = "cloudflared"
}
elseif (Test-Path "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe") {
    $cloudflared = "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe"
}
elseif (Test-Path "$env:ProgramFiles\cloudflared\cloudflared.exe") {
    $cloudflared = "$env:ProgramFiles\cloudflared\cloudflared.exe"
}

Write-Host ""
Write-Host "Cloudflare Tunnel - mytools"
Write-Host "  Local target : http://localhost:$Port"
Write-Host "  Stop tunnel  : Ctrl+C"
Write-Host ""
Write-Host "Starting... public URL will be highlighted below."
Write-Host ""

$urlShown = $false
$urlPattern = 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com'

function Show-PublicUrl([string]$Url) {
    if ($script:urlShown) { return }
    $script:urlShown = $true
    Write-Host ""
    Write-Host "============================================" -ForegroundColor Green
    Write-Host "  PUBLIC URL (copy and share):" -ForegroundColor Green
    Write-Host "  $Url" -ForegroundColor Yellow
    Write-Host "============================================" -ForegroundColor Green
    Write-Host ""
}

if ($cloudflared) {
    & $cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$Port" 2>&1 | ForEach-Object {
        $line = "$_"
        Write-Host $line
        if ($line -match $urlPattern) {
            Show-PublicUrl $Matches[0]
        }
    }
    exit $LASTEXITCODE
}

$dockerOk = $false
try {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch {}

if (-not $dockerOk) {
    Write-Host "[Error] cloudflared not found and Docker is not running." -ForegroundColor Red
    Write-Host "Install: winget install Cloudflare.cloudflared"
    exit 1
}

docker run --rm --add-host=host.docker.internal:host-gateway `
    -e NO_PROXY=$env:NO_PROXY -e no_proxy=$env:no_proxy `
    cloudflare/cloudflared:latest tunnel --no-autoupdate --url "http://host.docker.internal:$Port" 2>&1 | ForEach-Object {
        $line = "$_"
        Write-Host $line
        if ($line -match $urlPattern) {
            Show-PublicUrl $Matches[0]
        }
    }
exit $LASTEXITCODE
