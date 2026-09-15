param(
  [switch]$NoBroadcast
)

$ErrorActionPreference = 'Stop'

$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\plugins\ineedbetterui\skills\ineedbetterui\ineedbetterui.mjs'))
# The tester folder is the project, so its records go to tester\node_modules\.ineedbetterui.
$recordsDir = Join-Path $PSScriptRoot 'node_modules\.ineedbetterui'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop

function Get-TesterServers {
  if (-not (Test-Path -LiteralPath $recordsDir)) { return @() }
  @(Get-ChildItem -LiteralPath $recordsDir -Filter 'server-*.html' |
    Where-Object { $_.Name -match '^server-(\d+)\.html$' } |
    ForEach-Object { [pscustomobject]@{ File = $_.FullName; Port = [int]($_.Name -replace '^server-(\d+)\.html$', '$1') } })
}

function Get-Health([int]$Port) {
  try { Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 2 } catch { $null }
}

# Stop tester servers announced by their info files, then remove the files.
foreach ($server in Get-TesterServers) {
  $health = Get-Health $server.Port
  if ($health -and $health.app -eq 'ineedbetterui') {
    Write-Host ("Stopping existing tester server (PID {0}, port {1})..." -f $health.pid, $server.Port)
    Stop-Process -Id $health.pid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $server.File -Force -ErrorAction SilentlyContinue
}

Write-Host ("Starting latest source: {0}" -f $sourcePath)
Write-Host ("Using tester records folder: {0}" -f $recordsDir)
$nodeArguments = @(('"{0}"' -f $sourcePath))
if ($NoBroadcast) {
  $nodeArguments += '--no-broadcast'
}
$process = Start-Process -FilePath $nodeCommand.Source -ArgumentList $nodeArguments -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
$null = $process.Handle

# Seed one in-progress outline through the API so the sidebar example is visible.
$port = $null
for ($attempt = 0; $attempt -lt 50 -and -not $port; $attempt++) {
  Start-Sleep -Milliseconds 200
  $port = (Get-TesterServers | Where-Object { (Get-Health $_.Port).pid -eq $process.Id } | Select-Object -First 1).Port
}
if ($port) {
  $state = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/state" -f $port)
  if (-not $state.outline) {
    $outline = [ordered]@{
      done = $false
      items = @(
        [ordered]@{ no = '1'; title = 'Diffusion basics'; type = 'report'; status = 'done' }
        [ordered]@{ no = '2'; title = 'Learn the denoising process'; type = 'report'; status = 'active' }
        [ordered]@{ no = '2-1'; title = 'Add noise to training images'; type = 'report'; status = 'done' }
        [ordered]@{ no = '2-2'; title = 'Predict the noise'; type = 'report'; status = 'active'; current = $true }
        [ordered]@{ no = '2-3'; title = 'Train from prediction error'; type = 'report'; status = 'pending' }
        [ordered]@{ no = '3'; title = 'Generate images with the trained model'; type = 'report'; status = 'pending' }
      )
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Patch -Uri ("http://127.0.0.1:{0}/api/outline" -f $port) -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($outline)) | Out-Null
    Write-Host 'Added the example outline to tester data.'
  }
} else {
  Write-Warning 'The tester server did not report a port in time; skipped the example outline.'
}

$process.WaitForExit()
exit $process.ExitCode
