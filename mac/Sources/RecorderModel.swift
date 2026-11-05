import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

struct DisplayOption: Identifiable {
    let id: CGDirectDisplayID
    let number: Int
    let name: String
    let frame: CGRect
    let isMain: Bool
}

struct MicrophoneOption: Identifiable, Hashable {
    let id: String
    let name: String
}

enum RecorderState: String {
    case idle, starting, recording, stopping
}

/// Что поставлено в очередь на расшифровку: папка записи с двумя дорожками или отдельный файл.
enum TranscriptionJob {
    case recording(URL)
    case file(URL)
}

@MainActor
final class RecorderModel: ObservableObject {
    static let shared: RecorderModel = {
        migrateSettingsFromOldName()
        return RecorderModel()
    }()

    /// Один раз переносит настройки из версий, вышедших под названием Interview Recorder.
    private static func migrateSettingsFromOldName() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: "migratedFromInterviewRecorder") else { return }
        defaults.set(true, forKey: "migratedFromInterviewRecorder")
        guard let old = UserDefaults(suiteName: "local.ivan.interviewrecorder") else { return }

        let keys = [
            "transcribeAfterRecording", "transcriptionLanguage", "openTranscriptAutomatically",
            "customSaveFolderPath", "liveEnabled", "llmProvider", "questionSource",
            "llmModel.deepseek", "llmModel.openrouter",
        ]
        for key in keys {
            if let value = old.object(forKey: key) {
                defaults.set(value, forKey: key)
            }
        }
    }

    @Published var state: RecorderState = .idle
    @Published var displays: [DisplayOption] = []
    @Published var microphones: [MicrophoneOption] = []
    @Published var selectedDisplayID: CGDirectDisplayID = CGMainDisplayID()
    @Published var selectedMicrophoneID: String = ""
    @Published var elapsedSeconds = 0
    @Published var micLevel: Float = 0
    @Published var systemLevel: Float = 0
    @Published var micSilent = false
    @Published var errorMessage: String?
    @Published var screenPermissionMissing = false
    @Published var micPermissionMissing = false
    @Published var lastRecordingFolder: URL?

    // Расшифровка включена по умолчанию, выбор запоминается между запусками.
    @Published var transcribeAfterRecording: Bool =
        UserDefaults.standard.object(forKey: "transcribeAfterRecording") as? Bool ?? true {
        didSet { UserDefaults.standard.set(transcribeAfterRecording, forKey: "transcribeAfterRecording") }
    }
    @Published var transcriptionLanguage: String =
        UserDefaults.standard.string(forKey: "transcriptionLanguage") ?? "ru-RU" {
        didSet { UserDefaults.standard.set(transcriptionLanguage, forKey: "transcriptionLanguage") }
    }
    @Published var openTranscriptAutomatically: Bool =
        UserDefaults.standard.object(forKey: "openTranscriptAutomatically") as? Bool ?? true {
        didSet { UserDefaults.standard.set(openTranscriptAutomatically, forKey: "openTranscriptAutomatically") }
    }
    @Published var customSaveFolderPath: String? =
        UserDefaults.standard.string(forKey: "customSaveFolderPath") {
        didSet { UserDefaults.standard.set(customSaveFolderPath, forKey: "customSaveFolderPath") }
    }
    @Published var isTranscribing = false
    @Published var transcriptionProgress = 0.0
    @Published var transcriptionError: String?
    @Published var lastTranscriptURL: URL?

    // Подсказки во время записи
    @Published var liveEnabled: Bool =
        UserDefaults.standard.object(forKey: "liveEnabled") as? Bool ?? true {
        didSet { UserDefaults.standard.set(liveEnabled, forKey: "liveEnabled") }
    }
    @Published var llmProvider: LLMProvider =
        LLMProvider(rawValue: UserDefaults.standard.string(forKey: "llmProvider") ?? "") ?? .deepseek {
        didSet {
            UserDefaults.standard.set(llmProvider.rawValue, forKey: "llmProvider")
            llmHasKey = APIKeyStore.exists(llmProvider)
        }
    }
    @Published var questionSource: String =
        UserDefaults.standard.string(forKey: "questionSource") ?? "interviewer" {
        didSet { UserDefaults.standard.set(questionSource, forKey: "questionSource") }
    }
    @Published var llmHasKey = false
    @Published var liveStatus = ""

    /// Распознанная речь для страницы: дорожка, текст, окончательный ли результат.
    var onSpeech: ((String, String, Bool) -> Void)?

    private var engine: CaptureEngine?
    private var timer: Timer?
    private var startDate = Date()
    private var lastMicSignal = Date()
    private var currentFolder: URL?
    private var transcriptionQueue: [TranscriptionJob] = []
    private var sleepActivity: NSObjectProtocol?
    private var liveTracks: [LiveSpeechTrack] = []
    private var apiKeyCache: [LLMProvider: String] = [:]

    init() {
        llmHasKey = APIKeyStore.exists(llmProvider)
    }

    var llmModel: String {
        let saved = UserDefaults.standard.string(forKey: "llmModel.\(llmProvider.rawValue)") ?? ""
        return saved.isEmpty ? llmProvider.defaultModel : saved
    }

    func setLlmModel(_ value: String) {
        UserDefaults.standard.set(value, forKey: "llmModel.\(llmProvider.rawValue)")
        objectWillChange.send()
    }

    func saveApiKey(_ value: String) {
        if APIKeyStore.save(value, for: llmProvider) {
            apiKeyCache[llmProvider] = value
            llmHasKey = true
        } else {
            errorMessage = "Не удалось сохранить ключ в Связке ключей."
        }
    }

    func deleteApiKey() {
        APIKeyStore.delete(llmProvider)
        apiKeyCache[llmProvider] = nil
        llmHasKey = false
    }

    func currentApiKey() -> String? {
        if let cached = apiKeyCache[llmProvider] { return cached }
        let loaded = APIKeyStore.load(llmProvider)
        apiKeyCache[llmProvider] = loaded
        return loaded
    }

    var isRecording: Bool { state == .recording }
    var isBusy: Bool { state == .starting || state == .stopping }

    var elapsedText: String {
        let hours = elapsedSeconds / 3600
        let minutes = elapsedSeconds / 60 % 60
        let seconds = elapsedSeconds % 60
        return String(format: "%d:%02d:%02d", hours, minutes, seconds)
    }

    var defaultRecordingsRoot: URL {
        let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
        return movies.appendingPathComponent("Interview Assistant", isDirectory: true)
    }

    var recordingsRoot: URL {
        if let customSaveFolderPath {
            return URL(fileURLWithPath: customSaveFolderPath, isDirectory: true)
        }
        return defaultRecordingsRoot
    }

    /// Всё, что нужно HTML-интерфейсу для отрисовки.
    func interfaceState() -> [String: Any] {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return [
            "version": version,
            "state": state.rawValue,
            "elapsedText": elapsedText,
            "micLevel": Self.meterValue(micLevel),
            "systemLevel": Self.meterValue(systemLevel),
            "micSilent": micSilent,
            "errorMessage": errorMessage ?? "",
            "screenPermissionMissing": screenPermissionMissing,
            "micPermissionMissing": micPermissionMissing,
            "selectedDisplayID": Int(selectedDisplayID),
            "displays": displays.map { display -> [String: Any] in
                [
                    "id": Int(display.id),
                    "number": display.number,
                    "name": display.name,
                    "x": Double(display.frame.origin.x),
                    "y": Double(display.frame.origin.y),
                    "width": Int(display.frame.width),
                    "height": Int(display.frame.height),
                    "isMain": display.isMain,
                ]
            },
            "selectedMicrophoneID": selectedMicrophoneID,
            "microphones": microphones.map { ["id": $0.id, "name": $0.name] },
            "transcribeAfterRecording": transcribeAfterRecording,
            "openTranscriptAutomatically": openTranscriptAutomatically,
            "transcriptionLanguage": transcriptionLanguage,
            "isTranscribing": isTranscribing,
            "transcriptionProgress": transcriptionProgress,
            "transcriptionError": transcriptionError ?? "",
            "hasLastTranscript": lastTranscriptURL != nil,
            "saveFolderPath": (recordingsRoot.path as NSString).abbreviatingWithTildeInPath,
            "saveFolderIsDefault": customSaveFolderPath == nil,
            "liveEnabled": liveEnabled,
            "llmHasKey": llmHasKey,
            "llmProvider": llmProvider.rawValue,
            "llmModel": llmModel,
            "questionSource": questionSource,
            "liveStatus": liveStatus,
        ]
    }

    /// Шкала в децибелах от -60 до 0: на линейной шкале тихая речь почти не видна.
    private static func meterValue(_ level: Float) -> Double {
        guard level > 0 else { return 0 }
        let decibels = 20 * log10(Double(level))
        return min(max((decibels + 60) / 60, 0), 1)
    }

    // MARK: Подготовка

    func prepare() async {
        loadMicrophones()

        let micGranted = await AVCaptureDevice.requestAccess(for: .audio)
        micPermissionMissing = !micGranted
        if micGranted {
            loadMicrophones()
        }

        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        loadDisplays()
    }

    private func loadMicrophones() {
        let devices = AVCaptureDevice.devices(for: .audio)
        microphones = devices.map { MicrophoneOption(id: $0.uniqueID, name: $0.localizedName) }
        if !microphones.contains(where: { $0.id == selectedMicrophoneID }) {
            selectedMicrophoneID = AVCaptureDevice.default(for: .audio)?.uniqueID ?? microphones.first?.id ?? ""
        }
    }

    /// Список экранов нужен и до выдачи разрешения, поэтому берём его из системы, а не из ScreenCaptureKit.
    private func loadDisplays() {
        screenPermissionMissing = !CGPreflightScreenCaptureAccess()

        let screens = NSScreen.screens.compactMap { screen -> (id: CGDirectDisplayID, name: String)? in
            let key = NSDeviceDescriptionKey("NSScreenNumber")
            guard let number = screen.deviceDescription[key] as? NSNumber else { return nil }
            return (number.uint32Value, screen.localizedName)
        }

        // Как в настройках мониторов: главный экран первый, остальные слева направо.
        let mainID = CGMainDisplayID()
        let ordered = screens.sorted { first, second in
            if first.id == mainID { return true }
            if second.id == mainID { return false }
            return CGDisplayBounds(first.id).origin.x < CGDisplayBounds(second.id).origin.x
        }

        displays = ordered.enumerated().map { index, screen in
            DisplayOption(
                id: screen.id,
                number: index + 1,
                name: screen.name,
                frame: CGDisplayBounds(screen.id),
                isMain: screen.id == mainID
            )
        }
        if !displays.contains(where: { $0.id == selectedDisplayID }), let first = displays.first {
            selectedDisplayID = first.id
        }
    }

    func refreshDevices() {
        loadMicrophones()
        loadDisplays()
    }

    func openScreenSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    func openMicrophoneSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    private func openSettings(_ address: String) {
        if let url = URL(string: address) {
            NSWorkspace.shared.open(url)
        }
    }

    func relaunch() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 1; open \"$0\"", Bundle.main.bundlePath]
        try? process.run()
        NSApp.terminate(nil)
    }

    func chooseSaveFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = recordingsRoot
        panel.prompt = "Выбрать"
        panel.message = "Выберите папку для новых записей"
        if panel.runModal() == .OK, let folder = panel.url {
            customSaveFolderPath = folder.path
        }
    }

    func resetSaveFolder() {
        customSaveFolderPath = nil
    }

    func openRecordingsFolder() {
        let folder = lastRecordingFolder ?? recordingsRoot
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    // MARK: Запись

    func toggleRecording() {
        Task {
            if state == .recording {
                await stop()
            } else if state == .idle {
                await start()
            }
        }
    }

    func start() async {
        guard state == .idle else { return }
        errorMessage = nil

        refreshDevices()
        // О нехватке разрешения уже сообщает отдельный блок с кнопками.
        if screenPermissionMissing {
            return
        }
        guard !micPermissionMissing,
              let microphone = AVCaptureDevice(uniqueID: selectedMicrophoneID)
        else {
            errorMessage = "Микрофон недоступен."
            return
        }

        state = .starting
        let engine = CaptureEngine()
        engine.onMicLevel = { [weak self] level in
            Task { @MainActor in self?.updateMicLevel(level) }
        }
        engine.onSystemLevel = { [weak self] level in
            Task { @MainActor in self?.systemLevel = level }
        }
        prepareLive(engine: engine)
        engine.onFailure = { [weak self] message in
            Task { @MainActor in
                self?.errorMessage = "Запись остановлена: \(message)"
                await self?.stop()
            }
        }

        do {
            let folder = try makeSessionFolder()
            currentFolder = folder
            self.engine = engine
            try await engine.start(
                displayID: selectedDisplayID,
                microphone: microphone,
                folder: folder
            )
            beginRecordingUI()
            startLive()
        } catch {
            stopLive()
            _ = try? await engine.stop()
            self.engine = nil
            removeEmptySessionFolder()
            state = .idle
            errorMessage = "Не удалось начать запись: \(error.localizedDescription)"
        }
    }

    func stop() async {
        guard state == .recording, let engine else { return }
        state = .stopping
        timer?.invalidate()
        timer = nil
        allowSleep()
        stopLive()

        var hasAudio = true
        do {
            let duration = try await engine.stop()
            lastRecordingFolder = currentFolder
            writeSessionInfo(duration: duration)
        } catch {
            lastRecordingFolder = currentFolder
            errorMessage = "Запись завершилась с ошибкой: \(error.localizedDescription)"
            if case RecorderError.noFrames = error {
                hasAudio = false
            }
        }

        self.engine = nil
        micLevel = 0
        systemLevel = 0
        micSilent = false
        state = .idle

        if transcribeAfterRecording, hasAudio, let currentFolder {
            enqueueTranscription(.recording(currentFolder))
        }
    }

    private func beginRecordingUI() {
        state = .recording
        startDate = Date()
        lastMicSignal = Date()
        elapsedSeconds = 0
        preventSleep()

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        elapsedSeconds = Int(Date().timeIntervalSince(startDate))
        // Даже в тишине живой микрофон даёт фоновый шум. Полный ноль 10 секунд подряд значит,
        // что устройство отвалилось или выключено аппаратно.
        micSilent = Date().timeIntervalSince(lastMicSignal) > 10
    }

    private func updateMicLevel(_ level: Float) {
        micLevel = level
        if level > 0.0003 {
            lastMicSignal = Date()
        }
    }

    // MARK: Подсказки во время записи

    private func prepareLive(engine: CaptureEngine) {
        liveTracks = []
        guard liveEnabled, llmHasKey else { return }

        let system = LiveSpeechTrack { [weak self] text, isFinal in
            Task { @MainActor in self?.onSpeech?("system", text, isFinal) }
        }
        let mic = LiveSpeechTrack { [weak self] text, isFinal in
            Task { @MainActor in self?.onSpeech?("mic", text, isFinal) }
        }
        engine.onSystemBuffer = { buffer in system.feed(buffer) }
        engine.onMicBuffer = { buffer in mic.feed(buffer) }
        liveTracks = [system, mic]
    }

    private func startLive() {
        guard liveTracks.count == 2 else { return }
        let system = liveTracks[0]
        let mic = liveTracks[1]
        let locale = Locale(identifier: transcriptionLanguage)
        liveStatus = "Запускаю распознавание речи. Запись уже идёт. В первый раз macOS скачает языковую модель."

        Task {
            do {
                try await system.start(locale: locale)
            } catch {
                if state == .recording {
                    liveStatus = "Подсказки недоступны: \(error.localizedDescription) Запись продолжается."
                }
                return
            }
            do {
                try await mic.start(locale: locale)
                if state == .recording { liveStatus = "" }
            } catch {
                // macOS может ограничивать число одновременных распознаваний.
                if state == .recording {
                    liveStatus = "Ваш голос не распознаётся: \(error.localizedDescription) "
                        + "Подсказки работают, но ответы не будут оценены."
                }
            }
        }
    }

    private func stopLive() {
        liveTracks.forEach { $0.stop() }
        liveTracks = []
        liveStatus = ""
    }

    func saveInterviewReport(markdown: String, json: String) {
        guard let currentFolder else { return }
        try? markdown.write(to: currentFolder.appendingPathComponent("interview-report.md"), atomically: true, encoding: .utf8)
        try? json.write(to: currentFolder.appendingPathComponent("interview-report.json"), atomically: true, encoding: .utf8)
    }

    // MARK: Расшифровка

    /// Записи расшифровываются по очереди, новую запись можно начинать сразу.
    func enqueueTranscription(_ job: TranscriptionJob) {
        transcriptionQueue.append(job)
        processTranscriptionQueue()
    }

    private func processTranscriptionQueue() {
        guard !isTranscribing, !transcriptionQueue.isEmpty else { return }
        let job = transcriptionQueue.removeFirst()
        let language = transcriptionLanguage

        isTranscribing = true
        transcriptionProgress = 0
        transcriptionError = nil

        let onProgress: @Sendable (Double) -> Void = { [weak self] progress in
            Task { @MainActor in self?.transcriptionProgress = progress }
        }

        Task {
            do {
                let transcript: URL
                switch job {
                case .recording(let folder):
                    transcript = try await TranscriptionService.transcribe(
                        folder: folder,
                        languageIdentifier: language,
                        onProgress: onProgress
                    )
                case .file(let file):
                    transcript = try await TranscriptionService.transcribe(
                        file: file,
                        languageIdentifier: language,
                        onProgress: onProgress
                    )
                }
                lastTranscriptURL = transcript

                // Во время новой записи файл не открываем: он перекрыл бы окно звонка.
                if openTranscriptAutomatically, state == .idle {
                    openLastTranscript()
                }
            } catch {
                transcriptionError = "Не удалось расшифровать: \(error.localizedDescription) "
                    + "Исходные файлы сохранены, расшифровку можно повторить."
            }
            isTranscribing = false
            processTranscriptionQueue()
        }
    }

    func chooseExistingFileToTranscribe() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.audio, .movie, .folder]
        panel.directoryURL = recordingsRoot
        panel.prompt = "Расшифровать"
        panel.message = "Выберите аудио, видео или папку записи"
        if panel.runModal() == .OK, let url = panel.url {
            enqueueTranscription(Self.job(for: url))
        }
    }

    /// Любой файл из папки записи обрабатываем как всю запись: так сохраняется разделение на собеседников.
    private static func job(for url: URL) -> TranscriptionJob {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
        if values?.isDirectory == true {
            return .recording(url)
        }
        let folder = url.deletingLastPathComponent()
        let hasTracks = ["mic.m4a", "system.m4a"].allSatisfy {
            FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path)
        }
        return hasTracks ? .recording(folder) : .file(url)
    }

    func openLastTranscript() {
        guard let lastTranscriptURL else { return }
        if NSWorkspace.shared.urlForApplication(toOpen: lastTranscriptURL) != nil {
            NSWorkspace.shared.open(lastTranscriptURL)
        } else {
            // Если для .md не назначено приложение, открываем в TextEdit.
            NSWorkspace.shared.open(
                [lastTranscriptURL],
                withApplicationAt: URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
                configuration: NSWorkspace.OpenConfiguration(),
                completionHandler: nil
            )
        }
    }

    // MARK: Файлы

    private func makeSessionFolder() throws -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH-mm-ss"
        let folder = recordingsRoot.appendingPathComponent(formatter.string(from: Date()), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func removeEmptySessionFolder() {
        if let currentFolder {
            try? FileManager.default.removeItem(at: currentFolder)
        }
        currentFolder = nil
    }

    private func writeSessionInfo(duration: Double) {
        guard let currentFolder else { return }
        let info: [String: Any] = [
            "startedAt": ISO8601DateFormatter().string(from: startDate),
            "durationSeconds": duration,
            "microphone": microphones.first(where: { $0.id == selectedMicrophoneID })?.name ?? "",
            "display": displays.first(where: { $0.id == selectedDisplayID })?.name ?? "",
            "files": [
                "screen.mov": "видео с курсором; аудиодорожка 1 микрофон, аудиодорожка 2 звук системы",
                "mic.m4a": "только микрофон, это вы",
                "system.m4a": "только звук системы, это собеседник",
                "transcript.md": "расшифровка диалога",
                "transcript.json": "расшифровка диалога с метками времени в секундах",
                "interview-report.md": "итоги интервью: вопросы, подсказки, ответы и оценки",
            ],
            "timeline": "все файлы начинаются в один момент, метки времени совпадают",
        ]
        if let data = try? JSONSerialization.data(
            withJSONObject: info,
            options: [.prettyPrinted, .sortedKeys]
        ) {
            try? data.write(to: currentFolder.appendingPathComponent("session.json"))
        }
    }

    // MARK: Сон

    private func preventSleep() {
        sleepActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleDisplaySleepDisabled],
            reason: "Идёт запись собеседования"
        )
    }

    private func allowSleep() {
        if let sleepActivity {
            ProcessInfo.processInfo.endActivity(sleepActivity)
        }
        sleepActivity = nil
    }
}
