# dump-around.ps1 - print ASCII context around byte offsets in a large file (memory-safe)
param(
  [string]$Path = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
  [Parameter(Mandatory=$true)][string]$Pattern,
  [int]$Before = 160,
  [int]$After  = 320,
  [int]$Max    = 60,
  [string]$Rg  = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\rg.exe",
  [switch]$Unique
)
$hits = & $Rg -a --byte-offset --no-line-number -o -m $Max $Pattern $Path
if (-not $hits) { Write-Host "NO MATCHES for $Pattern"; return }
$rows = foreach ($h in $hits) {
  $i = $h.IndexOf(':')
  if ($i -lt 1) { continue }
  [pscustomobject]@{ Off = [int64]$h.Substring(0, $i); Match = $h.Substring($i + 1) }
}
if ($Unique) { $rows = $rows | Group-Object Match | ForEach-Object { $_.Group[0] } }
$fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
try {
  foreach ($r in $rows) {
    $start = [Math]::Max(0, $r.Off - $Before)
    $len   = [Math]::Min($Before + $After, ($fs.Length - $start))
    $buf   = New-Object byte[] $len
    $fs.Position = $start
    [void]$fs.Read($buf, 0, $len)
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $buf) {
      if ($b -ge 32 -and $b -lt 127) { [void]$sb.Append([char]$b) } else { [void]$sb.Append('.') }
    }
    Write-Host ("### off=0x{0:X} ({0})  match={1}" -f $r.Off, $r.Match)
    Write-Host $sb.ToString()
    Write-Host ""
  }
} finally { $fs.Dispose() }
