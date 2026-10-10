using System.IO;
using System.Text.Json;

namespace MdReader;

/// <summary>%APPDATA%\MdReader\settings.json 에 저장되는 사용자 설정</summary>
public sealed class AppSettings
{
    public static string Dir { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "MdReader");

    static string FilePath => Path.Combine(Dir, "settings.json");

    public string Theme { get; set; } = "system";        // light | dark | system
    public double Zoom { get; set; } = 1.0;
    public bool SidebarVisible { get; set; } = true;
    public string SidebarPane { get; set; } = "files";   // files | search | toc | backlinks
    public double SidebarWidth { get; set; } = 260;
    public bool CssSnippets { get; set; } = true;
    public bool RestoreSession { get; set; } = true;
    public List<string> OpenTabs { get; set; } = new();
    public int ActiveTab { get; set; }

    public double Width { get; set; } = 1180;
    public double Height { get; set; } = 840;
    public double? Left { get; set; }
    public double? Top { get; set; }
    public bool Maximized { get; set; }
    public List<string> Recent { get; set; } = new();

    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();
        }
        catch { /* 손상된 설정은 무시 */ }
        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Json));
        }
        catch { /* 저장 실패는 치명적이지 않음 */ }
    }

    public void AddRecent(string path)
    {
        Recent.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        Recent.Insert(0, path);
        if (Recent.Count > 15) Recent.RemoveRange(15, Recent.Count - 15);
    }
}
