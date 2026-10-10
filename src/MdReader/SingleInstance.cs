using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

namespace MdReader;

/// <summary>
/// 프로그램이 이미 실행 중이면 새로 연 파일 경로를 기존 창으로 넘기고 종료한다.
/// (Named Pipe, 현재 사용자 전용)
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    static readonly string Id = $"MdReader-{Environment.UserName}-{Process.GetCurrentProcess().SessionId}";
    static string PipeName => Id + "-pipe";

    readonly Mutex _mutex;
    readonly CancellationTokenSource _cts = new();
    public bool IsFirst { get; }

    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int dwProcessId);

    public SingleInstance()
    {
        _mutex = new Mutex(true, @"Local\" + Id, out bool created);
        IsFirst = created;
    }

    /// <summary>기존 인스턴스에 경로들을 보낸다. 성공하면 true.</summary>
    public static bool SendToExisting(IEnumerable<string> paths)
    {
        try
        {
            AllowSetForegroundWindow(-1); // 기존 창이 앞으로 나올 수 있게 허용
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(2000);
            var payload = string.Join("\n", paths.Select(p => Path.GetFullPath(p))) + "\n";
            var bytes = Encoding.UTF8.GetBytes(payload.Length > 1 ? payload : "\n");
            client.Write(bytes, 0, bytes.Length);
            client.Flush();
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>다른 인스턴스가 보낸 경로를 받을 때마다 onPaths 호출 (백그라운드 스레드)</summary>
    public void Listen(Action<string[]> onPaths)
    {
        Task.Run(async () =>
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await server.WaitForConnectionAsync(_cts.Token);
                    using var reader = new StreamReader(server, Encoding.UTF8);
                    var text = await reader.ReadToEndAsync();
                    var paths = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                    onPaths(paths);
                }
                catch (OperationCanceledException) { break; }
                catch { await Task.Delay(300); }
            }
        });
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { if (IsFirst) _mutex.ReleaseMutex(); } catch { }
        _mutex.Dispose();
    }
}
