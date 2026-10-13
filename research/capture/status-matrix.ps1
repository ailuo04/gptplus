# status-matrix.ps1 - probe HTTP status + SSE-terminal-error handling and retry counts
param([int]$Port = 10199)
$py  = "C:\Users\ailuo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$bin = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe"
$cap = "C:\ailuo_own\gpt++\research\capture"
$work = Join-Path $cap "work"; $logs = Join-Path $cap "logs"
$home_ = Join-Path $cap "codex-home"
New-Item -ItemType Directory -Force -Path $logs,$work | Out-Null

# (scenario, forcedStatus, label)
$cases = @(
  @("minimal","401","status-401"),
  @("minimal","404","status-404"),
  @("minimal","429","status-429"),
  @("minimal","500","status-500"),
  @("sse_error","","sse-error-event"),
  @("sse_failed","","sse-failed-event"),
  @("sse_incomplete","","sse-incomplete-event")
)
foreach ($c in $cases) {
  $sc = $c[0]; $st = $c[1]; $label = $c[2]
  $env:GW_SCENARIO = $sc; $env:GW_PORT = "$Port"; $env:GW_KEEP_LOG = "0"; $env:GW_STATUS = $st
  $gw = Start-Process -FilePath $py -ArgumentList @((Join-Path $cap "gateway.py")) -NoNewWindow -PassThru `
          -RedirectStandardOutput (Join-Path $logs "$label.server.out.txt") `
          -RedirectStandardError  (Join-Path $logs "$label.server.err.txt")
  Start-Sleep -Milliseconds 1200
  $env:CODEX_HOME = $home_
  $cOut = Join-Path $logs "$label.codex.out.txt"; $cErr = Join-Path $logs "$label.codex.err.txt"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $bin -ArgumentList @("exec","--skip-git-repo-check","-s","read-only","--color","never",'"hi"') `
        -WorkingDirectory $work -NoNewWindow -Wait -PassThru -RedirectStandardOutput $cOut -RedirectStandardError $cErr
  $sw.Stop()
  if (-not $gw.HasExited) { Stop-Process -Id $gw.Id -Force }
  Start-Sleep -Milliseconds 500
  $capf = Join-Path $cap "capture.jsonl"
  $n = 0
  if (Test-Path $capf) { Copy-Item $capf (Join-Path $logs "$label.capture.jsonl") -Force; $n = (Get-Content $capf).Count }
  Write-Host "`n=============== $label  exit=$($p.ExitCode)  requests=$n  elapsed=$([math]::Round($sw.Elapsed.TotalSeconds,1))s ==============="
  Get-Content $cErr -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|error|Reconnect|stream|unexpected|failed|Incomplete' } | Select-Object -First 8 | ForEach-Object { Write-Host "   $_" }
  $so = Get-Content $cOut -ErrorAction SilentlyContinue
  if ($so) { Write-Host "   STDOUT: $($so -join ' / ')" }
}
$env:GW_STATUS = ""
