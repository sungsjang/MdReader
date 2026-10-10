using Microsoft.Win32;

namespace MdReader;

/// <summary>
/// 현재 사용자(HKCU)에 .md / .markdown '연결 프로그램' 항목을 등록한다.
/// 관리자 권한이 필요 없고, 실제 기본 앱 지정은 Windows 설정에서 사용자가 고른다.
/// </summary>
internal static class FileAssociation
{
    const string ProgId = "MdReader.Markdown";
    static readonly string[] Extensions = { ".md", ".markdown", ".mdown", ".mkd" };

    public static void Register()
    {
        string exe = Environment.ProcessPath ?? throw new InvalidOperationException("실행 파일 경로를 알 수 없습니다.");

        using (var prog = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
        {
            prog.SetValue("", "Markdown 문서");
            prog.SetValue("FriendlyTypeName", "Markdown 문서");
            using (var icon = prog.CreateSubKey("DefaultIcon")) icon.SetValue("", $"\"{exe}\",0");
            using (var cmd = prog.CreateSubKey(@"shell\open\command")) cmd.SetValue("", $"\"{exe}\" \"%1\"");
        }

        using (var app = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\MdReader.exe"))
        {
            app.SetValue("FriendlyAppName", "MdReader");
            using (var cmd = app.CreateSubKey(@"shell\open\command")) cmd.SetValue("", $"\"{exe}\" \"%1\"");
            using var types = app.CreateSubKey("SupportedTypes");
            foreach (var ext in Extensions) types.SetValue(ext, "");
        }

        foreach (var ext in Extensions)
        {
            using var k = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ext}\OpenWithProgids");
            k.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);
        }

        Native.SHChangeNotify(Native.SHCNE_ASSOCCHANGED, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
