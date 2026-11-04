# A user can paste this script into a terminal (`manualScript` in `src/utils/leanInstaller.ts`).
# There, `exit` closes the terminal. Thus a failure ends the script with `throw`: in a terminal,
# PowerShell shows the error, and `powershell -Command` ends with exit code 1.
try {
    $installCode = (Invoke-WebRequest -Uri "https://elan.lean-lang.org/elan-init.ps1" -UseBasicParsing -ErrorAction Stop).Content
    $installer = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString($installCode))
    # `elan-init.ps1` returns 0 or 1.
    $rc = & $installer -NoPrompt 1 -DefaultToolchain leanprover/lean4:stable
} catch {
    Write-Host "Downloading and running the Elan installer failed."
    Write-Host $_
    $rc = 1
}
if ($rc -ne 0) {
    throw "The installation of Elan failed."
}
