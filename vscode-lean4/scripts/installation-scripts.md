# Installation scripts

The extension installs Elan with these scripts:

- `elan-install/install-windows.ps1`
- `elan-install/install-unix.sh`

The CI action `setup-elan` (`.github/actions/setup-elan/action.yml`) runs the same scripts. The script that installs Git on Windows is in `src/utils/depInstaller.ts`.

Users see these scripts. The output channel "Lean: Editor" shows each script that the extension runs. If the installation of Elan fails, an error shows a manual script, which the user can paste into a terminal. Thus the scripts have no comments, and this file has the notes about them. An interactive zsh also does not accept comments.

## The proxy credentials on Windows

The two Windows scripts start with the same lines for the proxy credentials. In `elan-install/install-windows.ps1`, the lines are the start of the script block. In `src/utils/depInstaller.ts`, they are the start of the Git script. A change to these lines must be made in the two scripts.

The extension starts PowerShell without the profiles of the user (`-NoProfile`), so no profile can set the credentials for a proxy. If a proxy needs a login, the downloads give it the Windows credentials of the user. Without a proxy, or with credentials from a profile, the lines have no effect.

On computers with AppLocker or WDAC, PowerShell can run in ConstrainedLanguage mode. This mode blocks the .NET members in the lines. Thus the scripts skip the lines in this mode. Else the output of the installation starts with an error, and the user can think that the proxy is the cause. `elan-init.ps1` does the same check.

## `elan-install/install-windows.ps1`

- A user can paste this script into a terminal (`manualScript` in `src/utils/leanInstaller.ts`). There, `exit` closes the terminal. Thus a failure ends the script with `throw`. In a terminal, PowerShell shows the error, and `powershell -Command` ends with exit code 1.
- The manual script must not change the PowerShell session of the user. Thus the script runs in a script block (`& { ... }`). `$ProgressPreference` and the variables of the script stay in the scope of the script block. A `throw` in the script block ends the script as before.
- The script block does not keep the proxy credentials in its scope. `DefaultWebProxy` is an object of the process, so its credentials stay set after the script. Later downloads in the session then also give the Windows credentials to the proxy.
- With a progress display, `Invoke-WebRequest` of Windows PowerShell 5.1 downloads much more slowly. Thus the script sets `$ProgressPreference` to `SilentlyContinue`. `elan-init.ps1` also downloads Elan with `Invoke-WebRequest`. It runs in a child scope of the script block, so it uses this value too.
- `elan-init.ps1` returns 0 or 1. The script uses only the last output of `elan-init.ps1` (`Select-Object -Last 1`). We do not pin `elan-init.ps1`, and a later version can write more objects to the pipeline. Then `$rc` is an array, and `$rc -ne 0` is true when the array contains a value other than 0.

## `elan-install/install-unix.sh`

The script does not set `pipefail`, because the manual script must not change the shell of the user. The extension and the CI action set it (`elanInstallationMethod` in `src/utils/leanInstaller.ts`).

## The default toolchain

The Elan scripts contain the default toolchain as text, and not the value of `elanStableChannel` in `src/utils/elan.ts`. `test/unit/elanInstallScripts.test.ts` makes sure that the two values are the same.
