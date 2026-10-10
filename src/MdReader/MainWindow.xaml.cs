using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace MdReader;

public partial class MainWindow : Window
{
    const string AppHost = "app.mdreader";
    const long MaxInlineFileBytes = 25L * 1024 * 1024;

    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static readonly string[] ViewableExt = { ".md", ".markdown", ".mdown", ".mkd", ".txt" };

    enum OpenMode { Current, NewTab, Auto }

    sealed class DocTab
    {
        public required int Id { get; init; }
        public NavigationHistory History { get; } = new();
        public string? Path => History.Current?.Path;
    }

    readonly AppSettings _settings;
    readonly Debouncer _reloadDebounce;
    readonly Debouncer _indexDebounce;
    readonly Debouncer _saveDebounce;

    readonly List<DocTab> _tabs = new();
    readonly Stack<string> _closedTabs = new();
    DocTab? _active;
    int _tabSeq;

    readonly Dictionary<string, VaultIndex> _vaults = new(StringComparer.OrdinalIgnoreCase);   // 루트 → 색인
    readonly Dictionary<string, FileSystemWatcher> _vaultWatchers = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, int> _sentIndexVersion = new();                                 // 호스트 이름 → 보낸 버전
    int _vaultSeq;

    readonly List<string> _pendingPaths = new();
    FileSystemWatcher? _fileWatcher;
    CancellationTokenSource? _searchCts;
    bool _webReady;

    CoreWebView2 Core => Web.CoreWebView2;

    public MainWindow(string[] paths)
    {
        InitializeComponent();
        _settings = AppSettings.Load();
        _pendingPaths.AddRange(paths);
        _reloadDebounce = new Debouncer(Dispatcher, TimeSpan.FromMilliseconds(250));
        _indexDebounce = new Debouncer(Dispatcher, TimeSpan.FromSeconds(1));
        _saveDebounce = new Debouncer(Dispatcher, TimeSpan.FromSeconds(1));

        RestorePlacement();
        bool dark = _settings.Theme == "dark" || (_settings.Theme == "system" && Native.SystemUsesDarkTheme());
        Web.DefaultBackgroundColor = dark ? System.Drawing.Color.FromArgb(30, 30, 32) : System.Drawing.Color.White;

        SourceInitialized += (_, _) => Native.SetDarkTitleBar(new WindowInteropHelper(this).Handle, dark);
        Loaded += async (_, _) => await InitWebViewAsync();
        Closing += (_, _) => SaveSession();
        Closed += (_, _) =>
        {
            _fileWatcher?.Dispose();
            foreach (var w in _vaultWatchers.Values) w.Dispose();
        };
    }

    // ───────────────────────── 초기화 ─────────────────────────

    async Task InitWebViewAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppSettings.Dir, "WebView2"));
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "Microsoft Edge WebView2 런타임이 필요합니다.\n\nhttps://developer.microsoft.com/microsoft-edge/webview2/ 에서 설치한 뒤 다시 실행하세요.",
                "MdReader", MessageBoxButton.OK, MessageBoxImage.Warning);
            Close();
            return;
        }

        var s = Core.Settings;
#if DEBUG
        s.AreDevToolsEnabled = true;
#else
        s.AreDevToolsEnabled = false;
