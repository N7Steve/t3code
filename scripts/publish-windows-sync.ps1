[CmdletBinding()]
param(
    [string] $Installer
)

$ErrorActionPreference = 'Stop'
$repository = 'N7Steve/t3code'
$remote = "git@github.com:$repository.git"
$branch = 'refs/heads/windows-sync'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args[0]) failed ($LASTEXITCODE)." }
}

function Get-SourceTree {
    $previousIndex = $env:GIT_INDEX_FILE
    $env:GIT_INDEX_FILE = Join-Path $env:TEMP "t3code-sync-$([guid]::NewGuid()).index"
    try {
        Invoke-Git read-tree HEAD
        Invoke-Git add --all -- .
        Invoke-Git write-tree
    } finally {
        Remove-Item -LiteralPath $env:GIT_INDEX_FILE -Force -ErrorAction SilentlyContinue
        $env:GIT_INDEX_FILE = $previousIndex
    }
}

if ($Installer) { $Installer = (Resolve-Path -LiteralPath $Installer).Path }
$previousToken = $env:GH_TOKEN
Push-Location -LiteralPath $repoRoot
try {
    if (-not $env:GH_TOKEN) {
        $credential = "protocol=https`nhost=github.com`n`n" | git -c credential.interactive=never credential fill 2>$null
        $password = $credential | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
        if ($password) { $env:GH_TOKEN = $password.Substring(9) }
    }

    $head = Invoke-Git rev-parse HEAD
    $tree = Get-SourceTree
    if (-not $Installer) {
        $output = Join-Path $repoRoot "release\windows-transfer\$([guid]::NewGuid())"
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'update-windows-install.ps1') -ExportTo $output
        if ($LASTEXITCODE -ne 0) { throw "Windows installer build failed ($LASTEXITCODE)." }
        $Installer = (Get-ChildItem -LiteralPath $output -Filter 'T3-Code-*-x64.exe' -File).FullName
        if ($head -ne (Invoke-Git rev-parse HEAD) -or $tree -ne (Get-SourceTree)) {
            throw 'The source changed during the build. Run the publisher again.'
        }
    }

    $file = Get-Item -LiteralPath $Installer
    if ($file.Name -notmatch '^T3-Code-(?<version>\d+\.\d+\.\d+-local\.(?<stamp>\d{14}))-x64\.exe$') {
        throw 'Expected an x64 installer from the local Windows build.'
    }
    $version = $Matches.version
    $tag = "windows-sync-$($Matches.stamp)"
    $current = Invoke-Git ls-remote $remote $branch
    $parents = @('-p', $head)
    if ($current) {
        $previousCommit = ($current -split '\s+')[0]
        Invoke-Git fetch --no-tags --no-write-fetch-head $remote $branch
        $parents = @('-p', $previousCommit)
        git merge-base --is-ancestor $head $previousCommit
        if ($LASTEXITCODE -eq 1) { $parents += @('-p', $head) }
        elseif ($LASTEXITCODE -ne 0) { throw 'Could not compare source history.' }
    }
    $commit = Invoke-Git commit-tree $tree @parents -m "build(windows): publish $version"
    Invoke-Git push $remote "${commit}:$branch"

    gh release create $tag $file.FullName --repo $repository --target $commit --prerelease --latest=false `
        --title "T3 Code $version for Windows x64" --notes "Windows x64 build from commit $commit on the windows-sync branch."
    if ($LASTEXITCODE -ne 0) { throw "GitHub release publication failed ($LASTEXITCODE)." }
} finally {
    $env:GH_TOKEN = $previousToken
    Pop-Location
}
