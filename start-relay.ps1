$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'LunaAndgel'
$dataDir = Join-Path $stateDir 'data'
$pairingFile = Join-Path $stateDir 'pairing-code'
$firebaseFile = Join-Path $stateDir 'firebase-service-account.json'
$node = Get-Command node -ErrorAction Stop
$nodeMajor = [int]((& $node.Source -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) {
  throw 'Node.js 22 ou plus recent est necessaire. Installe-le depuis https://nodejs.org/'
}

New-Item -ItemType Directory -Force -Path $stateDir, $dataDir | Out-Null
if (Test-Path $pairingFile) {
  $pairingCode = (Get-Content $pairingFile -Raw).Trim()
} else {
  $pairingCode = (& $node.Source -p "require('node:crypto').randomBytes(24).toString('base64url')").Trim()
  [System.IO.File]::WriteAllText($pairingFile, $pairingCode, [System.Text.UTF8Encoding]::new($false))
}
if ($pairingCode.Length -lt 16) { throw "Code d'appairage invalide: $pairingFile" }

if (-not (Test-Path (Join-Path $root 'node_modules\ws\package.json'))) {
  $npm = Get-Command npm -ErrorAction Stop
  Push-Location $root
  try {
    & $npm.Source install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Installation des dependances impossible.' }
  } finally {
    Pop-Location
  }
}

$cloudflaredCommand = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflaredCommand) {
  $cloudflared = $cloudflaredCommand.Source
} else {
  $cloudflared = Join-Path $stateDir 'cloudflared.exe'
  if (-not (Test-Path $cloudflared)) {
    Write-Host 'Telechargement de cloudflared depuis les releases officielles Cloudflare...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest `
      -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
      -OutFile $cloudflared `
      -UseBasicParsing
  }
  if ((Get-Item $cloudflared).Length -lt 1MB) {
    throw "Le telechargement de cloudflared semble incomplet: $cloudflared"
  }
}

$oldEnvironment = @{}
foreach ($name in @('DATA_DIR', 'PORT', 'PAIRING_CODE', 'GOOGLE_APPLICATION_CREDENTIALS')) {
  $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$serverProcess = $null
try {
  $env:DATA_DIR = $dataDir
  $env:PORT = '3000'
  $env:PAIRING_CODE = $pairingCode
  Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue
  if (Test-Path $firebaseFile) { $env:GOOGLE_APPLICATION_CREDENTIALS = $firebaseFile }

  $serverProcess = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @('server.js') `
    -WorkingDirectory $root `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $stateDir 'relay-server.log') `
    -RedirectStandardError (Join-Path $stateDir 'relay-server-error.log')
} finally {
  foreach ($name in $oldEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
  }
}

try {
  $healthy = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($serverProcess.HasExited) {
      $log = Get-Content (Join-Path $stateDir 'relay-server-error.log') -Tail 20 -ErrorAction SilentlyContinue
      throw "Le relais local n'a pas demarre. $($log -join ' ')"
    }
    try {
      $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2
      if ($health.ok) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $healthy) { throw 'Le relais local ne repond pas sur le port 3000.' }

  Write-Host ''
  Write-Host 'Relais local demarre. Gardez cette fenetre ouverte.'
  Write-Host 'Cloudflare va afficher une adresse https://....trycloudflare.com.'
  Write-Host 'Entrez cette adresse (sans /health) dans les deux applications.'
  Write-Host ''
  Write-Host "Code d'appairage (a saisir une seule fois sur chaque telephone): $pairingCode"
  Write-Host 'Gardez ce code prive. Il est conserve sur ce PC entre les redemarrages.'
  Write-Host ''

  & $cloudflared tunnel --no-autoupdate --url 'http://127.0.0.1:3000'
  if ($LASTEXITCODE -ne 0) {
    throw 'Le tunnel Cloudflare s''est arrete avec une erreur.'
  }
} finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
