using System.IO;
using System.Text;

namespace MdReader;

internal static class TextFile
{
    static readonly string[] MarkdownExt = { ".md", ".markdown", ".mdown", ".mkd" };

    public static bool IsMarkdown(string path) =>
        MarkdownExt.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    /// <summary>UTF-8(BOM 유무)·UTF-16을 우선, 깨지면 CP949로 읽는다.</summary>
    public static string Read(string path)
    {
        byte[] bytes = File.ReadAllBytes(path);
        if (bytes.Length >= 2 && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF)))
            return new StreamReader(new MemoryStream(bytes), detectEncodingFromByteOrderMarks: true).ReadToEnd();
        try
        {
            return new UTF8Encoding(false, throwOnInvalidBytes: true).GetString(bytes).TrimStart('﻿');
        }
        catch (DecoderFallbackException)
        {
            return Encoding.GetEncoding(949).GetString(bytes);
        }
    }
}
