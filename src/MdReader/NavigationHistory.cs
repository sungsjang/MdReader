namespace MdReader;

/// <summary>브라우저처럼 뒤로/앞으로 이동하는 문서 기록</summary>
internal sealed class NavigationHistory
{
    public sealed class Entry
    {
        public required string Path { get; init; }
        public double Scroll { get; set; }
    }

    readonly List<Entry> _items = new();
    int _index = -1;

    public Entry? Current => _index >= 0 && _index < _items.Count ? _items[_index] : null;
    public bool CanBack => _index > 0;
    public bool CanForward => _index < _items.Count - 1;

    public void Push(string path)
    {
        if (Current != null && string.Equals(Current.Path, path, StringComparison.OrdinalIgnoreCase)) return;
        if (_index < _items.Count - 1) _items.RemoveRange(_index + 1, _items.Count - _index - 1);
        _items.Add(new Entry { Path = path });
        if (_items.Count > 200) _items.RemoveAt(0);
        _index = _items.Count - 1;
    }

    public void SaveScroll(double scroll)
    {
        if (Current != null) Current.Scroll = scroll;
    }

    public Entry? Back() => CanBack ? _items[--_index] : null;
    public Entry? Forward() => CanForward ? _items[++_index] : null;
}
