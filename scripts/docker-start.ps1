# Starts Docker Desktop on Windows builds where it crashes on leftover AF_UNIX socket files
# ("rename ... .sock ... .stale: The file cannot be accessed by the system").
# Quits Docker Desktop, moves the two socket folders aside (nothing is deleted), then starts it.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\docker-start.ps1

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }

Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'docker-agent') } |
  Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

$ts = Get-Date -Format yyyyMMddHHmmss
foreach ($dir in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
  if (Test-Path $dir) {
    Rename-Item $dir "$(Split-Path $dir -Leaf).old-$ts"
    Write-Host "Moved aside: $dir"
  }
}

Start-Process $exe
Write-Host 'Waiting for the Docker engine...'
for ($i = 0; $i -lt 36; $i++) {
  Start-Sleep -Seconds 5
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host 'Docker engine is ready.'; exit 0 }
}
Write-Host 'Docker engine did not become ready within 3 minutes.'
exit 1
