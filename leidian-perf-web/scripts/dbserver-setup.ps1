# 从 Windows 将安装脚本传到 dbserver 并提示在远端执行（需本机已配置 ssh）
param(
    [string]$DbServer = "192.168.1.41",
    [string]$User = "leidian",
    [string]$RemoteDir = "/tmp/perf-setup"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot "dbserver-setup.sh"

if (-not (Test-Path $script)) {
    throw "找不到 $script"
}

Write-Host "=== dbserver 安装准备 ===" -ForegroundColor Cyan
Write-Host "目标: ${User}@${DbServer}"
Write-Host ""
Write-Host "步骤 1：把脚本复制到 dbserver（需输入 SSH 密码或已配置密钥）"
Write-Host "  ssh ${User}@${DbServer} `"mkdir -p ${RemoteDir}`""
Write-Host "  scp `"$script`" ${User}@${DbServer}:${RemoteDir}/dbserver-setup.sh"
Write-Host ""
Write-Host "步骤 2：登录 dbserver 并执行（需要 sudo 密码）"
Write-Host "  ssh ${User}@${DbServer}"
Write-Host "  chmod +x ${RemoteDir}/dbserver-setup.sh"
Write-Host "  sudo ${RemoteDir}/dbserver-setup.sh"
Write-Host ""
Write-Host "步骤 3：在本机验证"
Write-Host "  curl http://${DbServer}:9100/metrics"
Write-Host ""

$run = Read-Host "是否现在尝试 scp 上传脚本? (y/N)"
if ($run -eq "y" -or $run -eq "Y") {
    ssh "${User}@${DbServer}" "mkdir -p ${RemoteDir}"
    scp $script "${User}@${DbServer}:${RemoteDir}/dbserver-setup.sh"
    Write-Host "上传完成。请 SSH 登录后执行: sudo ${RemoteDir}/dbserver-setup.sh" -ForegroundColor Green
}
