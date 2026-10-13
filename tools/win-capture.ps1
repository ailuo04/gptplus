# 捕获指定窗口为 PNG（纯 GDI，不依赖 System.Drawing 程序集）。
# 用法: pwsh -File tools/win-capture.ps1 -Match ChatGPT -Out probe\chatgpt.png [-Focus] [-ListOnly]
param(
  [string]$Match = '',
  [string]$Out,
  [switch]$Focus,
  [switch]$ListOnly
)

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class GdiCap {
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
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);

  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

  [DllImport("gdiplus.dll")] public static extern int GdiplusStartup(out IntPtr token, ref StartupInput input, IntPtr output);
  [DllImport("gdiplus.dll")] public static extern void GdiplusShutdown(IntPtr token);
  [DllImport("gdiplus.dll")] public static extern int GdipCreateBitmapFromHBITMAP(IntPtr hbm, IntPtr hpal, out IntPtr bitmap);
  [DllImport("gdiplus.dll")] public static extern int GdipSaveImageToFile(IntPtr image, string filename, ref Guid clsid, IntPtr encoderParams);
  [DllImport("gdiplus.dll")] public static extern int GdipDisposeImage(IntPtr image);
  [DllImport("gdiplus.dll")] public static extern int GdipGetImageWidth(IntPtr image, out int w);
  [DllImport("gdiplus.dll")] public static extern int GdipGetImageHeight(IntPtr image, out int h);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct StartupInput {
    public int GdiplusVersion;
    public IntPtr DebugEventCallback;
    public int SuppressBackgroundThread;
    public int SuppressExternalCodecs;
  }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

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

  public static bool FocusWindow(IntPtr h) { ShowWindow(h, 9); return SetForegroundWindow(h); }

  // 截图：先用 PrintWindow 抓窗口内容（可后台窗口），失败则从屏幕拷贝。
  public static string Capture(IntPtr hwnd, string file) {
    RECT r;
    if (!GetWindowRect(hwnd, out r)) return "GetWindowRect failed";
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return "bad window size " + w + "x" + hh;

    IntPtr screenDc = CreateCompatibleDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr hbm = CreateCompatibleBitmap(screenDc, w, hh);
    IntPtr old = SelectObject(memDc, hbm);

    bool printed = PrintWindow(hwnd, memDc, 2);
    // PrintWindow 对 Chromium 窗口可能返回全黑/空图；再用 BitBlt 直接从屏幕抓一次覆盖。
    IntPtr deskDc = GetDC(IntPtr.Zero);
    bool blitted = BitBlt(memDc, 0, 0, w, hh, deskDc, r.Left, r.Top, 0x00CC0020);
    ReleaseDC(IntPtr.Zero, deskDc);
    if (!blitted && !printed) {
      SelectObject(memDc, old); DeleteObject(hbm); DeleteDC(memDc); DeleteDC(screenDc);
      return "both PrintWindow and BitBlt failed";
    }

    IntPtr token;
    var si = new StartupInput(); si.GdiplusVersion = 1;
    if (GdiplusStartup(out token, ref si, IntPtr.Zero) != 0) return "GdiplusStartup failed";

    IntPtr img;
    int st = GdipCreateBitmapFromHBITMAP(hbm, IntPtr.Zero, out img);
    if (st != 0) { GdiplusShutdown(token); SelectObject(memDc, old); DeleteObject(hbm); DeleteDC(memDc); DeleteDC(screenDc); return "GdipCreateBitmapFromHBITMAP " + st; }

    Guid clsid = new Guid("557cf406-1a04-11d3-9a73-0000f81ef32e"); // PNG encoder
    int sv = GdipSaveImageToFile(img, file, ref clsid, IntPtr.Zero);
    int iw, ih; GdipGetImageWidth(img, out iw); GdipGetImageHeight(img, out ih);
    GdipDisposeImage(img);
    GdiplusShutdown(token);
    SelectObject(memDc, old); DeleteObject(hbm); DeleteDC(memDc); DeleteDC(screenDc);
    if (sv != 0) return "GdipSaveImageToFile " + sv;
    return "ok " + iw + "x" + ih + " printwindow=" + printed;
  }
}
'@
if (-not ("GdiCap" -as [type])) { Add-Type -TypeDefinition $sig -Language CSharp }
[void][GdiCap]::SetProcessDPIAware()

$all = [GdiCap]::List()
if ($ListOnly) { $all | ForEach-Object { Write-Host $_ }; exit 0 }

$best = $null
foreach ($w in $all) {
  $parts = $w -split '\|', 4
  if ($parts[3] -notmatch $Match) { continue }
  $rect = $parts[2] -split ','
  $area = [int]$rect[2] * [int]$rect[3]
  if (-not $best -or $area -gt $best.Area) {
    $best = [pscustomobject]@{ Handle = [IntPtr][int64]$parts[0]; Class = $parts[1]; Title = $parts[3]; Area = $area }
  }
}
if (-not $best) { Write-Error "no visible window matching '$Match'"; exit 2 }

Write-Host ("target: hwnd={0} class={1} title={2}" -f $best.Handle, $best.Class, $best.Title)
if ($Focus) { [void][GdiCap]::FocusWindow($best.Handle); Start-Sleep -Milliseconds 1200 }
if (-not $Out) { exit 0 }

$dir = Split-Path -Parent $Out
if (-not $dir) { $dir = '.' }
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$full = (Resolve-Path -LiteralPath $dir).Path + '\' + (Split-Path -Leaf $Out)
$res = [GdiCap]::Capture($best.Handle, $full)
Write-Host ("capture: {0} -> {1}" -f $res, $full)
if ($res -notlike 'ok*') { exit 3 }
