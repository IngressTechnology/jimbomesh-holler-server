#
# Automated release pipeline for JimboMesh Holler.
#
# Usage:
#   .\scripts\release.ps1 0.3.2
#

param(
    [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$VersionFilesChanged = $false
$CommitCreated = $false
$NpmCommand = "npm.cmd"

function Show-Usage {
    Write-Host "Usage: .\scripts\release.ps1 <version>"
    Write-Host ""
    Write-Host "Example:"
    Write-Host "  .\scripts\release.ps1 0.3.2"
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

function Assert-LastExitCode {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) {
        throw $Message
    }
}

function Invoke-Npm {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $NpmCommand @Arguments
}

function Test-CleanWorkingTree {
    & git diff --quiet
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    & git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        return $false
    }

    $untracked = & git ls-files --others --exclude-standard
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to inspect untracked files."
    }

    return [string]::IsNullOrWhiteSpace(($untracked -join ""))
}

function Ensure-CleanWorktree {
    while (-not (Test-CleanWorkingTree)) {
        Write-Warn "Working tree has uncommitted changes."
        Write-Host "Commit or stash them, then press Enter to re-check."
        $response = Read-Host "Type 'q' to exit, or press Enter to continue"
        if ($response -match '^[Qq]$') {
            throw "Release aborted because the working tree is not clean."
        }
    }
}

function Set-JsonVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    $content = Get-Content -Raw -Path $Path
    $updated = [regex]::Replace(
        $content,
        '(?m)^(\s*"version"\s*:\s*")([^"]+)(")',
        {
            param($match)
            return $match.Groups[1].Value + $Version + $match.Groups[3].Value
        }
    )

    if ($updated -eq $content) {
        throw "Failed to update version in $Path"
    }

    Set-Content -Path $Path -Value $updated -NoNewline
}

function Set-CargoVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    $content = Get-Content -Raw -Path $Path
    $updated = [regex]::Replace(
        $content,
        '(?m)^version\s*=\s*"[^"]+"$',
        "version = `"$Version`""
    )

    if ($updated -eq $content) {
        throw "Failed to update version in $Path"
    }

    Set-Content -Path $Path -Value $updated -NoNewline
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    Show-Usage
    exit 1
}

Push-Location $RepoRoot

try {
    Ensure-CleanWorktree

    Write-Step "Running lint"
    Invoke-Npm run lint
    Assert-LastExitCode "npm run lint failed."

    Write-Step "Running unit tests"
    Invoke-Npm test
    Assert-LastExitCode "npm test failed."

    Write-Step "Updating package.json version"
    Invoke-Npm version $Version --no-git-tag-version
    Assert-LastExitCode "npm version failed."
    $VersionFilesChanged = $true

    Write-Step "Updating desktop Tauri version"
    Set-JsonVersion -Path "desktop/src-tauri/tauri.conf.json" -Version $Version

    Write-Step "Updating Cargo version"
    Set-CargoVersion -Path "desktop/src-tauri/Cargo.toml" -Version $Version

    Write-Step "Staging release files"
    & git add -A
    Assert-LastExitCode "git add failed."

    Write-Step "Creating release commit"
    & git commit -m "release: v$Version"
    Assert-LastExitCode "git commit failed."
    $CommitCreated = $true

    Write-Step "Tagging release"
    & git tag "v$Version"
    Assert-LastExitCode "git tag failed."

    Write-Step "Pushing main and tags"
    & git push origin main --tags
    Assert-LastExitCode "git push failed."

    Write-Host "🔥 v$Version tagged and pushed! Watch the build: https://github.com/IngressTechnology/jimbomesh-holler-server/actions" -ForegroundColor Green
}
catch {
    Write-Err "ERROR: $($_.Exception.Message)"
    if ($VersionFilesChanged -and -not $CommitCreated) {
        Write-Warn "Version files were updated but the release did not complete."
        Write-Warn "Run 'git checkout .' to reset."
    }
    exit 1
}
finally {
    Pop-Location
}

