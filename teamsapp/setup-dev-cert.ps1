# Creates a localhost development certificate so Teams will render the tab.
#
# Teams requires HTTPS with a trusted certificate. This script:
#   1. creates a self-signed certificate for localhost in your personal store
#   2. copies it into YOUR OWN trusted-root store (CurrentUser, not the machine)
#   3. exports it as devcert.pfx for serve.js
#
# It changes your user certificate trust store. That is the standard local
# development approach and is what the Microsoft 365 Agents Toolkit does too,
# but it is a real change, so it is a separate opt-in step rather than
# something serve.js does silently.
#
# To undo everything, run:  .\setup-dev-cert.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$subject = "CN=localhost"
$friendly = "ADO Sync local development certificate"
$here = $PSScriptRoot
$pfx = Join-Path $here "devcert.pfx"
$pwdFile = Join-Path $here "devcert.pwd"

function Get-DevCerts($store) {
  Get-ChildItem $store | Where-Object { $_.FriendlyName -eq $friendly }
}

if ($Remove) {
  foreach ($store in @("Cert:\CurrentUser\My", "Cert:\CurrentUser\Root")) {
    foreach ($c in Get-DevCerts $store) {
      Write-Host "Removing $($c.Thumbprint) from $store"
      Remove-Item "$store\$($c.Thumbprint)" -Force
    }
  }
  Remove-Item $pfx, $pwdFile -ErrorAction SilentlyContinue
  Write-Host "Removed. Nothing left in your trust store."
  return
}

$existing = Get-DevCerts "Cert:\CurrentUser\My" | Where-Object { $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
if ($existing) {
  Write-Host "Reusing certificate $($existing.Thumbprint), valid to $($existing.NotAfter.ToString('yyyy-MM-dd'))"
  $cert = $existing
} else {
  Write-Host "Creating a self-signed certificate for localhost..."
  $cert = New-SelfSignedCertificate `
    -Subject $subject `
    -DnsName "localhost", "127.0.0.1" `
    -FriendlyName $friendly `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddMonths(6) `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature, KeyEncipherment `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
  Write-Host "Created $($cert.Thumbprint)"
}

# Trust it for the current user only. This does not need administrator rights
# and does not affect other accounts on this machine.
#
# certutil is used rather than X509Store.Add because the .NET call raises a
# modal Windows security prompt that blocks indefinitely if nobody answers it.
# certutil writes to the same CurrentUser Root store without the dialog.
$root = "Cert:\CurrentUser\Root"
if (-not (Get-DevCerts $root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint })) {
  Write-Host "Adding to your trusted roots ($root)..."
  $cer = Join-Path $here "devcert.cer"
  Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
  & certutil -user -addstore -f Root $cer | Out-Null
  Remove-Item $cer -ErrorAction SilentlyContinue
  if (Get-ChildItem $root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }) {
    Write-Host "Trusted."
  } else {
    throw "Could not add the certificate to $root."
  }
} else {
  Write-Host "Already trusted."
}

# Export for node. The password is random per run and kept beside the pfx,
# which serve.js refuses to serve over HTTP.
$plain = [System.Guid]::NewGuid().ToString("N")
$secure = ConvertTo-SecureString -String $plain -Force -AsPlainText
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfx -Password $secure | Out-Null
Set-Content -Path $pwdFile -Value $plain -NoNewline -Encoding ascii

Write-Host ""
Write-Host "Done. devcert.pfx written."
Write-Host "Next:  node serve.js     then open the ADO Sync app in Teams."
Write-Host "Undo:  .\setup-dev-cert.ps1 -Remove"
