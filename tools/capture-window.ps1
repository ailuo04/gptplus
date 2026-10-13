# 捕获指定窗口（按标题模糊匹配）为 PNG。
# 用法: pwsh -File tools/capture-window.ps1 -Match ChatGPT -Out probe\chatgpt.png [-Focus] [-Crop "x,y,w,h"] [-ListOnly]
param(
  [Parameter(Mandatory = $true)][string]$Match,
  [string]$Out,
  [switch]$Focus,
  [string]$Crop,
  [switch]$ListOnly
)

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> List() {
    var outp = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 2); GetWindowText(h, sb, sb.Capacity);
      var cn = new StringBuilder(256); GetClassName(h, cn, cn.Capacity);
      RECT r; GetWindowRect(h, out r);
      outp.Add(h.ToInt64() + "|" + cn.ToString() + "|" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return outp;
  }

  public static string RectOf(long hwnd) {
    RECT r;
    if (!GetWindowRect(new IntPtr(hwnd), out r)) return null;
    return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
  }

  public static bool FocusWindow(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    ShowWindow(h, 9);
    return SetForegroundWindow(h);
  }

  public static bool Capture(long hwnd, string file, int cropX, int cropY, int cropW, int cropH) {
    RECT r;
    if (!GetWindowRect(new IntPtr(hwnd), out r)) return false;
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return false;
    if (cropW <= 0) cropW = w - cropX;
    if (cropH <= 0) cropH = hh - cropY;
    if (cropX < 0) cropX = 0;
    if (cropY < 0) cropY = 0;
    if (cropX + cropW > w) cropW = w - cropX;
    if (cropY + cropH > hh) cropH = hh - cropY;
    if (cropW <= 0 || cropH <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(cropW, cropH)) {
      using (var g = System.Drawing.Graphics.FromImage(bmp)) {
        g.CopyFromScreen(r.Left + cropX, r.Top + cropY, 0, 0, new System.Drawing.Size(cropW, cropH));
      }
      bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
}
'@
if (-not ("WinCap" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp -ReferencedAssemblies System.Drawing, System.Drawing.Common }
[void][WinCap]::SetProcessDPIAware()

$all = [WinCap]::List()
if ($ListOnly) { $all | ForEach-Object { Write-Host $_ }; exit 0 }

$best = $null
foreach ($w in $all) {
  $parts = $w -split '\|', 4
  if ($parts[3] -notmatch $Match) { continue }
  $rect = $parts[2] -split ','
  $area = [int]$rect[2] * [int]$rect[3]
  if (-not $best -or $area -gt $best.Area) {
    $best = [pscustomobject]@{ Handle = [int64]$parts[0]; Class = $parts[1]; Title = $parts[3]; Area = $area }
  }
}

if (-not $best) {
  Write-Error "no visible window matching '$Match'"
  $all | ForEach-Object { Write-Host "  available: $_" }
  exit 2
}

Write-Host ("target: hwnd={0} class={1} title={2}" -f $best.Handle, $best.Class, $best.Title)

if ($Focus) {
  [void][WinCap]::FocusWindow($best.Handle)
  Start-Sleep -Milliseconds 900
}

if (-not $Out) { exit 0 }
$cx = 0; $cy = 0; $cw = 0; $ch = 0
if ($Crop) { $c = $Crop -split ','; $cx = [int]$c[0]; $cy = [int]$c[1]; $cw = [int]$c[2]; $ch = [int]$c[3] }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$ok = [WinCap]::Capture($best.Handle, (Resolve-Path -LiteralPath $dir).Path + '\' + (Split-Path -Leaf $Out), $cx, $cy, $cw, $ch)
if (-not $ok) { Write-Error "capture failed"; exit 3 }
Write-Host ("saved: {0} (rect {1})" -f $Out, [WinCap]::RectOf($best.Handle))
