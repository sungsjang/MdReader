using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MdReader;

public sealed record BacklinkItem(string Path, string Rel, string Name, string[] Lines);
public sealed record SearchLine(int N, string Text);
public sealed record SearchItem(string Path, string Rel, string Name, bool NameMatch, int Count, SearchLine[] Lines);
public sealed record SearchResult(SearchItem[] Items, bool Truncated, int Scanned);

/// <summary>
/// 볼트(또는 일반 폴더)의 파일 목록을 들고 있다가 Obsidian 방식으로 링크를 해석한다.
/// - 상위 폴더 중 .obsidian 폴더가 있는 곳을 볼트 루트로 본다.
/// - [[이름]] 은 상대 경로 → 루트 기준 경로 → 파일 이름 검색 순으로 찾는다.
/// - 같은 이름이 여러 개면 현재 노트와 같은 폴더 → 가장 짧은 경로를 고른다.
/// 또한 백링크·전체 검색을 위해 노트 내용을 캐시한다(수정 시각으로 변경 감지).
/// </summary>
public sealed class VaultIndex
{
    const int MaxFiles = 50_000;
    const int MaxDepthPlainFolder = 3;
    const long MaxCachedChars = 60_000_000;       // 약 120MB
    const long MaxCachedFileBytes = 2 * 1024 * 1024;
    const int MaxSearchResults = 200;
    const int MaxLinesPerResult = 5;

