# Installation scripts

The extension installs Elan with these scripts:

- `elan-install/install-windows.ps1`
- `elan-install/install-unix.sh`

The CI action `setup-elan` (`.github/actions/setup-elan/action.yml`) runs the same scripts.

Users see these scripts. The output channel "Lean: Editor" shows each script that the extension runs. If the installation of Elan fails, an error shows a manual script, which the user can paste into a terminal. Thus the scripts have no comments, and this file has the notes about them. An interactive zsh also does not accept comments.

## `elan-install/install-windows.ps1`

- A user can paste this script into a terminal (`manualScript` in `src/utils/leanInstaller.ts`). There, `exit` closes the terminal. Thus a failure ends the script with `throw`. In a terminal, PowerShell shows the error, and `powershell -Command` ends with exit code 1.
- The manual script must not change the PowerShell session of the user. Thus the script runs in a script block (`& { ... }`). `$ProgressPreference` and the variables of the script stay in the scope of the script block. A `throw` in the script block ends the script as before.
- With a progress display, `Invoke-WebRequest` of Windows PowerShell 5.1 downloads much more slowly. Thus the script sets `$ProgressPreference` to `SilentlyContinue`. `elan-init.ps1` also downloads Elan with `Invoke-WebRequest`. It runs in a child scope of the script block, so it uses this value too.
- `elan-init.ps1` returns 0 or 1. The script uses only the last output of `elan-init.ps1` (`Select-Object -Last 1`). We do not pin `elan-init.ps1`, and a later version can write more objects to the pipeline. Then `$rc` is an array, and `$rc -ne 0` is true when the array contains a value other than 0.

## `elan-install/install-unix.sh`

The script does not set `pipefail`, because the manual script must not change the shell of the user. The extension and the CI action set it (`elanInstallationMethod` in `src/utils/leanInstaller.ts`).

## The default toolchain

The Elan scripts contain the default toolchain as text, and not the value of `elanStableChannel` in `src/utils/elan.ts`. `test/unit/elanInstallScripts.test.ts` makes sure that the two values are the same.
