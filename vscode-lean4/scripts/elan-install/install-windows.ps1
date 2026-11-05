try {
    $installCode = (Invoke-WebRequest -Uri "https://elan.lean-lang.org/elan-init.ps1" -UseBasicParsing -ErrorAction Stop).Content
    $installer = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString($installCode))
    Set-ExecutionPolicy -ExecutionPolicy Unrestricted -Scope Process
    $rc = & $installer -NoPrompt 1 -DefaultToolchain leanprover/lean4:stable
    exit $rc
} catch {
    Write-Host "Downloading and running the Elan installer failed."
    Write-Host $_
    exit 1
}
