# Install a versioned shortdrama-cli onedir release and its matching Agent Skill.
[CmdletBinding()]
param(
    [string]$Version = $env:SHORTDRAMA_VERSION,
    [string]$Repository = $(if ($env:SHORTDRAMA_GITHUB_REPOSITORY) { $env:SHORTDRAMA_GITHUB_REPOSITORY } else { "col-shortdrama/zhongwen-shortdrama-cli" }),
    [string]$InstallRoot = $(if ($env:SHORTDRAMA_INSTALL_DIR) { $env:SHORTDRAMA_INSTALL_DIR } else { Join-Path $HOME ".shortdrama" }),
    [string]$SkillTarget = $(if ($env:SHORTDRAMA_SKILL_DIR) { $env:SHORTDRAMA_SKILL_DIR } else { Join-Path $HOME ".agents\skills\shortdrama-cli" })
)

$ErrorActionPreference = "Stop"

function Test-GitHubCliReady {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $false }
    & gh auth status *> $null
    return $LASTEXITCODE -eq 0
}

function Resolve-ReleaseTag {
    if ($Version) {
        if ($Version.StartsWith("v")) { return $Version }
        return "v$Version"
    }
    if (Test-GitHubCliReady) {
        return (& gh release view --repo $Repository --json tagName --jq .tagName).Trim()
    }
    try {
        return (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest").tag_name
    }
    catch {
        throw "Could not resolve the latest release. Run 'gh auth login' when installing from a private repository."
    }
}

function Receive-ReleaseAsset([string]$Tag, [string]$Name, [string]$Destination) {
    if (Test-GitHubCliReady) {
        & gh release download $Tag --repo $Repository --pattern $Name --dir (Split-Path $Destination) --clobber
        if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed to download $Name" }
    }
    else {
        try {
            Invoke-WebRequest -Uri "https://github.com/$Repository/releases/download/$Tag/$Name" -OutFile $Destination
        }
        catch {
            throw "Could not download $Name. Run 'gh auth login' when installing from a private repository."
        }
    }
    if (-not (Test-Path $Destination -PathType Leaf)) { throw "Release asset was not downloaded: $Name" }
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($architecture -ne "X64") {
    throw "Unsupported Windows architecture: $architecture. The initial release matrix supports Windows x64."
}

$tag = Resolve-ReleaseTag
$releaseVersion = $tag.TrimStart("v")
$assetName = "shortdrama-cli-v$releaseVersion-windows-x64.zip"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("shortdrama-install-" + [guid]::NewGuid())
$archiveFile = Join-Path $temporaryRoot $assetName
$checksumsFile = Join-Path $temporaryRoot "checksums.txt"

try {
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    Write-Host "Installing shortdrama-cli $releaseVersion for windows-x64..."
    Receive-ReleaseAsset $tag $assetName $archiveFile
    Receive-ReleaseAsset $tag "checksums.txt" $checksumsFile

    $checksumLine = Get-Content $checksumsFile | Where-Object { $_ -match "\s+$([regex]::Escape($assetName))$" } | Select-Object -First 1
    if (-not $checksumLine) { throw "Checksum entry missing for $assetName" }
    $expectedChecksum = ($checksumLine -split "\s+")[0].ToLowerInvariant()
    $actualChecksum = (Get-FileHash -Algorithm SHA256 $archiveFile).Hash.ToLowerInvariant()
    if ($expectedChecksum -ne $actualChecksum) { throw "SHA-256 verification failed for $assetName" }

    $extractRoot = Join-Path $temporaryRoot "extract"
    Expand-Archive -Path $archiveFile -DestinationPath $extractRoot -Force
    $stagedApp = Join-Path $extractRoot "shortdrama-cli"
    $stagedExecutable = Join-Path $stagedApp "shortdrama-cli.exe"
    $stagedSkill = Join-Path $stagedApp "skills\shortdrama-cli"
    if (-not (Test-Path $stagedExecutable -PathType Leaf)) { throw "Archive does not contain the expected executable" }
    if (-not (Test-Path (Join-Path $stagedSkill "SKILL.md") -PathType Leaf)) { throw "Archive does not contain the matching skill" }

    $versionDirectory = Join-Path $InstallRoot "versions\$releaseVersion"
    $installedApp = Join-Path $versionDirectory "shortdrama-cli"
    $binDirectory = Join-Path $InstallRoot "bin"
    New-Item -ItemType Directory -Path (Split-Path $versionDirectory), $binDirectory, (Split-Path $SkillTarget) -Force | Out-Null
    if (Test-Path $versionDirectory) { Remove-Item -Recurse -Force $versionDirectory }
    New-Item -ItemType Directory -Path $versionDirectory -Force | Out-Null
    Copy-Item -Recurse -Force $stagedApp $installedApp

    if (Test-Path $SkillTarget) { Remove-Item -Recurse -Force $SkillTarget }
    Copy-Item -Recurse -Force (Join-Path $installedApp "skills\shortdrama-cli") $SkillTarget

    $launcher = Join-Path $binDirectory "shortdrama-cli.cmd"
    $launcherBody = "@echo off`r`n`"$installedApp\shortdrama-cli.exe`" %*`r`n"
    Set-Content -Path $launcher -Encoding Ascii -Value $launcherBody
    Set-Content -Path (Join-Path $binDirectory "shortdrama.cmd") -Encoding Ascii -Value $launcherBody

    if ($env:SHORTDRAMA_NO_MODIFY_PATH -ne "1") {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $pathEntries = @($userPath -split ";" | Where-Object { $_ })
        if ($pathEntries -notcontains $binDirectory) {
            [Environment]::SetEnvironmentVariable("Path", (($pathEntries + $binDirectory) -join ";"), "User")
            Write-Host "Updated user PATH; open a new terminal to use shortdrama-cli."
        }
    }
    $env:Path = "$binDirectory;$env:Path"

    $installedVersion = (& (Join-Path $installedApp "shortdrama-cli.exe") --version).Trim()
    if ($installedVersion -ne $releaseVersion) { throw "Installed version check failed" }

    Write-Host "Installed shortdrama-cli $installedVersion"
    Write-Host "Launcher: $launcher"
    Write-Host "Skill:    $SkillTarget"
}
finally {
    if (Test-Path $temporaryRoot) { Remove-Item -Recurse -Force $temporaryRoot }
}
