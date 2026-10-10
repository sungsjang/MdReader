using System.Runtime.InteropServices;

namespace MdReader;

internal static class Native
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    public const int SHCNE_ASSOCCHANGED = 0x08000000;

    /// <summary>Windows 10 1809+/11 의 어두운 제목 표시줄</summary>
    public static void SetDarkTitleBar(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero) return;
        int v = dark ? 1 : 0;
        if (DwmSetWindowAttribute(hwnd, 20, ref v, sizeof(int)) != 0)
            DwmSetWindowAttribute(hwnd, 19, ref v, sizeof(int)); // 구버전 Windows 10
    }

    /// <summary>Windows 앱 테마가 어두운지 (레지스트리)</summary>
    public static bool SystemUsesDarkTheme()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int i && i == 0;
        }
        catch { return false; }
    }
}
