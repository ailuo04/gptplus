# run-scenario.ps1 - start the capture gateway with a scenario, run codex exec, collect artifacts
param(
  [Parameter(Mandatory=$true)][string]$Scenario,
  [string]$Prompt = "Say hello.",
  [int]$Port = 10199,
  [string]$Tag = "",
  [switch]$KeepGoing
)
$ErrorActionPreference = "Continue"
$py  = "C:\Users\ailuo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$bin = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe"
$cap = "C:\ailuo_own\gpt++\research\capture"
$home_ = Join-Path $cap "codex-home"
$work  = Join-Path $cap "work"
$name  = if ($Tag) { "$Scenario-$Tag" } else { $Scenario }
$logs  = Join-Path $cap "logs"; New-Item -ItemType Directory -Force -Path $logs, $work | Out-Null

$env:GW_SCENARIO = $Scenario
$env:GW_PORT = "$Port"
$env:GW_KEEP_LOG = "0"
$srvOut = Join-Path $logs "$name.server.out.txt"
$srvErr = Join-Path $logs "$name.server.err.txt"
$gw = Start-Process -FilePath $py -ArgumentList @((Join-Path $cap "gateway.py")) `
        -NoNewWindow -PassThru -RedirectStandardOutput $srvOut -RedirectStandardError $srvErr
Start-Sleep -Milliseconds 1200

$cOut = Join-Path $logs "$name.codex.out.txt"
$cErr = Join-Path $logs "$name.codex.err.txt"
$env:CODEX_HOME = $home_
$p = Start-Process -FilePath $bin `
      -ArgumentList @("exec","--skip-git-repo-check","-s","read-only","--color","never",('"' + $Prompt + '"')) `
      -WorkingDirectory $work -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $cOut -RedirectStandardError $cErr

Start-Sleep -Milliseconds 400
if (-not $gw.HasExited) { Stop-Process -Id $gw.Id -Force }
Start-Sleep -Milliseconds 300

if (Test-Path (Join-Path $cap "capture.jsonl")) {
  Copy-Item (Join-Path $cap "capture.jsonl") (Join-Path $logs "$name.capture.jsonl") -Force
}
Write-Host "===== SCENARIO $name  exit=$($p.ExitCode) ====="
Write-Host "--- STDOUT ---"; Get-Content $cOut -ErrorAction SilentlyContinue
Write-Host "--- STDERR (first 25) ---"; Get-Content $cErr -ErrorAction SilentlyContinue | Select-Object -First 25
$cap_count = if (Test-Path (Join-Path $logs "$name.capture.jsonl")) { (Get-Content (Join-Path $logs "$name.capture.jsonl")).Count } else { 0 }
Write-Host "--- CAPTURED REQUESTS: $cap_count ---"
