param(
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

# Prepares a Codex test project with a project-local copy of the ineedbetterui skill
# and starts Codex CLI in it. No global Codex settings or skill folders are changed.
$project = Join-Path $PSScriptRoot 'codex-project'
$skillSource = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\plugins\ineedbetterui\skills\ineedbetterui'))
$skills = Join-Path $project '.agents\skills'
$skillDir = Join-Path $skills 'ineedbetterui'

# Refresh the project-local skill copy from the repository.
if (Test-Path -LiteralPath $skillDir) { [System.IO.Directory]::Delete($skillDir, $true) }
[System.IO.Directory]::CreateDirectory($skills) | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skills -Recurse

# Records go to the project's node_modules\.ineedbetterui, which workspace-write can write.
$sandboxMode = 'sandbox_mode="workspace-write"'
Write-Host "Test project : $project"
Write-Host "Skill        : $skillDir"
Write-Host ("Records      : {0}" -f (Join-Path $project 'node_modules\.ineedbetterui'))

if ($NoLaunch) {
  Write-Host ''
  Write-Host 'Start Codex with:'
  Write-Host ("codex -C `"{0}`" -c '{1}'" -f $project, $sandboxMode)
  return
}

$codex = Get-Command codex -ErrorAction Stop
& $codex.Source -C $project -c $sandboxMode
