using System.Windows.Threading;

namespace MdReader;

/// <summary>짧은 시간에 몰려오는 이벤트(파일 저장 등)를 한 번으로 합친다. UI 스레드에서 실행.</summary>
internal sealed class Debouncer
{
    readonly DispatcherTimer _timer;
    Action? _action;

    public Debouncer(Dispatcher dispatcher, TimeSpan delay)
    {
        _timer = new DispatcherTimer(delay, DispatcherPriority.Normal, (_, _) =>
        {
            _timer!.Stop();
            _action?.Invoke();
        }, dispatcher);
        _timer.Stop();
    }

    /// <summary>어느 스레드에서든 호출 가능</summary>
    public void Trigger(Action action)
    {
        _timer.Dispatcher.BeginInvoke(() =>
        {
            _action = action;
            _timer.Stop();
            _timer.Start();
        });
    }
}
