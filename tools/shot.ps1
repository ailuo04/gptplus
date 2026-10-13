# 抓取整个虚拟桌面到 PNG（纯 GDI），用于快速确认屏幕上到底显示了什么。
# 用法: pwsh -File tools/shot.ps1 -Out probe\screen.png
param([Parameter(Mandatory = $true)][string]$Out)

$sig = @'
using System;
using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

  [DllImport("gdiplus.dll")] public static extern int GdiplusStartup(out IntPtr token, ref SI input, IntPtr output);
  [DllImport("gdiplus.dll")] public static extern void GdiplusShutdown(IntPtr token);
  [DllImport("gdiplus.dll")] public static extern int GdipCreateBitmapFromHBITMAP(IntPtr hbm, IntPtr hpal, out IntPtr bmp);
  [DllImport("gdiplus.dll")] public static extern int GdipSaveImageToFile(IntPtr img, string file, ref Guid clsid, IntPtr params_);
  [DllImport("gdiplus.dll")] public static extern int GdipDisposeImage(IntPtr img);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SI { public int GdiplusVersion; public IntPtr cb; public int a; public int b; }

  public static string Run(string file, int x, int y, int w, int h) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(screen);
    IntPtr hbm = CreateCompatibleBitmap(screen, w, h);
    IntPtr old = SelectObject(mem, hbm);
    bool ok = BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020);
    IntPtr token; SI si = new SI(); si.GdiplusVersion = 1;
    int st = GdiplusStartup(out token, ref si, IntPtr.Zero);
    if (st != 0) return "GdiplusStartup=" + st;
    IntPtr img;
    int c = GdipCreateBitmapFromHBITMAP(hbm, IntPtr.Zero, out img);
    Guid png = new Guid("557cf406-1a04-11d3-9a73-0000f81ef32e");
    int s = GdipSaveImageToFile(img, file, ref png, IntPtr.Zero);
    GdipDisposeImage(img); GdiplusShutdown(token);
    SelectObject(mem, old); DeleteObject(hbm); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
    return "blit=" + ok + " create=" + c + " save=" + s + " size=" + w + "x" + h;
  }
}
'@
if (-not ("Shot" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
[void][Shot]::SetProcessDPIAware()

$vw = [Shot]::GetSystemMetrics(78)
$vh = [Shot]::GetSystemMetrics(79)
$vx = [Shot]::GetSystemMetrics(76)
$vy = [Shot]::GetSystemMetrics(77)
Write-Host "virtual desktop: $vx,$vy ${vw}x${vh}"

$dir = Split-Path -Parent $Out
if (-not $dir) { $dir = '.' }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$full = (Resolve-Path -LiteralPath $dir).Path + '\' + (Split-Path -Leaf $Out)
$res = [Shot]::Run($full, $vx, $vy, $vw, $vh)
Write-Host "result: $res -> $full"
