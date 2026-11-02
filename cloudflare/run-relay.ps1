$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$env:PORT = '8099'
$env:ALLOWED_ORIGINS = 'http://localhost:5173'
$env:RELAY_DATA_DIR = 'rooms-test'
Remove-Item rooms-relay.log, rooms-relay.err -ErrorAction SilentlyContinue
$p = Start-Process -FilePath node -ArgumentList 'relay-node.mjs' `
  -RedirectStandardOutput rooms-relay.log -RedirectStandardError rooms-relay.err -PassThru
Start-Sleep -Seconds 2
Get-Content rooms-relay.log, rooms-relay.err -ErrorAction SilentlyContinue
"pid: $($p.Id)"
