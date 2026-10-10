using System.Text;
using System.Windows;

namespace MdReader;

public partial class App : Application
{
    SingleInstance? _single;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // CP949(EUC-KR) 등 레거시 인코딩 파일 읽기용
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        var paths = e.Args.Where(a => !a.StartsWith('-')).ToArray();
        bool newWindow = e.Args.Contains("--new-window", StringComparer.OrdinalIgnoreCase);

        // 이미 실행 중이면 그 창의 새 탭으로 넘기고 끝낸다
        _single = new SingleInstance();
        if (!_single.IsFirst && !newWindow && SingleInstance.SendToExisting(paths))
        {
            Shutdown();
            return;
        }

        DispatcherUnhandledException += (_, ex) =>
        {
            MessageBox.Show(ex.Exception.Message, "MdReader 오류", MessageBoxButton.OK, MessageBoxImage.Error);
            ex.Handled = true;
        };

        var window = new MainWindow(paths);
        if (_single.IsFirst)
            _single.Listen(p => Dispatcher.BeginInvoke(() => window.OpenFromShell(p)));
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _single?.Dispose();
        base.OnExit(e);
    }
}
