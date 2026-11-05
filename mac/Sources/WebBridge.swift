import AppKit
import Combine
import Foundation
import WebKit

/// Связывает HTML-интерфейс с моделью: команды идут из JavaScript сюда, состояние отправляется обратно.
@MainActor
final class WebBridge: NSObject, WKScriptMessageHandler {
    private let model: RecorderModel
    private var webView: WKWebView?
    private var isPageReady = false
    private var subscriptions: [AnyCancellable] = []

    init(model: RecorderModel) {
        self.model = model
        super.init()
    }

    func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "app")

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.underPageBackgroundColor = .windowBackgroundColor
        webView = view

        if let page = Bundle.main.url(forResource: "index", withExtension: "html") {
            view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            view.loadHTMLString("<p>Не найден файл интерфейса. Пересоберите приложение.</p>", baseURL: nil)
        }

        model.onSpeech = { [weak self] track, text, isFinal in
            self?.callPage("coachSpeech", [track, text, isFinal])
        }

        model.objectWillChange
            .throttle(for: .milliseconds(100), scheduler: DispatchQueue.main, latest: true)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.pushState()
            }
            .store(in: &subscriptions)

        return view
    }

    func tearDown() {
        subscriptions.removeAll()
        model.onSpeech = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "app")
        webView = nil
        isPageReady = false
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        handle(action: action, value: body["value"])
    }

    private func handle(action: String, value: Any?) {
        switch action {
        case "ready":
            isPageReady = true
            pushState()
            Task { await model.prepare() }
        case "toggleRecording":
            model.toggleRecording()
        case "selectDisplay":
            if let id = value as? NSNumber {
                model.selectedDisplayID = id.uint32Value
            }
        case "selectMicrophone":
            if let id = value as? String {
                model.selectedMicrophoneID = id
            }
        case "setTranscribe":
            if let enabled = value as? Bool {
                model.transcribeAfterRecording = enabled
            }
        case "setAutoOpen":
            if let enabled = value as? Bool {
                model.openTranscriptAutomatically = enabled
            }
        case "setLanguage":
            if let language = value as? String {
                model.transcriptionLanguage = language
            }
        case "chooseSaveFolder":
            model.chooseSaveFolder()
        case "resetSaveFolder":
            model.resetSaveFolder()
        case "transcribeExisting":
            model.chooseExistingFileToTranscribe()
        case "openRecordingsFolder":
            model.openRecordingsFolder()
        case "openLastTranscript":
            model.openLastTranscript()
        case "openScreenSettings":
            model.openScreenSettings()
        case "openMicrophoneSettings":
            model.openMicrophoneSettings()
        case "relaunch":
            model.relaunch()
        case "syncState":
            pushState()
        case "setLiveEnabled":
            if let enabled = value as? Bool {
                model.liveEnabled = enabled
            }
        case "setLlmProvider":
            if let raw = value as? String, let provider = LLMProvider(rawValue: raw) {
                model.llmProvider = provider
            }
        case "setLlmModel":
            if let name = value as? String {
                model.setLlmModel(name)
            }
        case "setQuestionSource":
            if let source = value as? String, source == "interviewer" || source == "both" {
                model.questionSource = source
            }
        case "saveApiKey":
            if let key = value as? String, !key.isEmpty {
                model.saveApiKey(key)
            }
        case "deleteApiKey":
            model.deleteApiKey()
        case "llmRequest":
            if let request = value as? [String: Any],
               let id = request["id"] as? Int,
               let messages = request["messages"] as? [[String: Any]],
               let maxTokens = request["maxTokens"] as? Int {
                runLlm(id: id, messages: messages, maxTokens: maxTokens)
            }
        case "saveReport":
            if let report = value as? [String: Any],
               let markdown = report["markdown"] as? String,
               let json = report["json"] as? String {
                model.saveInterviewReport(markdown: markdown, json: json)
            }
        default:
            break
        }
    }

    private func runLlm(id: Int, messages: [[String: Any]], maxTokens: Int) {
        Task { @MainActor in
            guard let apiKey = model.currentApiKey() else {
                callPage("coachLlmDone", [id, "API-ключ не добавлен или не читается, сохраните его заново"])
                return
            }
            do {
                try await LLMClient.stream(
                    provider: model.llmProvider,
                    model: model.llmModel,
                    apiKey: apiKey,
                    messages: messages,
                    maxTokens: maxTokens
                ) { text in
                    self.callPage("coachLlmDelta", [id, text])
                }
                callPage("coachLlmDone", [id, NSNull()])
            } catch {
                callPage("coachLlmDone", [id, error.localizedDescription])
            }
        }
    }

    /// Вызывает функцию страницы. Аргументы передаются как JSON, поэтому любой текст безопасен.
    private func callPage(_ function: String, _ arguments: [Any]) {
        guard isPageReady, let webView,
              let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("window.\(function).apply(null, \(json))", completionHandler: nil)
    }

    private func pushState() {
        guard isPageReady, let webView,
              let data = try? JSONSerialization.data(withJSONObject: model.interfaceState()),
              let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript("window.appUpdate(\(json))", completionHandler: nil)
    }
}