#endif
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;             // 확대는 페이지에서 직접 처리
        s.AreBrowserAcceleratorKeysEnabled = false; // F5/Ctrl+F/Ctrl+W 등은 페이지가 처리
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;

        var www = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        Core.SetVirtualHostNameToFolderMapping(AppHost, www, CoreWebView2HostResourceAccessKind.Allow);

        Core.WebMessageReceived += OnWebMessage;
        Core.NavigationStarting += OnNavigationStarting;
        Core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        Core.Navigate($"https://{AppHost}/index.html");
    }

    void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (e.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase)) return;
        e.Cancel = true;

        // 창에 파일을 떨어뜨렸을 때 브라우저가 file:// 로 이동하려는 경우
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && uri.IsFile)
        {
            OpenPath(uri.LocalPath, OpenMode.Auto, null);
            return;
        }
        OpenExternal(e.Uri);
    }

    /// <summary>다른 인스턴스(탐색기 더블클릭 등)에서 넘어온 파일</summary>
    public void OpenFromShell(string[] paths)
    {
        foreach (var p in paths) OpenPath(p, OpenMode.Auto, null);
        BringToFront();
    }

    void BringToFront()
    {
        if (WindowState == WindowState.Minimized) WindowState = _settings.Maximized ? WindowState.Maximized : WindowState.Normal;
        Show();
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    // ───────────────────────── 페이지 ↔ 호스트 메시지 ─────────────────────────

    void Post(object message)
    {
        if (Web.CoreWebView2 == null) return;
        Core.PostWebMessageAsJson(JsonSerializer.Serialize(message, JsonOpts));
    }

    void Toast(string text) => Post(new { type = "toast", text });

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase)) return;

        JsonElement msg;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            msg = doc.RootElement.Clone();
        }
        catch { return; }

        // 끌어다 놓기: postMessageWithAdditionalObjects('drop', files)
        if (msg.ValueKind == JsonValueKind.String)
        {
            if (msg.GetString() == "drop" && e.AdditionalObjects != null)
                foreach (var o in e.AdditionalObjects)
                    if (o is CoreWebView2File f) OpenPath(f.Path, OpenMode.Auto, null);
            return;
        }
        if (msg.ValueKind != JsonValueKind.Object || !msg.TryGetProperty("type", out var typeEl)) return;

        string Str(string name) => msg.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        bool Bool(string name) => msg.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        int Int(string name) => msg.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        double? Scroll() => msg.TryGetProperty("scroll", out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;
        OpenMode Mode() => Bool("newTab") ? OpenMode.NewTab : OpenMode.Current;
        string? Find() => Str("find") is { Length: > 0 } f ? f : null;

        try
        {
            switch (typeEl.GetString())
            {
                case "ready": OnPageReady(); break;

                // 탭
                case "newTab": SaveScroll(Scroll()); ActivateTab(AddTab()); break;
                case "closeTab": CloseTab(Int("id"), Scroll()); break;
                case "switchTab": SwitchTab(Int("id"), Scroll()); break;
                case "reopenTab": ReopenClosedTab(Scroll()); break;

                // 문서 열기·이동
                case "open": ShowOpenDialog(Scroll()); break;
                case "openPath": OpenPath(Str("path"), Bool("newTab") ? OpenMode.NewTab : OpenMode.Auto, Scroll(), find: Find()); break;
                case "openRel": OpenRelative(Str("vaultKey"), Str("rel"), Mode(), Scroll(), Find()); break;
                case "reload": ShowActive(keepScroll: true); break;
                case "navigate": NavigateWikiLink(Str("target"), Str("from"), Mode(), Scroll()); break;
                case "navigateHref": NavigateHref(Str("href"), Str("from"), Mode(), Scroll()); break;
                case "external": OpenExternal(Str("url")); break;
                case "resolve": Resolve(Str("id"), Str("target"), Bool("relative"), Str("from")); break;
                case "back": GoHistory(back: true, Scroll()); break;
                case "forward": GoHistory(back: false, Scroll()); break;

                // 사이드바
                case "backlinks": _ = SendBacklinksAsync(Str("reqId")); break;
                case "search": _ = SearchAsync(Str("reqId"), Str("query")); break;

                // 설정·기타
                case "setting": ApplySetting(Str("key"), msg.TryGetProperty("value", out var val) ? val : default); break;
                case "themeApplied":
                    bool dark = Bool("dark");
                    Native.SetDarkTitleBar(new WindowInteropHelper(this).Handle, dark);
                    Web.DefaultBackgroundColor = dark ? System.Drawing.Color.FromArgb(30, 30, 32) : System.Drawing.Color.White;
                    break;
                case "showInFolder":
                    if (_active?.Path is { } cur) Process.Start("explorer.exe", $"/select,\"{cur}\"");
                    break;
                case "openInObsidian": OpenInObsidian(); break;
                case "registerOpenWith":
                    FileAssociation.Register();
                    Toast("등록했습니다. 파일 우클릭 → 연결 프로그램에서 MdReader를 기본 앱으로 고르세요.");
                    break;
            }
        }
        catch (Exception ex)
        {
            Post(new { type = "error", text = ex.Message });
        }
    }

    void OnPageReady()
    {
        _webReady = true;
        Post(new
        {
            type = "settings",
            theme = _settings.Theme,
            zoom = _settings.Zoom,
            sidebarVisible = _settings.SidebarVisible,
            sidebarPane = _settings.SidebarPane,
            sidebarWidth = _settings.SidebarWidth,
            cssSnippets = _settings.CssSnippets,
            restoreSession = _settings.RestoreSession
        });

        if (_tabs.Count == 0 && _settings.RestoreSession)
        {
            foreach (var p in _settings.OpenTabs.Where(File.Exists))
            {
                var t = AddTab();
                t.History.Push(p);
            }
            if (_tabs.Count > 0) _active = _tabs[Math.Clamp(_settings.ActiveTab, 0, _tabs.Count - 1)];
        }

        var pending = _pendingPaths.ToArray();
        _pendingPaths.Clear();
        foreach (var p in pending) OpenPath(p, OpenMode.Auto, null);

        if (_tabs.Count == 0) _active = AddTab();
        _active ??= _tabs[0];
        ShowActive(keepScroll: false);
    }

    void ApplySetting(string key, JsonElement value)
    {
        switch (key)
        {
            case "theme" when value.ValueKind == JsonValueKind.String: _settings.Theme = value.GetString()!; break;
            case "zoom" when value.ValueKind == JsonValueKind.Number: _settings.Zoom = value.GetDouble(); break;
            case "sidebarVisible": _settings.SidebarVisible = value.ValueKind == JsonValueKind.True; break;
            case "sidebarPane" when value.ValueKind == JsonValueKind.String: _settings.SidebarPane = value.GetString()!; break;
            case "sidebarWidth" when value.ValueKind == JsonValueKind.Number: _settings.SidebarWidth = value.GetDouble(); break;
            case "restoreSession": _settings.RestoreSession = value.ValueKind == JsonValueKind.True; break;
            case "cssSnippets":
                _settings.CssSnippets = value.ValueKind == JsonValueKind.True;
                ShowActive(keepScroll: true);
                break;
            default: return;
        }
        _saveDebounce.Trigger(_settings.Save);
    }

    // ───────────────────────── 탭 ─────────────────────────

    DocTab AddTab()
    {
        var tab = new DocTab { Id = ++_tabSeq };
        int at = _active != null ? _tabs.IndexOf(_active) + 1 : _tabs.Count;
        _tabs.Insert(Math.Clamp(at, 0, _tabs.Count), tab);
        return tab;
    }

    void SaveScroll(double? scroll)
    {
        if (scroll.HasValue) _active?.History.SaveScroll(scroll.Value);
    }

    void ActivateTab(DocTab tab)
    {
        _active = tab;
        ShowActive(keepScroll: false);
    }

    void SwitchTab(int id, double? scroll)
    {
        var tab = _tabs.FirstOrDefault(t => t.Id == id);
        if (tab == null || tab == _active) return;
        SaveScroll(scroll);
        ActivateTab(tab);
    }

    void CloseTab(int id, double? scroll)
    {
        var tab = _tabs.FirstOrDefault(t => t.Id == id);
        if (tab == null) return;
        SaveScroll(scroll);
        if (tab.Path != null) _closedTabs.Push(tab.Path);

        int idx = _tabs.IndexOf(tab);
        _tabs.Remove(tab);
        if (_tabs.Count == 0)
        {
            _active = null;
            _active = AddTab();
            ShowActive(keepScroll: false);
        }
        else if (tab == _active)
        {
            ActivateTab(_tabs[Math.Min(idx, _tabs.Count - 1)]);
        }
        else
        {
            PostTabs();
        }
    }

    void ReopenClosedTab(double? scroll)
    {
        while (_closedTabs.Count > 0)
        {
            var p = _closedTabs.Pop();
            if (!File.Exists(p)) continue;
            OpenPath(p, OpenMode.NewTab, scroll);
            return;
        }
    }

    void PostTabs()
    {
        Post(new
        {
            type = "tabs",
            active = _active?.Id,
            tabs = _tabs.Select(t => new
            {
                id = t.Id,
                title = t.Path == null ? "새 탭" : Path.GetFileNameWithoutExtension(t.Path),
                path = t.Path
            })
        });
    }

    void SaveSession()
    {
        SavePlacement();
        _settings.OpenTabs = _tabs.Where(t => t.Path != null).Select(t => t.Path!).ToList();
        var withPath = _tabs.Where(t => t.Path != null).ToList();
        _settings.ActiveTab = _active != null ? Math.Max(0, withPath.IndexOf(_active)) : 0;
        _settings.Save();
    }

    // ───────────────────────── 문서 열기 ─────────────────────────

    void ShowOpenDialog(double? scroll)
    {
        var dlg = new OpenFileDialog
        {
            Title = "마크다운 파일 열기",
            Multiselect = true,
            Filter = "마크다운 (*.md;*.markdown)|*.md;*.markdown;*.mdown;*.mkd|텍스트 (*.txt)|*.txt|모든 파일 (*.*)|*.*",
            InitialDirectory = _active?.Path != null ? Path.GetDirectoryName(_active.Path) : null
        };
        if (dlg.ShowDialog(this) != true) return;
        SaveScroll(scroll);
        foreach (var f in dlg.FileNames) OpenPath(f, OpenMode.Auto, null);
    }

    /// <summary>
    /// 문서를 연다. Current=현재 탭에서, NewTab=새 탭에서,
    /// Auto=이미 열린 탭이 있으면 그 탭으로, 현재 탭이 비어 있으면 거기서, 아니면 새 탭에서.
    /// </summary>
    void OpenPath(string path, OpenMode mode, double? currentScroll, string? anchor = null, string? find = null)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        string full;
        try { full = Path.GetFullPath(path); } catch { Toast("잘못된 경로입니다."); return; }

        if (!File.Exists(full)) { Toast("파일을 찾을 수 없습니다: " + Path.GetFileName(full)); return; }
        if (!ViewableExt.Contains(Path.GetExtension(full), StringComparer.OrdinalIgnoreCase))
        {
            OpenExternal(full); // 이미지·PDF 등은 기본 앱으로
            return;
        }
        if (!_webReady) { _pendingPaths.Add(full); return; }

        SaveScroll(currentScroll);

        DocTab tab;
        if (mode == OpenMode.Auto)
        {
            var existing = _tabs.FirstOrDefault(t => SamePath(t.Path, full));
            if (existing != null)
            {
                _active = existing;
                ShowActive(keepScroll: false, anchor: anchor, find: find);
                return;
            }
            tab = _active is { Path: null } ? _active : AddTab();
        }
        else if (mode == OpenMode.NewTab) tab = AddTab();
        else tab = _active ?? AddTab();

        bool samePage = tab == _active && SamePath(tab.Path, full);
        tab.History.Push(full);
        _active = tab;
        _settings.AddRecent(full);
        _saveDebounce.Trigger(_settings.Save);

        if (samePage && find == null && anchor != null) { Post(new { type = "scrollTo", anchor }); return; }
        ShowActive(keepScroll: false, anchor: anchor, find: find, scrollOverride: 0);
    }

    void OpenRelative(string vaultKey, string rel, OpenMode mode, double? scroll, string? find)
    {
        var vault = _vaults.Values.FirstOrDefault(v => v.HostName == vaultKey) ?? ActiveVault();
        var full = vault?.FromRelative(rel);
        if (full == null) { Toast("파일을 찾을 수 없습니다: " + rel); return; }
        OpenPath(full, mode, scroll, find: find);
    }

    void GoHistory(bool back, double? scroll)
    {
        if (_active == null) return;
        SaveScroll(scroll);
        var entry = back ? _active.History.Back() : _active.History.Forward();
        if (entry == null) return;
        if (!File.Exists(entry.Path)) Toast("파일이 더 이상 없습니다.");
        ShowActive(keepScroll: false);
    }

    /// <summary>활성 탭의 문서를 읽어서 페이지로 보낸다.</summary>
    void ShowActive(bool keepScroll, string? anchor = null, string? find = null, double? scrollOverride = null)
    {
        PostTabs();
        var path = _active?.Path;
        if (path == null)
        {
            _fileWatcher?.Dispose();
            _fileWatcher = null;
            Title = "MdReader";
            Post(new { type = "welcome", recent = _settings.Recent.Where(File.Exists).ToArray(), canBack = false, canForward = false });
            return;
        }

        string text;
        try { text = TextFile.Read(path); }
        catch (Exception ex)
        {
            text = $"> [!danger] 파일을 열 수 없습니다\n> {ex.Message}\n>\n> `{path}`";
        }

        var vault = GetVault(path);
        WatchFile(path);
        string name = Path.GetFileNameWithoutExtension(path);
        Title = $"{name} — MdReader";

        string[]? notes = null;
        if (!_sentIndexVersion.TryGetValue(vault.HostName, out var sent) || sent != vault.Version)
        {
            notes = vault.RelativePaths.ToArray();
            _sentIndexVersion[vault.HostName] = vault.Version;
        }

        Post(new
        {
            type = "load",
            tabId = _active!.Id,
            path,
            name,
            relPath = vault.Contains(path) ? vault.ToRelative(path) : path,
            vaultKey = vault.HostName,
            vaultName = vault.Name,
            vaultRoot = vault.Root,
            isVault = vault.IsVault,
            markdown = text,
            notes,
            anchor,
            find,
            scroll = scrollOverride ?? _active.History.Current?.Scroll ?? 0,
            keepScroll,
            canBack = _active.History.CanBack,
            canForward = _active.History.CanForward,
            css = _settings.CssSnippets ? vault.GetSnippetCss() : null
        });
    }

    // ───────────────────────── 링크 ─────────────────────────

    void NavigateWikiLink(string target, string from, OpenMode mode, double? scroll)
    {
        var vault = ActiveVault();
        if (vault == null) return;
        int hash = target.IndexOf('#');
        string file = hash >= 0 ? target[..hash] : target;
        string? sub = hash >= 0 ? target[(hash + 1)..] : null;

        if (string.IsNullOrWhiteSpace(file)) { Post(new { type = "scrollTo", anchor = sub }); return; }

        var path = vault.ResolveLink(file, FromDir(from));
        if (path == null) { Toast($"노트를 찾을 수 없습니다: {file}"); return; }
        OpenPath(path, mode, scroll, sub);
    }

    void NavigateHref(string href, string from, OpenMode mode, double? scroll)
    {
        var vault = ActiveVault();
        if (vault == null) return;
        int hash = href.IndexOf('#');
        string pathPart = SafeUnescape(hash >= 0 ? href[..hash] : href);
        string? anchor = hash >= 0 ? SafeUnescape(href[(hash + 1)..]) : null;

        if (pathPart.Length == 0) { Post(new { type = "scrollTo", anchor }); return; }
        var path = vault.ResolveRelative(pathPart, FromDir(from));
        if (path == null) { Toast("파일을 찾을 수 없습니다: " + pathPart); return; }
        OpenPath(path, mode, scroll, anchor);
    }

    static string SafeUnescape(string s)
    {
        try { return Uri.UnescapeDataString(s); } catch { return s; }
    }

    string FromDir(string from)
    {
        if (!string.IsNullOrEmpty(from) && Path.IsPathRooted(from)) return Path.GetDirectoryName(from)!;
        return _active?.Path != null ? Path.GetDirectoryName(_active.Path)! : ActiveVault()?.Root ?? AppContext.BaseDirectory;
    }

    /// <summary>임베드(![[...]]) 와 로컬 이미지 경로를 해석해 페이지에 돌려준다.</summary>
    void Resolve(string id, string target, bool relative, string from)
    {
        var vault = !string.IsNullOrEmpty(from) && Path.IsPathRooted(from) ? GetVault(from) : ActiveVault();
        if (vault == null) return;
        int hash = target.IndexOf('#');
        string file = (hash >= 0 ? target[..hash] : target).Trim();
        string dir = FromDir(from);

        string? path = string.IsNullOrEmpty(file) ? from
            : relative ? vault.ResolveRelative(file, dir) : vault.ResolveLink(file, dir);

        if (path == null || !File.Exists(path)) { Post(new { type = "resolved", id, found = false }); return; }

        string ext = Path.GetExtension(path).ToLowerInvariant();
        string name = Path.GetFileNameWithoutExtension(path);

        if (ViewableExt.Contains(ext))
        {
            string md;
            try { md = TextFile.Read(path); } catch { Post(new { type = "resolved", id, found = false }); return; }
            Post(new { type = "resolved", id, found = true, kind = "note", path, name, markdown = md });
            return;
        }

        string kind = ext switch
        {
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".svg" or ".webp" or ".avif" or ".ico" => "image",
            ".mp3" or ".wav" or ".m4a" or ".ogg" or ".flac" or ".3gp" => "audio",
            ".mp4" or ".webm" or ".ogv" or ".mov" or ".mkv" => "video",
            ".pdf" => "pdf",
            _ => "file"
        };
        Post(new { type = "resolved", id, found = true, kind, path, name = Path.GetFileName(path), url = ToUrl(vault, path) });
    }

    /// <summary>볼트 안 파일은 가상 호스트 URL, 바깥 파일은 data: URL 로 만든다.</summary>
    static string? ToUrl(VaultIndex vault, string path)
    {
        if (vault.Contains(path))
        {
            var segments = vault.ToRelative(path).Split('/').Select(Uri.EscapeDataString);
            return $"https://{vault.HostName}/" + string.Join('/', segments);
        }
        var info = new FileInfo(path);
        if (info.Length > MaxInlineFileBytes) return null;
        string mime = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif",
            ".svg" => "image/svg+xml", ".webp" => "image/webp", ".bmp" => "image/bmp",
            ".pdf" => "application/pdf", ".mp3" => "audio/mpeg", ".mp4" => "video/mp4",
            _ => "application/octet-stream"
        };
        return $"data:{mime};base64," + Convert.ToBase64String(File.ReadAllBytes(path));
    }

    // ───────────────────────── 백링크 · 검색 ─────────────────────────

    async Task SendBacklinksAsync(string reqId)
    {
        var path = _active?.Path;
        var vault = ActiveVault();
        if (path == null || vault == null)
        {
            Post(new { type = "backlinks", reqId, path, items = Array.Empty<object>() });
            return;
        }
        try
        {
            var items = await Task.Run(() => vault.GetBacklinks(path));
            Post(new { type = "backlinks", reqId, path, vaultKey = vault.HostName, items });
        }
        catch (Exception ex)
        {
            Post(new { type = "backlinks", reqId, path, error = ex.Message, items = Array.Empty<object>() });
        }
    }

    async Task SearchAsync(string reqId, string query)
    {
        _searchCts?.Cancel();
        var cts = _searchCts = new CancellationTokenSource();
        var vault = ActiveVault();
        if (vault == null || string.IsNullOrWhiteSpace(query))
        {
            Post(new { type = "searchResults", reqId, query, items = Array.Empty<object>() });
            return;
        }
        try
        {
            var result = await Task.Run(() => vault.Search(query, cts.Token), cts.Token);
            if (cts.IsCancellationRequested) return;
            Post(new
            {
                type = "searchResults", reqId, query, vaultKey = vault.HostName,
                items = result.Items, truncated = result.Truncated, scanned = result.Scanned
            });
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Post(new { type = "searchResults", reqId, query, error = ex.Message, items = Array.Empty<object>() });
        }
    }

    // ───────────────────────── 볼트 / 파일 감시 ─────────────────────────

    VaultIndex? ActiveVault() => _active?.Path is { } p ? GetVault(p) : null;

    VaultIndex GetVault(string filePath)
    {
        string dir = Path.GetDirectoryName(filePath)!;
        string? vaultRoot = VaultIndex.FindVaultRoot(dir);
        string root = VaultIndex.NormalizeRoot(vaultRoot ?? dir);

        if (_vaults.TryGetValue(root, out var existing)) return existing;

        var vault = new VaultIndex(root, vaultRoot != null, $"v{++_vaultSeq}.mdreader");
        _vaults[root] = vault;
        Core.SetVirtualHostNameToFolderMapping(vault.HostName, vault.Root, CoreWebView2HostResourceAccessKind.Allow);
        WatchVault(vault);
        return vault;
    }

    void WatchFile(string path)
    {
        if (_fileWatcher != null && string.Equals(_fileWatcher.Path, Path.GetDirectoryName(path), StringComparison.OrdinalIgnoreCase) &&
            string.Equals(_fileWatcher.Filter, Path.GetFileName(path), StringComparison.OrdinalIgnoreCase))
            return;

        _fileWatcher?.Dispose();
        _fileWatcher = null;
        try
        {
            var w = new FileSystemWatcher(Path.GetDirectoryName(path)!, Path.GetFileName(path))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
                IncludeSubdirectories = false
            };
            void Handler(object sender, FileSystemEventArgs e) => _reloadDebounce.Trigger(() =>
            {
                if (_active?.Path is { } cur && SamePath(cur, path) && File.Exists(cur)) ShowActive(keepScroll: true);
            });
            w.Changed += Handler;
            w.Created += Handler;
            w.Renamed += (s, e) => Handler(s, e); // 임시 파일 → 원본 이름으로 바꾸는 방식의 저장
            w.EnableRaisingEvents = true;
            _fileWatcher = w;
        }
        catch { /* 감시 불가 위치 */ }
    }

    void WatchVault(VaultIndex vault)
    {
        try
        {
            var w = new FileSystemWatcher(vault.Root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName,
                IncludeSubdirectories = vault.IsVault,
                InternalBufferSize = 64 * 1024
            };
            void OnChange(object sender, FileSystemEventArgs e) => _indexDebounce.Trigger(async () =>
            {
                await Task.Run(vault.Rebuild);
                if (_webReady && ActiveVault() == vault)
                {
                    Post(new { type = "index", vaultKey = vault.HostName, notes = vault.RelativePaths });
                    _sentIndexVersion[vault.HostName] = vault.Version;
                }
            });
            w.Created += OnChange;
            w.Deleted += OnChange;
            w.Renamed += (s, e) => OnChange(s, e);
            w.EnableRaisingEvents = true;
            _vaultWatchers[vault.Root] = w;
        }
        catch { /* 네트워크 드라이브 등 감시 불가 → 무시 */ }
    }

    // ───────────────────────── 유틸 ─────────────────────────

    static bool SamePath(string? a, string? b) => a != null && b != null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    static void OpenExternal(string target)
    {
        if (string.IsNullOrWhiteSpace(target)) return;
        bool ok = Uri.TryCreate(target, UriKind.Absolute, out var uri) &&
                  (uri.Scheme is "http" or "https" or "mailto" or "obsidian" || uri.IsFile);
        if (!ok && !File.Exists(target)) return;
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch { /* 연결된 앱 없음 */ }
    }

    void OpenInObsidian()
    {
        var vault = ActiveVault();
        if (_active?.Path == null || vault is not { IsVault: true }) return;
        OpenExternal("obsidian://open?path=" + Uri.EscapeDataString(_active.Path));
    }

    void RestorePlacement()
    {
        Width = Math.Max(MinWidth, _settings.Width);
        Height = Math.Max(MinHeight, _settings.Height);
        if (_settings.Left is double l && _settings.Top is double t &&
            l > SystemParameters.VirtualScreenLeft - 50 && t > SystemParameters.VirtualScreenTop - 50 &&
            l < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - 100 &&
            t < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - 100)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = l; Top = t;
        }
        if (_settings.Maximized) WindowState = WindowState.Maximized;
    }

    void SavePlacement()
    {
        _settings.Maximized = WindowState == WindowState.Maximized;
        var b = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (b.Width > 0 && b.Height > 0)
        {
            _settings.Left = b.Left; _settings.Top = b.Top;
            _settings.Width = b.Width; _settings.Height = b.Height;
        }
    }
}
