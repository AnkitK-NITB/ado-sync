# Builds the sideloadable Teams app package.
#
# The manifest hard-codes the tab URLs, so the zip is only valid for the port the
# server actually listens on. Getting that wrong produces a blank tab in Teams and
# no error anywhere, which is a miserable thing to debug -- so the port is an
# explicit argument here, and the manifest is rewritten to match rather than the
# two being kept in step by hand.
#
#   .\pack-teams-app.ps1              # default port 53000
#   .\pack-teams-app.ps1 -Port 53011  # match a server started with ADOSYNC_PORT

param(
  [int]$Port = 53000,
  [string]$Out = "ado-sync-teams-app.zip"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$manifestPath = Join-Path $PSScriptRoot "manifest.json"
$raw = Get-Content $manifestPath -Raw

$found = [regex]::Matches($raw, 'localhost:(\d+)') |
         ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$updated = [regex]::Replace($raw, 'localhost:\d+', "localhost:$Port")

if ($updated -ne $raw) {
  [IO.File]::WriteAllText($manifestPath, $updated)
  Write-Host "  manifest port  $($found -join ', ') -> $Port"
} else {
  Write-Host "  manifest port  $Port (unchanged)"
}

# A schema-invalid manifest uploads fine and then fails inside Teams, so check first.
node validate-manifest.js
if ($LASTEXITCODE -ne 0) { throw "manifest failed validation; package not written" }

# Teams requires manifest.json and both icons at the ROOT of the zip. A wrapping
# folder is the single most common reason a sideload is rejected, so the entries
# are named explicitly rather than taken from a directory walk.
$files = @("manifest.json", "color.png", "outline.png")
foreach ($f in $files) {
  if (-not (Test-Path $f)) { throw "missing required file: $f" }
}

$outPath = Join-Path $PSScriptRoot $Out
if (Test-Path $outPath) { Remove-Item $outPath }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [IO.Compression.ZipFile]::Open($outPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, (Join-Path $PSScriptRoot $f), $f,
      [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}

$size = (Get-Item $outPath).Length
Write-Host ""
Write-Host "WROTE  $outPath  ($size bytes)"
Write-Host ""
Write-Host "Upload in Teams:  Apps -> Manage your apps -> Upload an app -> Upload a custom app"
Write-Host "Start the server on the SAME port first:"
if ($Port -eq 53000) {
  Write-Host "    node serve.js"
} else {
  Write-Host "    `$env:ADOSYNC_PORT='$Port'; node serve.js"
}
Write-Host "Teams will not render the tab over plain HTTP -- devcert.pfx must be present."
