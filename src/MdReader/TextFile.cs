using System.IO;
using System.Text;

namespace MdReader;

/// <summary>읽은 파일의 인코딩·줄바꿈 정보 (저장할 때 그대로 되살린다)</summary>
public sealed record TextFormat(Encoding Encoding, bool Bom, bool Crlf)
{
    public static readonly TextFormat Default = new(new UTF8Encoding(false), false, false);
}

internal static class TextFile
{
    static readonly string[] MarkdownExt = { ".md", ".markdown", ".mdown", ".mkd" };

    public static bool IsMarkdown(string path) =>
        MarkdownExt.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    public static string Read(string path) => ReadDetailed(path).Text;

    /// <summary>UTF-8(BOM 유무)·UTF-16을 우선, 깨지면 CP949로 읽는다.</summary>
    public static (string Text, TextFormat Format) ReadDetailed(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        string text;
        TextFormat fmt;

        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            text = Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
            fmt = new TextFormat(new UnicodeEncoding(false, true), true, false);
        }
        else if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
        {
            text = Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
            fmt = new TextFormat(new UnicodeEncoding(true, true), true, false);
        }
        else
        {
            bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
            int offset = bom ? 3 : 0;
            try
            {
                text = new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes, offset, bytes.Length - offset);
                fmt = new TextFormat(new UTF8Encoding(bom), bom, false);
            }
            catch (DecoderFallbackException)
            {
                var cp949 = Encoding.GetEncoding(949);
                text = cp949.GetString(bytes);
                fmt = new TextFormat(cp949, false, false);
            }
        }

        bool crlf = text.Contains("\r\n");
        return (text, fmt with { Crlf = crlf });
    }

    /// <summary>
    /// 원래 인코딩·BOM·줄바꿈을 유지해 저장한다.
    /// 같은 폴더의 임시 파일에 먼저 쓰고 바꿔치기하므로 저장 중 끊겨도 원본이 깨지지 않는다.
    /// </summary>
    public static void Write(string path, string text, TextFormat fmt)
    {
        text = text.Replace("\r\n", "\n");
        if (fmt.Crlf) text = text.Replace("\n", "\r\n");

        var preamble = fmt.Bom ? fmt.Encoding.GetPreamble() : Array.Empty<byte>();
        var body = fmt.Encoding.GetBytes(text);

        var dir = Path.GetDirectoryName(path)!;
        var tmp = Path.Combine(dir, "." + Path.GetFileName(path) + ".mdreader-tmp");
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(preamble, 0, preamble.Length);
            fs.Write(body, 0, body.Length);
            fs.Flush(true);
        }
        try
        {
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            try { File.Delete(tmp); } catch { }
            throw;
        }
    }
}
