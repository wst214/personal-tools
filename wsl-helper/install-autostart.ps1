$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $dir "start.ps1"
$taskName = "MyTools-WSL-Helper"

if (-not (Test-Path $scriptPath)) {
    Write-Error "start.ps1 not found: $scriptPath"
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Background" `
    -WorkingDirectory $dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Auto-start WSL helper for mytools Linux Remote Panel" `
    -Force | Out-Null

Write-Host "Installed scheduled task: $taskName"
Write-Host "WSL helper will start in background ~30s after you log in."
Write-Host "Remove with: .\uninstall-autostart.ps1"
