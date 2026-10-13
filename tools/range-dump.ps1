# range-dump.ps1 - print a byte range of a large file as printable ASCII (memory-safe)
param(
  [string]$Path = "C:\Program Files\WindowsApps\OpenAI.Codex_26.930.2377.0_x64__2p2nqsd0c76g0\app\resources\codex.exe",
  [Parameter(Mandatory=$true)][int64]$Start,
  [Parameter(Mandatory=$true)][int64]$End,
  [int]$Wrap = 0
)
$fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
try {
  $len = [Math]::Min($End - $Start, ($fs.Length - $Start))
  if ($len -le 0) { Write-Host "empty range"; return }
  $buf = New-Object byte[] $len
  $fs.Position = $Start
  [void]$fs.Read($buf, 0, $len)
  $sb = New-Object System.Text.StringBuilder
  foreach ($b in $buf) {
    if ($b -ge 32 -and $b -lt 127) { [void]$sb.Append([char]$b) } else { [void]$sb.Append('.') }
  }
  $t = $sb.ToString()
  if ($Wrap -gt 0) {
    for ($i = 0; $i -lt $t.Length; $i += $Wrap) {
      $n = [Math]::Min($Wrap, $t.Length - $i)
      Write-Host ("0x{0:X}: {1}" -f ($Start + $i), $t.Substring($i, $n))
    }
  } else { Write-Host $t }
} finally { $fs.Dispose() }
