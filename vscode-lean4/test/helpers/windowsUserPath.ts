import { windowsPowerShell } from './powershell'

// On Windows, the elan installer adds `<ELAN_HOME>\bin` to the PATH of the user
// in the registry (`HKCU\Environment`). The test home cannot isolate the
// registry, so the installer of the network suite changes the real PATH of the
// user. Thus `elan-install.test.ts` removes this entry after the test.
//
// We remove only the entries of the test home, and keep all other entries as
// they are. A copy of the value from before the test is not sufficient: if a
// run stops before the cleanup, the next run cannot know which changes came
// after the copy, and writing the copy back deletes them.
//
// The script changes the value in PowerShell, so that the value (for example a
// user name with non-ASCII letters, or `%USERPROFILE%`) does not go through the
// text output of PowerShell.

function powershell(script: string): void {
    windowsPowerShell(['-Command', script])
}

// Removes each entry of the PATH of the user that is `$ELAN_HOME\bin`. The
// installer writes the absolute path (`do_add_to_path` of elan). Thus we compare
// the text of the entries, without the case and a `\` at the end. We do not
// expand variables: the tests set `USERPROFILE` to the test home, so an
// entry `%USERPROFILE%\.elan\bin` of the real elan would match.
//
// If no entry matches, the script changes nothing. If no other entry stays, it
// removes the value: the installer creates it if it does not exist. Then it
// tells the other programs (for example Explorer) that the environment
// changed: `SetEnvironmentVariable` with the target `User` sends
// `WM_SETTINGCHANGE`, also for a variable that does not exist.
export function removeTestElanFromWindowsUserPath(): void {
    powershell(`
        $ErrorActionPreference = 'Stop'
        $elanBin = (Join-Path $env:ELAN_HOME 'bin').Replace('/', '\\').TrimEnd('\\')
        $environment = Get-Item 'HKCU:\\Environment'
        $value = $environment.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
        if ($null -ne $value) {
            $entries = @($value -split ';')
            $kept = @($entries | Where-Object { $_.Replace('/', '\\').TrimEnd('\\') -ne $elanBin })
            if ($kept.Count -ne $entries.Count) {
                $newValue = $kept -join ';'
                if ($newValue -eq '') {
                    Remove-ItemProperty -Path 'HKCU:\\Environment' -Name Path
                } else {
                    $kind = $environment.GetValueKind('Path')
                    $null = New-ItemProperty -Path 'HKCU:\\Environment' -Name Path -Value $newValue -PropertyType $kind -Force
                }
                [Environment]::SetEnvironmentVariable('LEAN4_TEST_UNUSED', $null, 'User')
            }
        }
    `)
}
