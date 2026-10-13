# auth-matrix.ps1 - probe how each auth config maps to HTTP headers
param([int]$Port = 10199)
$py  = "C:\Users\ailuo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$bin = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe"
$cap = "C:\ailuo_own\gpt++\research\capture"
$work = Join-Path $cap "work"
$logs = Join-Path $cap "logs"; New-Item -ItemType Directory -Force -Path $logs,$work | Out-Null

$variants = [ordered]@{
  "auth-none" = @"
model = "capture-model"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Capture Gateway"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
requires_openai_auth = false
"@
  "auth-envkey" = @"
model = "capture-model"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Capture Gateway"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
env_key = "MY_LOCAL_KEY"
requires_openai_auth = false
"@
  "auth-envkey-no-roa" = @"
model = "capture-model"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Capture Gateway"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
env_key = "MY_LOCAL_KEY"
"@
  "auth-bearer" = @"
model = "capture-model"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Capture Gateway"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
experimental_bearer_token = "secret-token-abc123"
requires_openai_auth = false
"@
  "auth-httpheaders" = @"
model = "capture-model"
model_provider = "localgw"
[model_providers.localgw]
name = "Local Capture Gateway"
base_url = "http://127.0.0.1:$Port/v1"
wire_api = "responses"
requires_openai_auth = false
http_headers = { "X-Custom-Static" = "static-value" }
env_http_headers = { "X-Custom-Env" = "MY_LOCAL_KEY" }
query_params = { "api-version" = "2025-04-01-preview" }
"@
}

foreach ($k in $variants.Keys) {
  $home_ = Join-Path $cap "homes\$k"
  New-Item -ItemType Directory -Force -Path $home_ | Out-Null
  Set-Content -Path (Join-Path $home_ "config.toml") -Value $variants[$k] -Encoding UTF8

  $env:GW_SCENARIO = "minimal"; $env:GW_PORT = "$Port"; $env:GW_KEEP_LOG = "0"
  $gw = Start-Process -FilePath $py -ArgumentList @((Join-Path $cap "gateway.py")) -NoNewWindow -PassThru `
          -RedirectStandardOutput (Join-Path $logs "$k.server.out.txt") `
          -RedirectStandardError  (Join-Path $logs "$k.server.err.txt")
  Start-Sleep -Milliseconds 1100

  $env:CODEX_HOME = $home_
  $env:MY_LOCAL_KEY = "env-key-value-xyz"
  $cOut = Join-Path $logs "$k.codex.out.txt"; $cErr = Join-Path $logs "$k.codex.err.txt"
  $p = Start-Process -FilePath $bin -ArgumentList @("exec","--skip-git-repo-check","-s","read-only","--color","never",'"hi"') `
        -WorkingDirectory $work -NoNewWindow -Wait -PassThru -RedirectStandardOutput $cOut -RedirectStandardError $cErr
  Start-Sleep -Milliseconds 300
  if (-not $gw.HasExited) { Stop-Process -Id $gw.Id -Force }
  Start-Sleep -Milliseconds 400

  Write-Host "`n=============== VARIANT: $k   exit=$($p.ExitCode) ==============="
  $capf = Join-Path $cap "capture.jsonl"
  if (Test-Path $capf) {
    Copy-Item $capf (Join-Path $logs "$k.capture.jsonl") -Force
    foreach ($l in (Get-Content $capf)) {
      $o = $l | ConvertFrom-Json
      Write-Host ("  {0} {1}" -f $o.method, $o.path)
      $o.headers.PSObject.Properties | Where-Object {
        $_.Name -match '^(authorization|api-key|x-custom|originator|accept|content-type|x-codex|session-id|thread-id|x-client-request-id)'
      } | ForEach-Object { Write-Host ("     {0}: {1}" -f $_.Name, ($_.Value -join ' | ')) }
    }
  } else { Write-Host "  (no capture)" }
  $err = Get-Content $cErr -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|error|missing|unauthor|auth' } | Select-Object -First 5
  if ($err) { Write-Host "  --- codex errors ---"; $err | ForEach-Object { Write-Host "     $_" } }
}
