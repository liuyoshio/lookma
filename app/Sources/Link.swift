// The link to the core on /ws/app: hello on connect, attention every 0.5 s, replies to the
// core's requests, and the user's pause, resume and quit from the menu bar. Requests go through
// one FIFO, so ops never run concurrently. Reconnects with backoff, so the app survives a core restart.
import AppKit

final class Link: NSObject, URLSessionWebSocketDelegate {
    private let url: URL
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var isOpen = false
    private var backoff = 0.5
    private let requests: AsyncStream<[String: Any]>.Continuation
    /// Whether the core is paused, as it says on connect and on every change; nil while not connected.
    var onPaused: (Bool?) -> Void = { _ in }
    var connected: Bool { isOpen }

    init(url: URL) {
        self.url = url
        let (stream, cont) = AsyncStream<[String: Any]>.makeStream()
        requests = cont
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        Task.detached { [weak self] in
            for await msg in stream { await self?.serve(msg) }
        }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.send(["type": "attention", "idle": (userIdle() * 10).rounded() / 10])
        }
    }

    func start() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, t === self.task else { return }
            switch result {
            case .failure: self.drop(t)
            case .success(let m):
                var data: Data? = nil
                if case .string(let s) = m { data = s.data(using: .utf8) } else if case .data(let d) = m { data = d }
                if let data, let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    switch msg["type"] as? String {
                    case "req": self.requests.yield(msg)
                    // The core is stopping: quit with it (applicationWillTerminate restores AX attributes).
                    case "quit": DispatchQueue.main.async { NSApp.terminate(nil) }
                    case "paused":
                        let paused = msg["paused"] as? Bool ?? false
                        DispatchQueue.main.async { self.onPaused(paused) }
                    default: break
                    }
                }
                self.receive(t)
            }
        }
    }

    private func serve(_ msg: [String: Any]) async {
        let op = msg["op"] as? String ?? ""
        let t0 = now()
        var reply: [String: Any] = ["type": "res", "id": msg["id"] ?? NSNull()]
        do {
            reply["result"] = try await runOp(op, msg["args"] as? [String: Any] ?? [:])
            reply["ok"] = true
            log("\(op) ok \(Int((now() - t0) * 1000)) ms")
        } catch {
            reply["ok"] = false
            reply["error"] = error.localizedDescription
            log("\(op) failed \(Int((now() - t0) * 1000)) ms: \(error.localizedDescription)")
        }
        send(reply)
    }

    func send(_ obj: [String: Any]) {
        DispatchQueue.main.async { [self] in
            guard isOpen, let task, let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
            task.send(.string(s)) { _ in }
        }
    }

    private func drop(_ t: URLSessionTask) {
        guard t === task else { return }
        task = nil
        if isOpen {
            log("disconnected")
            onPaused(nil)
        }
        isOpen = false
        t.cancel()
        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in self?.start() }
        backoff = min(backoff * 2, 5)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        isOpen = true
        backoff = 0.5
        log("connected to \(url.absoluteString)")
        send(hello())
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        drop(webSocketTask)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        drop(task)
    }
}

func hello() -> [String: Any] {
    let s = NSScreen.screens.first
    return [
        "type": "hello",
        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
        "permissions": permissions(),
        "screen": ["w": Int(s?.frame.width ?? 0), "h": Int(s?.frame.height ?? 0), "scale": s?.backingScaleFactor ?? 1],
    ]
}
