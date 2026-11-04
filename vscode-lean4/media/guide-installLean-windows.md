## Installed Components
The following components are automatically installed when clicking [this link](command:lean4.setup.installLean) or the 'Install Lean' button associated with this step:
- [Elan](https://github.com/leanprover/elan) is Lean's version manager and automatically manages all the different versions of Lean and ensures that the correct version is used when opening a project.
- [Git](https://git-scm.com/) is a commonly used [Version Control System](https://en.wikipedia.org/wiki/Version_control) that is used by Lean to help manage different versions of Lean formalization packages and software packages. It can also be used to collaborate on Lean projects.

Components that are already installed will be skipped.

## Installation Procedure Details
The automatic installation runs scripts in Windows PowerShell, with the execution policy `Bypass`. It installs Git first, and then Elan.

On newer Windows systems that support the package manager [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/), the following script installs Git:
```powershell
winget install -e --id Git.Git --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
```

On older Windows systems that do not support the package manager [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/), the following script installs Git instead:
```powershell
# Without a progress display, the download is much faster.
$ProgressPreference = 'SilentlyContinue'
# Download the Git installer to `%TEMP%\lean4-vscode-extension`, run it, and wait until it is done.
$gitInstallerUrl = "https://github.com/git-for-windows/git/releases/download/v2.50.1.windows.1/Git-2.50.1-64-bit.exe"
$installDir = Join-Path $env:TEMP "lean4-vscode-extension"
$gitInstallerLoc = Join-Path $installDir "GitInstaller.exe"
try {
    New-Item -ItemType Directory -Path $installDir -Force -ErrorAction Stop | Out-Null
    Invoke-WebRequest -Uri $gitInstallerUrl -OutFile $gitInstallerLoc -ErrorAction Stop
    $installer = Start-Process -FilePath $gitInstallerLoc -ArgumentList '/VERYSILENT', '/NORESTART', '/SP-' -Wait -PassThru -ErrorAction Stop
} catch {
    Write-Host "Downloading or starting the Git installer failed."
    Write-Host $_
    exit 1
}
if ($installer.ExitCode -ne 0) {
    Write-Host "The Git installer failed with exit code $($installer.ExitCode)."
}
exit $installer.ExitCode
```

Then the following script installs Elan:
```powershell
# Without a progress display, the downloads are much faster.
$ProgressPreference = 'SilentlyContinue'
# Download the Elan installation script at https://github.com/leanprover/elan/blob/master/elan-init.ps1 and run it. Elan will be installed to `%USERPROFILE%\.elan`.
try {
    $installCode = (Invoke-WebRequest -Uri "https://elan.lean-lang.org/elan-init.ps1" -UseBasicParsing -ErrorAction Stop).Content
    $installer = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString($installCode))
    $rc = & $installer -NoPrompt 1 -DefaultToolchain leanprover/lean4:stable | Select-Object -Last 1
} catch {
    Write-Host "Downloading and running the Elan installer failed."
    Write-Host $_
    $rc = 1
}
if ($rc -ne 0) {
    throw "The installation of Elan failed."
}
```

## Restricted Environments
If you are in a restricted environment where you cannot install Git or curl and they are not already installed, for example a restricted university computer, then the installation script above may fail. In this case, there is currently no way to try Lean 4 with a local installation. If you want to try out Lean 4 regardless, you can read [Mathematics in Lean](https://leanprover-community.github.io/mathematics_in_lean/) and do the exercises with [an online instance of Lean 4 hosted using Gitpod](https://gitpod.io/#/https://github.com/leanprover-community/mathematics_in_lean). Doing so requires creating a GitHub account. Alternatively, you can also [play the Natural Number Game](https://adam.math.hhu.de/#/g/hhu-adam/NNG4) or [try a single-file version of Lean 4 in your web browser](https://live.lean-lang.org/).
