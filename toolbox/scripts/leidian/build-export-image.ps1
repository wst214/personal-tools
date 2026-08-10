# Build one local service image (local jar + Dockerfile.*.local) and export as .tar.
# 自包含版本：从 toolbox 调用，靠 -ProjectRoot 定位 leidian 项目根，不再依赖脚本自身路径。
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File <toolbox>/scripts/leidian/build-export-image.ps1 -ProjectRoot D:\workspace\leidian\leidian-pgsql-center -Service data-service
#   ... -Service data-service -Platform linux/arm64
#   ... -Service data-service -ExportDir D:\exports
# Supported: data-service | biz-service | system-service | gateway-service | task-service | db-migration
#
# Export naming:
#   (default amd64)  biz-service -> <ExportDir>/leidian-biz-image.tar
#   (linux/arm64)    biz-service -> <ExportDir>/leidian-biz-image-arm64.tar
#   Image tags:
#   (default)        leidian/{service}:local
#   (linux/arm64)    leidian/{service}:local-arm64  (retag after build)
# ExportDir 省略或空串时回退到 {ProjectRoot}/exports

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("data-service", "biz-service", "system-service", "gateway-service", "task-service", "db-migration")]
    [string]$Service,

    # leidian 项目根（含 pom.xml、deployments/、services/）
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    # 导出目录，省略则用 {ProjectRoot}/exports
    [string]$ExportDir = "",

    # Optional: linux/arm64 for Kunpeng; omit for host default (usually amd64)
    [string]$Platform = ""
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    throw "ProjectRoot 不存在或不是目录: $ProjectRoot"
}
$Root = (Resolve-Path -LiteralPath $ProjectRoot).Path
Set-Location $Root

$isArm64 = $Platform -eq "linux/arm64"
$composeImage = "leidian/${Service}:local"
$image = if ($isArm64) { "leidian/${Service}:local-arm64" } else { $composeImage }
if ($ExportDir) {
    $exportDir = $ExportDir
} else {
    $exportDir = Join-Path $Root "exports"
}
$shortName = $Service -replace "-service$", ""
$exportSuffix = if ($isArm64) { "-arm64" } else { "" }
$exportFile = Join-Path $exportDir "leidian-${shortName}-image${exportSuffix}.tar"

Write-Host "==> Project root: $Root"
Write-Host "==> Service: $Service"
Write-Host "==> Image: $image"
Write-Host "==> Export dir: $exportDir"
if ($Platform) {
    Write-Host "==> Platform: $Platform"
}

Write-Host "==> Maven clean package (local Dockerfile needs fresh jar)"
mvn -pl "services/$Service" -am clean package "-DskipTests" -ntp
if ($LASTEXITCODE -ne 0) {
    throw "Maven package failed with exit code $LASTEXITCODE"
}

$composeArgs = @(
    "compose",
    "--env-file", "deployments/docker-compose/.env",
    "-f", "deployments/docker-compose/docker-compose.yml",
    "-f", "deployments/docker-compose/docker-compose.local-build.yml"
)

if ($isArm64) {
    $composeArgs += @("-f", "deployments/docker-compose/docker-compose.arm64.yml")
}

$composeArgs += @("build", $Service)

Write-Host "==> docker $($composeArgs -join ' ')"
& docker @composeArgs
if ($LASTEXITCODE -ne 0) {
    throw "docker compose build failed with exit code $LASTEXITCODE"
}

if ($isArm64) {
    Write-Host "==> docker tag $composeImage $image"
    docker tag $composeImage $image
    if ($LASTEXITCODE -ne 0) {
        throw "docker tag failed with exit code $LASTEXITCODE"
    }
}

$arch = docker image inspect $image --format "{{.Architecture}}"
if ($LASTEXITCODE -ne 0) {
    throw "docker image inspect failed with exit code $LASTEXITCODE"
}
Write-Host "==> Architecture: $arch"
if ($isArm64 -and $arch -ne "arm64") {
    throw "Expected arm64 image but got architecture: $arch"
}

New-Item -ItemType Directory -Force -Path $exportDir | Out-Null
Write-Host "==> docker save $image -o $exportFile"
docker save $image -o $exportFile
if ($LASTEXITCODE -ne 0) {
    throw "docker save failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "OK: image built and exported"
Write-Host "  image : $image"
Write-Host "  arch  : $arch"
Write-Host "  tar   : $exportFile"
Write-Host "Import elsewhere: docker load -i `"$exportFile`""
