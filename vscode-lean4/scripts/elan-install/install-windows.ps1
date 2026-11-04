& {
    $ProgressPreference = 'SilentlyContinue'
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
}
