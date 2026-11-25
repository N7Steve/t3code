[CmdletBinding(DefaultParameterSetName = 'Build')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Register')]
    [switch] $RegisterTask,

    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [switch] $InstallPending,

    [Parameter(Mandatory, ParameterSetName = 'Export')]
    [string] $ExportTo
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'T3 Code Source Update'
$updateDir = Join-Path $repoRoot 'release\windows-local'
$pending = Join-Path $updateDir 'pending.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\T3 Code (Beta)'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -InstallPending' -f $PSCommandPath

if ($RegisterTask) {
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $taskArgs
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    return
}

if ($InstallPending -and -not (Test-Path -LiteralPath $pending -PathType Leaf)) { return }
if ($ExportTo) {
    $ExportTo = [IO.Path]::GetFullPath($ExportTo)
    New-Item -ItemType Directory -Path $updateDir -Force | Out-Null
} elseif (-not $InstallPending) {
    $task = Get-ScheduledTask -TaskName $taskName
    if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -ne $taskArgs) {
        throw 'The scheduled updater points to a different checkout. Register it from this checkout first.'
    }
    New-Item -ItemType Directory -Path $updateDir -Force | Out-Null
}

try {
    $lock = [IO.File]::Open((Join-Path $updateDir 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch [IO.IOException] {
    if ($InstallPending) { return }
    throw
}

try {
    if ($InstallPending) {
        if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { return }
        $running = Get-Process -Name 'T3 Code*' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and (Split-Path -Parent $_.Path) -eq $installDir }
        if ($running) { return }

        $log = Join-Path $updateDir 'install.log'
        try {
            $installer = Start-Process -FilePath $pending -ArgumentList "/S /D=$installDir" -WindowStyle Hidden -Wait -PassThru
            if ($installer.ExitCode -ne 0) { throw "NSIS returned exit code $($installer.ExitCode)." }
            $appExe = Join-Path $installDir 'T3 Code (Beta).exe'
            if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw "Installed executable missing at $appExe." }
            Remove-Item -LiteralPath $pending
            $installedVersion = (Get-Item -LiteralPath $appExe).VersionInfo.ProductVersion
            Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) Installed $installedVersion at $appExe"
        } catch {
            Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $_"
            throw
        }
        return
    }

    Set-Location -LiteralPath $repoRoot
    if ((git branch --show-current) -ne 'main') { throw 'Run the Windows source build on main.' }

    $legacyVp = Join-Path $env:USERPROFILE '.vite-plus'
    if (-not $env:VP_HOME -and (Test-Path -LiteralPath (Join-Path $legacyVp 'bin\vp.exe'))) {
        $env:VP_HOME = $legacyVp
    }
    $vpBin = if ($env:VP_HOME) { Join-Path $env:VP_HOME 'bin' } else { Join-Path $env:LOCALAPPDATA 'vite-plus\bin' }
    $env:Path = "$vpBin;$env:USERPROFILE\.cargo\bin;$env:Path"

    vp install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed ($LASTEXITCODE)." }

    # Build the helper with the installed MSVC toolchain, then pass it through the release packager's reuse path.
    cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw "Resource monitor build failed ($LASTEXITCODE)." }
    $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = 'true'
    # The optional prepared bytecode adds enough loose files to exceed the Windows installer budget.
    $env:T3CODE_DESKTOP_SKIP_PREPARED_CACHE = 'true'
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = ''
    $env:GITHUB_REPOSITORY = ''

    # The packaged server probe must run outside the checkout and its node_modules.
    $buildTemp = "$repoRoot-windows-build-temp"
    New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
    $env:TEMP = $env:TMP = $buildTemp

    $desktop = Get-Content -Raw apps/desktop/package.json | ConvertFrom-Json
    $version = "$($desktop.version)-local.$(Get-Date -Format yyyyMMddHHmmss)"
    $output = if ($ExportTo) { $ExportTo } else { Join-Path $updateDir 'build' }
    vp run dist:desktop:win:x64 --build-version $version --output-dir $output
    if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed ($LASTEXITCODE)." }
    $artifact = Join-Path $output "T3-Code-$version-x64.exe"
    if ($ExportTo) { return }
    Move-Item -LiteralPath $artifact -Destination $pending -Force
    if (Test-Path -LiteralPath "$artifact.blockmap") {
        Remove-Item -LiteralPath "$artifact.blockmap"
    }
} finally {
    $lock.Dispose()
}

Start-ScheduledTask -TaskName $taskName
Write-Output "Windows installer queued for $version. It will install when T3 Code is closed."