    static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", "$RECYCLE.BIN", "System Volume Information"
    };

    readonly object _gate = new();
    Dictionary<string, List<string>> _byName = new(StringComparer.OrdinalIgnoreCase);
    List<string> _relative = new();
    List<string> _all = new();

    public string Root { get; }
    public bool IsVault { get; }
    public string HostName { get; }
    public string Name => IsVault ? new DirectoryInfo(Root).Name : "";
    public int Version { get; private set; }

    public VaultIndex(string root, bool isVault, string hostName)
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        IsVault = isVault;
        HostName = hostName;
        Rebuild();
    }

    /// <summary>파일이 속한 볼트 루트(.obsidian 이 있는 폴더)를 찾는다. 없으면 null.</summary>
    public static string? FindVaultRoot(string startDir)
    {
        var dir = new DirectoryInfo(startDir);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, ".obsidian"))) return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    public static string NormalizeRoot(string root) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));

    public IReadOnlyList<string> RelativePaths
    {
        get { lock (_gate) return _relative.ToArray(); }
    }

    // ───────────────────────── 파일 목록 ─────────────────────────

    public void Rebuild()
    {
        var byName = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        var rel = new List<string>();
        var all = new List<string>();
        int maxDepth = IsVault ? int.MaxValue : MaxDepthPlainFolder;

        var stack = new Stack<(string dir, int depth)>();
        stack.Push((Root, 0));
        while (stack.Count > 0 && all.Count < MaxFiles)
        {
            var (dir, depth) = stack.Pop();
            try
            {
                foreach (var f in Directory.EnumerateFiles(dir))
                {
                    var name = Path.GetFileName(f);
                    if (name.StartsWith('.')) continue;
                    if (!byName.TryGetValue(name, out var list)) byName[name] = list = new List<string>(1);
                    list.Add(f);
                    all.Add(f);
                    rel.Add(Path.GetRelativePath(Root, f).Replace('\\', '/'));
                    if (all.Count >= MaxFiles) break;
                }
                if (depth >= maxDepth) continue;
                foreach (var d in Directory.EnumerateDirectories(dir))
                {
                    var name = Path.GetFileName(d);
                    if (name.StartsWith('.') || SkipDirs.Contains(name)) continue;
                    if ((File.GetAttributes(d) & FileAttributes.ReparsePoint) != 0) continue; // 링크 순환 방지
                    stack.Push((d, depth + 1));
                }
            }
            catch (UnauthorizedAccessException) { }
            catch (IOException) { }
        }

        lock (_gate)
        {
            _byName = byName;
            _relative = rel;
            _all = all;
            Version++;
        }
    }

    public bool Contains(string fullPath) =>
        fullPath.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    public string ToRelative(string fullPath) => Path.GetRelativePath(Root, fullPath).Replace('\\', '/');

    public string? FromRelative(string rel)
    {
        try
        {
            var full = Path.GetFullPath(Path.Combine(Root, rel.Replace('/', Path.DirectorySeparatorChar)));
            return Contains(full) && File.Exists(full) ? full : null;
        }
        catch { return null; }
    }

    // ───────────────────────── 링크 해석 ─────────────────────────

    /// <summary>위키링크/임베드 대상 해석. 찾지 못하면 null.</summary>
    public string? ResolveLink(string link, string fromDir)
    {
        link = link.Trim().Replace('\\', '/').TrimStart('/');
        if (link.Length == 0) return null;

        var forms = link.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            ? new[] { link }
            : new[] { link + ".md", link };

        foreach (var f in forms)
        {
            var p = TryFile(fromDir, f) ?? TryFile(Root, f);
            if (p != null) return p;
        }

        foreach (var f in forms)
        {
            var name = Path.GetFileName(f);
            List<string>? candidates;
            lock (_gate) _byName.TryGetValue(name, out candidates);
            if (candidates == null || candidates.Count == 0) continue;

            IEnumerable<string> pool = candidates;
            if (f.Contains('/'))
            {
                var suffix = "/" + f;
                var filtered = candidates.Where(c => ("/" + ToRelative(c)).EndsWith(suffix, StringComparison.OrdinalIgnoreCase)).ToList();
                if (filtered.Count == 0) continue;
                pool = filtered;
            }

            return pool
                .OrderBy(c => string.Equals(Path.GetDirectoryName(c), fromDir, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenBy(c => c.Length)
                .First();
        }
        return null;
    }

    /// <summary>표준 마크다운 링크/이미지(상대 경로) 해석. 실패하면 볼트 이름 검색으로 대체.</summary>
    public string? ResolveRelative(string href, string fromDir)
    {
        href = href.Trim();
        if (href.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            try { var lp = new Uri(href).LocalPath; return File.Exists(lp) ? lp : null; }
            catch { return null; }
        }
        var direct = TryFile(fromDir, href);
        if (direct != null) return direct;
        if (Path.IsPathRooted(href) && File.Exists(href)) return href;
        return ResolveLink(href, fromDir);
    }

    static string? TryFile(string baseDir, string rel)
    {
        try
        {
            var full = Path.GetFullPath(Path.Combine(baseDir, rel.Replace('/', Path.DirectorySeparatorChar)));
            return File.Exists(full) ? full : null;
        }
        catch { return null; }
    }

    // ───────────────────────── CSS 스니펫 ─────────────────────────

    /// <summary>.obsidian/appearance.json 에서 켜 둔 CSS 스니펫을 이어 붙여 돌려준다.</summary>
    public string? GetSnippetCss()
    {
        if (!IsVault) return null;
        try
        {
            var obs = Path.Combine(Root, ".obsidian");
            var appearance = Path.Combine(obs, "appearance.json");
            if (!File.Exists(appearance)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(appearance));
            if (!doc.RootElement.TryGetProperty("enabledCssSnippets", out var list) || list.ValueKind != JsonValueKind.Array)
                return null;
            var sb = new StringBuilder();
            foreach (var item in list.EnumerateArray())
            {
                var name = item.GetString();
                if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) continue;
                var file = Path.Combine(obs, "snippets", name + ".css");
                if (!File.Exists(file)) continue;
                sb.Append("/* snippet: ").Append(name).Append(" */\n").Append(File.ReadAllText(file)).Append('\n');
                if (sb.Length > 1_000_000) break;
            }
            return sb.Length > 0 ? sb.ToString() : null;
        }
        catch { return null; }
    }

    // ───────────────────────── 내용 색인 (백링크·검색) ─────────────────────────

    sealed class LinkRef
    {
        public required string Raw { get; init; }
        public required bool Markdown { get; init; }   // [x](y.md) 형식
        public required string Snippet { get; init; }
        public string? Resolved { get; set; }
    }

    sealed class NoteData
    {
        public DateTime Mtime;
        public long Size;
        public string? Text;                 // 캐시 한도 안이면 보관
        public List<LinkRef> Links = new();
        public HashSet<string> Tags = new(StringComparer.OrdinalIgnoreCase);
        public int ResolvedVersion = -1;
    }

    readonly SemaphoreSlim _contentGate = new(1, 1);
    readonly Dictionary<string, NoteData> _notes = new(StringComparer.OrdinalIgnoreCase);
    long _cachedChars;

    static readonly Regex WikiRe = new(@"!?\[\[([^\[\]\|#\^\r\n]+?)(?:[#\^][^\[\]\|\r\n]*)?(?:\\?\|[^\[\]\r\n]*)?\]\]", RegexOptions.Compiled);
    static readonly Regex MdLinkRe = new(@"\]\(\s*<?([^()<>\r\n]+?\.(?:md|markdown))(?:#[^()<>\r\n]*)?>?\s*\)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    static readonly Regex TagRe = new(@"(?<=^|[\s(])#([\p{L}\p{N}\p{M}_\-/]*[\p{L}\p{M}_\-/][\p{L}\p{N}\p{M}_\-/]*)", RegexOptions.Compiled | RegexOptions.Multiline);
    static readonly Regex InlineCodeRe = new(@"`[^`\n]*`", RegexOptions.Compiled);
    static readonly Regex TermRe = new(@"""([^""]+)""|(\S+)", RegexOptions.Compiled);

    /// <summary>바뀐 노트만 다시 읽는다. 백그라운드 스레드에서 호출할 것.</summary>
    void RefreshContent(CancellationToken ct)
    {
        string[] files;
        int version;
        lock (_gate) { files = _all.Where(TextFile.IsMarkdown).ToArray(); version = Version; }

        var seen = new HashSet<string>(files, StringComparer.OrdinalIgnoreCase);
        foreach (var gone in _notes.Keys.Where(k => !seen.Contains(k)).ToList())
        {
            _cachedChars -= _notes[gone].Text?.Length ?? 0;
            _notes.Remove(gone);
        }

        foreach (var f in files)
        {
            ct.ThrowIfCancellationRequested();
            FileInfo fi;
            try { fi = new FileInfo(f); if (!fi.Exists) continue; } catch { continue; }

            if (!_notes.TryGetValue(f, out var nd) || nd.Mtime != fi.LastWriteTimeUtc || nd.Size != fi.Length)
            {
                string text;
                try { text = TextFile.Read(f); } catch { continue; }
                if (nd != null) _cachedChars -= nd.Text?.Length ?? 0;
                nd = new NoteData { Mtime = fi.LastWriteTimeUtc, Size = fi.Length };
                if (fi.Length <= MaxCachedFileBytes && _cachedChars + text.Length <= MaxCachedChars)
                {
                    nd.Text = text;
                    _cachedChars += text.Length;
                }
                Parse(nd, text);
                _notes[f] = nd;
            }

            if (nd.ResolvedVersion != version)
            {
                var dir = Path.GetDirectoryName(f)!;
                foreach (var l in nd.Links)
                {
                    var raw = l.Markdown ? SafeUnescape(l.Raw) : l.Raw;
                    l.Resolved = l.Markdown ? ResolveRelative(raw, dir) : ResolveLink(raw, dir);
                }
                nd.ResolvedVersion = version;
            }
        }
    }

    static string SafeUnescape(string s)
    {
        try { return Uri.UnescapeDataString(s); } catch { return s; }
    }

    static void Parse(NoteData nd, string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        int bodyStart = ParseFrontmatterTags(lines, nd.Tags);

        bool inFence = false;
        string fence = "";
        for (int i = bodyStart; i < lines.Length; i++)
        {
            var line = lines[i];
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("```") || trimmed.StartsWith("~~~"))
            {
                var mark = trimmed[..3];
                if (!inFence) { inFence = true; fence = mark; continue; }
                if (trimmed.StartsWith(fence)) { inFence = false; continue; }
            }
            if (inFence) continue;

            var scan = InlineCodeRe.Replace(line, m => new string(' ', m.Length));
            if (scan.IndexOf("[[", StringComparison.Ordinal) >= 0 || scan.IndexOf("](", StringComparison.Ordinal) >= 0)
            {
                string snippet = Clip(line.Trim(), 0, 220);
                foreach (Match m in WikiRe.Matches(scan))
                    nd.Links.Add(new LinkRef { Raw = m.Groups[1].Value.TrimEnd('\\').Trim(), Markdown = false, Snippet = snippet });
                foreach (Match m in MdLinkRe.Matches(scan))
                {
                    var target = m.Groups[1].Value.Trim();
                    if (target.Contains("://")) continue;
                    nd.Links.Add(new LinkRef { Raw = target, Markdown = true, Snippet = snippet });
                }
            }
            if (scan.IndexOf('#') >= 0)
                foreach (Match m in TagRe.Matches(scan)) nd.Tags.Add(m.Groups[1].Value.TrimEnd('/'));
        }
    }

    /// <summary>프론트매터의 tags 를 읽고 본문 시작 줄 번호를 돌려준다.</summary>
    static int ParseFrontmatterTags(string[] lines, HashSet<string> tags)
    {
        if (lines.Length == 0 || lines[0].Trim() != "---") return 0;
        int end = -1;
        for (int i = 1; i < lines.Length; i++)
            if (lines[i].Trim() is "---" or "...") { end = i; break; }
        if (end < 0) return 0;

        for (int i = 1; i < end; i++)
        {
            var m = Regex.Match(lines[i], @"^(tags?)\s*:\s*(.*)$", RegexOptions.IgnoreCase);
            if (!m.Success) continue;
            var rest = m.Groups[2].Value.Trim();
            if (rest.Length > 0)
            {
                foreach (var t in rest.Trim('[', ']').Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                    AddTag(tags, t);
            }
            else
            {
                for (int j = i + 1; j < end; j++)
                {
                    var item = Regex.Match(lines[j], @"^\s*-\s*(.+)$");
                    if (!item.Success) break;
                    AddTag(tags, item.Groups[1].Value);
                }
            }
        }
        return end + 1;
    }

    static void AddTag(HashSet<string> tags, string raw)
    {
        var t = raw.Trim().Trim('"', '\'').TrimStart('#').Trim();
        if (t.Length > 0) tags.Add(t);
    }

    static string Clip(string s, int focus, int max)
    {
        if (s.Length <= max) return s;
        int start = Math.Max(0, Math.Min(focus - max / 3, s.Length - max));
        var part = s.Substring(start, Math.Min(max, s.Length - start));
        return (start > 0 ? "…" : "") + part + (start + max < s.Length ? "…" : "");
    }

    /// <summary>target 노트를 가리키는 다른 노트 목록</summary>
    public List<BacklinkItem> GetBacklinks(string target, CancellationToken ct = default)
    {
        _contentGate.Wait(ct);
        try
        {
            RefreshContent(ct);
            var list = new List<BacklinkItem>();
            foreach (var (path, nd) in _notes)
            {
                if (string.Equals(path, target, StringComparison.OrdinalIgnoreCase)) continue;
                var lines = nd.Links
                    .Where(l => l.Resolved != null && string.Equals(l.Resolved, target, StringComparison.OrdinalIgnoreCase))
                    .Select(l => l.Snippet).Distinct().Take(MaxLinesPerResult).ToArray();
                if (lines.Length == 0) continue;
                list.Add(new BacklinkItem(path, ToRelative(path), Path.GetFileNameWithoutExtension(path), lines));
            }
            return list.OrderBy(b => b.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        }
        finally { _contentGate.Release(); }
    }

    /// <summary>
    /// 볼트 전체 검색. 공백으로 나눈 모든 단어가 들어 있는 노트를 찾는다.
    /// "정확한 구절", #태그 / tag:태그, file:이름 을 지원한다.
    /// </summary>
    public SearchResult Search(string query, CancellationToken ct)
    {
        var textTerms = new List<string>();
        var tagTerms = new List<string>();
        var fileTerms = new List<string>();
        foreach (Match m in TermRe.Matches(query))
        {
            var t = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
            if (t.Length == 0) continue;
            if (t.StartsWith("tag:", StringComparison.OrdinalIgnoreCase) && t.Length > 4) tagTerms.Add(t[4..].TrimStart('#'));
            else if (t.StartsWith('#') && t.Length > 1 && !m.Groups[1].Success) tagTerms.Add(t[1..]);
            else if (t.StartsWith("file:", StringComparison.OrdinalIgnoreCase) && t.Length > 5) fileTerms.Add(t[5..]);
            else textTerms.Add(t);
        }
        if (textTerms.Count + tagTerms.Count + fileTerms.Count == 0) return new SearchResult(Array.Empty<SearchItem>(), false, 0);

        _contentGate.Wait(ct);
        try
        {
            RefreshContent(ct);
            var results = new List<SearchItem>();
            int scanned = 0;
            foreach (var (path, nd) in _notes)
            {
                ct.ThrowIfCancellationRequested();
                scanned++;
                var name = Path.GetFileNameWithoutExtension(path);
                if (!fileTerms.All(f => name.Contains(f, StringComparison.OrdinalIgnoreCase))) continue;
                if (!tagTerms.All(t => nd.Tags.Any(x => x.Equals(t, StringComparison.OrdinalIgnoreCase) ||
                                                         x.StartsWith(t + "/", StringComparison.OrdinalIgnoreCase)))) continue;

                bool nameMatch = textTerms.Count > 0 && textTerms.All(t => name.Contains(t, StringComparison.OrdinalIgnoreCase));
                string? text = null;
                if (textTerms.Count > 0 || tagTerms.Count > 0)
                {
                    text = nd.Text;
                    if (text == null) { try { text = TextFile.Read(path); } catch { continue; } }
                }
                if (!nameMatch && textTerms.Count > 0 &&
                    !textTerms.All(t => text!.Contains(t, StringComparison.OrdinalIgnoreCase) || name.Contains(t, StringComparison.OrdinalIgnoreCase)))
                    continue;

                var lines = new List<SearchLine>();
                int count = 0;
                if (text != null)
                {
                    var needles = textTerms.Concat(tagTerms.Select(t => "#" + t)).ToArray();
                    var split = text.Split('\n');
                    for (int i = 0; i < split.Length; i++)
                    {
                        var line = split[i].TrimEnd('\r');
                        int first = -1;
                        foreach (var n in needles)
                        {
                            int idx = line.IndexOf(n, StringComparison.OrdinalIgnoreCase);
                            while (idx >= 0)
                            {
                                count++;
                                if (first < 0 || idx < first) first = idx;
                                idx = line.IndexOf(n, idx + n.Length, StringComparison.OrdinalIgnoreCase);
                            }
                        }
                        if (first >= 0 && lines.Count < MaxLinesPerResult)
                        {
                            var trimmed = line.TrimStart();
                            lines.Add(new SearchLine(i + 1, Clip(trimmed, first - (line.Length - trimmed.Length), 180)));
                        }
                    }
                }
                results.Add(new SearchItem(path, ToRelative(path), name, nameMatch, count, lines.ToArray()));
            }

            var ordered = results
                .OrderByDescending(r => r.NameMatch)
                .ThenByDescending(r => r.Count)
                .ThenBy(r => r.Name, StringComparer.CurrentCultureIgnoreCase)
                .ToList();
            return new SearchResult(ordered.Take(MaxSearchResults).ToArray(), ordered.Count > MaxSearchResults, scanned);
        }
        finally { _contentGate.Release(); }
    }
}
