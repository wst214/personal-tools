$ErrorActionPreference = "SilentlyContinue"
Get-NetTCPConnection -LocalPort 5758 | ForEach-Object {
  Stop-Process -Id $_.OwningProcess -Force
}
Start-Sleep -Seconds 1
& (Join-Path $PSScriptRoot "start.ps1") -Background
