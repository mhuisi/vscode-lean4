# Installation scripts

The extension installs Elan with these scripts:

- `elan-install/install-windows.ps1`
- `elan-install/install-unix.sh`

The CI action `setup-elan` (`.github/actions/setup-elan/action.yml`) runs the same scripts.

Users see these scripts. The output channel "Lean: Editor" shows each script that the extension runs. If the installation of Elan fails, an error shows a manual script, which the user can paste into a terminal. Thus the scripts have no comments, and this file has the notes about them. An interactive zsh also does not accept comments.

## `elan-install/install-windows.ps1`

- A user can paste this script into a terminal (`manualScript` in `src/utils/leanInstaller.ts`). There, `exit` closes the terminal. Thus a failure ends the script with `throw`. In a terminal, PowerShell shows the error, and `powershell -Command` ends with exit code 1.
- With a progress display, `Invoke-WebRequest` of Windows PowerShell 5.1 downloads much more slowly. Thus the script sets `$ProgressPreference` to `SilentlyContinue`. `elan-init.ps1` also downloads Elan with `Invoke-WebRequest`, and it uses this value too.
- `elan-init.ps1` returns 0 or 1.

## `elan-install/install-unix.sh`

The script does not set `pipefail`, because the manual script must not change the shell of the user. The extension and the CI action set it (`elanInstallationMethod` in `src/utils/leanInstaller.ts`).

## The default toolchain

The Elan scripts contain the default toolchain as text, and not the value of `elanStableChannel` in `src/utils/elan.ts`. `test/unit/elanInstallScripts.test.ts` makes sure that the two values are the same.
