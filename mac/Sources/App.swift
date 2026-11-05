import AppKit
import SwiftUI
import WebKit

@main
struct InterviewAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = RecorderModel.shared

    var body: some Scene {
        Window("Interview Assistant", id: "main") {
            AppWebView()
                .frame(width: 540)
                .frame(minHeight: 480, idealHeight: 740, maxHeight: .infinity)
                .ignoresSafeArea()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .defaultPosition(.center)

        MenuBarExtra {
            MenuBarContent()
                .environmentObject(model)
        } label: {
            if model.isRecording {
                Image(systemName: "record.circle.fill")
                Text(model.elapsedText)
            } else {
                Image(systemName: "record.circle")
            }
        }
    }
}

/// Если приложение закрывают во время записи, сначала корректно закрываем файлы.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var terminationSignal: DispatchSourceSignal?
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Скрипт обновления закрывает приложение сигналом. Запись при этом сохраняется как при обычном выходе.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            Task { @MainActor in NSApp.terminate(nil) }
        }
        source.resume()
        terminationSignal = source

        // Подхватываем новые экраны и микрофоны, а также выданные разрешения.
        let center = NotificationCenter.default
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didChangeScreenParametersNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                Task { @MainActor in
                    if RecorderModel.shared.state == .idle {
                        RecorderModel.shared.refreshDevices()
                    }
                }
            })
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let model = RecorderModel.shared
        guard model.isRecording else { return .terminateNow }
        Task { @MainActor in
            await model.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

struct MenuBarContent: View {
    @EnvironmentObject private var model: RecorderModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(model.isRecording ? "Остановить запись" : "Начать запись") {
            model.toggleRecording()
        }
        .disabled(model.isBusy)

        Button("Показать окно") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }

        Button("Открыть папку записей") {
            model.openRecordingsFolder()
        }

        Divider()

        Button("Выйти") {
            NSApp.terminate(nil)
        }
    }
}

/// WKWebView забирает нажатия себе, поэтому окно нельзя перетащить за верхнюю часть.
/// Эта прозрачная полоса лежит поверх страницы и передаёт перетаскивание системе.
final class WindowDragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class WebContainerView: NSView {
    init(webView: WKWebView) {
        super.init(frame: .zero)

        let strip = WindowDragStrip()
        webView.translatesAutoresizingMaskIntoConstraints = false
        strip.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)
        addSubview(strip)

        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            // Высота совпадает с шапкой .titlebar в index.html, вкладки начинаются ниже.
            strip.topAnchor.constraint(equalTo: topAnchor),
            strip.leadingAnchor.constraint(equalTo: leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: trailingAnchor),
            strip.heightAnchor.constraint(equalToConstant: 30),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("Не используется")
    }
}

struct AppWebView: NSViewRepresentable {
    func makeCoordinator() -> WebBridge {
        WebBridge(model: RecorderModel.shared)
    }

    func makeNSView(context: Context) -> WebContainerView {
        WebContainerView(webView: context.coordinator.makeWebView())
    }

    func updateNSView(_ nsView: WebContainerView, context: Context) {}

    static func dismantleNSView(_ nsView: WebContainerView, coordinator: WebBridge) {
        coordinator.tearDown()
    }
}
