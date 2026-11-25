[CmdletBinding()]
param(
    [switch] $RegisterTask,
    [switch] $DownloadOnly
)

$ErrorActionPreference = 'Stop'
$repository = 'N7Steve/t3code'
$repoUrl = "https://github.com/$repository.git"
$branch = 'windows-sync'
$repoRoot = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\T3 Code (Beta)'
$appExe = Join-Path $installDir 'T3 Code (Beta).exe'

function Invoke-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args[0]) failed ($LASTEXITCODE)." }
}

Push-Location -LiteralPath $repoRoot
try {
    if ((Invoke-Git remote get-url origin) -ne $repoUrl -or (Invoke-Git branch --show-current) -ne $branch) {
        throw "Run this script from a clone of $repoUrl on the $branch branch."
    }
    $stateDir = Join-Path (Invoke-Git rev-parse --absolute-git-dir) 'windows-sync'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $log = Join-Path $stateDir 'update.log'
    if ($RegisterTask) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $taskName = "T3 Code Windows Sync $($identity.User.Value)"
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
        $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $repoRoot
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
        $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Write-Output "Registered $taskName. Log: $log"
    }

    try {
        $lock = [IO.File]::Open((Join-Path $stateDir 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        return
    }
    try {
        if (Invoke-Git status --porcelain --untracked-files=no) { throw 'The sync checkout has local edits.' }
        Invoke-Git pull --ff-only --no-tags origin $branch
        if ((Invoke-Git rev-parse HEAD) -ne (Invoke-Git rev-parse FETCH_HEAD)) {
            throw 'The sync checkout has local commits.'
        }

        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases?per_page=100" -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 30
        $release = $releases | Where-Object { $_.tag_name -match '^windows-sync-\d{14}$' -and -not $_.draft } |
            Sort-Object -Property tag_name -Descending | Select-Object -First 1
        if (-not $release) { throw 'No Windows sync release is available.' }
        $installedTag = Join-Path $stateDir 'installed-tag'
        if (-not $DownloadOnly -and (Test-Path -LiteralPath $appExe) -and
            (Test-Path -LiteralPath $installedTag) -and (Get-Content -LiteralPath $installedTag) -eq $release.tag_name) { return }

        $stamp = $release.tag_name.Substring('windows-sync-'.Length)
        $asset = $release.assets | Where-Object { $_.name -match "^T3-Code-\d+\.\d+\.\d+-local\.$stamp-x64\.exe$" } |
            Select-Object -First 1
        if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-f]{64}$') {
            throw 'The Windows installer or its GitHub SHA-256 digest is missing.'
        }
        $installer = Join-Path $stateDir $asset.name
        $expectedHash = $asset.digest.Substring(7)
        if (-not (Test-Path -LiteralPath $installer) -or
            (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $expectedHash) {
            curl.exe --fail --location --silent --show-error --retry 2 --output "$installer.partial" $asset.browser_download_url
            if ($LASTEXITCODE -ne 0) { throw "Windows installer download failed ($LASTEXITCODE)." }
            if ((Get-FileHash -LiteralPath "$installer.partial" -Algorithm SHA256).Hash -ne $expectedHash) {
                throw 'The installer hash does not match the GitHub release.'
            }
            Move-Item -LiteralPath "$installer.partial" -Destination $installer -Force
        }
        if ($DownloadOnly) {
            Write-Output "Verified $installer"
            return
        }

        $running = Get-Process -Name 'T3 Code*' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appExe }
        if ($running) {
            Write-Output 'Close T3 Code to let the next sync install the update.'
            return
        }
        $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
            throw "Windows installer failed ($($process.ExitCode))."
        }
        Set-Content -LiteralPath $installedTag -Value $release.tag_name
        Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) Installed $($release.tag_name)"
        Remove-Item -LiteralPath $installer -Force
    } catch {
        Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $_"
        throw
    } finally {
        $lock.Dispose()
    }
} finally {
    Pop-Location
}
