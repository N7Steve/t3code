[CmdletBinding()]
param([string] $WorkerTaskName)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$updateDir = Join-Path $repoRoot 'release\windows-local'
$pending = Join-Path $updateDir 'pending.exe'
$log = Join-Path $updateDir 'restart.log'
$appExe = Join-Path $env:LOCALAPPDATA 'Programs\T3 Code (Beta)\T3 Code (Beta).exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not $WorkerTaskName) {
    if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) {
        throw 'There is no pending T3 Code installer.'
    }
    if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
        throw "Installed T3 Code executable missing at $appExe."
    }

    $taskName = 'T3 Code Restart ' + [guid]::NewGuid().ToString('N')
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -WorkerTaskName "{1}"' -f $PSCommandPath, $taskName
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repoRoot
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    try {
        Start-ScheduledTask -TaskName $taskName
    } catch {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        throw
    }
    Write-Output "Restart started. Log: $log"
    return
}

function Write-RestartLog([string] $Message) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message"
}

function Get-InstalledT3Process {
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($appExe)) -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $appExe }
}

$reopen = $false
try {
    Write-RestartLog 'Closing T3 Code.'
    foreach ($process in Get-InstalledT3Process) {
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $null = $process.CloseMainWindow()
        }
    }
    $closeDeadline = (Get-Date).AddSeconds(30)
    while (Get-InstalledT3Process) {
        if ((Get-Date) -ge $closeDeadline) { throw 'T3 Code did not close within 30 seconds.' }
        Start-Sleep -Milliseconds 250
    }

    $reopen = $true
    Write-RestartLog 'Installing the pending update.'
    $updater = Join-Path $PSScriptRoot 'update-windows-install.ps1'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallPending' -f $updater
    $installDeadline = (Get-Date).AddMinutes(3)
    while (Test-Path -LiteralPath $pending -PathType Leaf) {
        $install = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        if ($install.ExitCode -ne 0) { throw "The local updater exited with code $($install.ExitCode)." }
        if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { break }
        if ((Get-Date) -ge $installDeadline) { throw 'The pending installer was not applied.' }
        Start-Sleep -Seconds 1
    }
    Write-RestartLog 'Update installed.'
} catch {
    Write-RestartLog "Failed: $_"
    throw
} finally {
    try {
        if ($reopen) {
            Start-Process -FilePath $appExe -WindowStyle Normal
            $openDeadline = (Get-Date).AddSeconds(45)
            while (-not (Get-InstalledT3Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
                if ((Get-Date) -ge $openDeadline) { throw 'T3 Code did not open a window within 45 seconds.' }
                Start-Sleep -Milliseconds 250
            }
            Write-RestartLog 'T3 Code reopened.'
        }
    } catch {
        Write-RestartLog "Could not reopen T3 Code: $_"
        throw
    } finally {
        Unregister-ScheduledTask -TaskName $WorkerTaskName -Confirm:$false
    }
}
