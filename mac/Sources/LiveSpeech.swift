import AVFoundation
import Foundation
import Speech

/// Потоковое распознавание одной дорожки во время записи. Работает на этом Mac.
/// Сбой здесь не должен влиять на запись, поэтому звук сюда приходит копией и на отдельной очереди.
final class LiveSpeechTrack: @unchecked Sendable {
    private let queue = DispatchQueue(label: "interviewassistant.live", qos: .userInitiated)
    private let onText: @Sendable (String, Bool) -> Void

    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var targetFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var converterSource: AVAudioFormat?

    init(onText: @escaping @Sendable (String, Bool) -> Void) {
        self.onText = onText
    }

    /// Языки, для которых основной модуль не смог получить модель. Повторно на них время не тратим.
    private static var unavailableLocales = Set<String>()

    func start(locale: Locale) async throws {
        let handler = onText

        // Основной модуль может заявлять поддержку языка, но не иметь для него модели.
        // Тогда используем модуль системной диктовки.
        if SpeechTranscriber.isAvailable,
           !Self.unavailableLocales.contains(locale.identifier),
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            do {
                let transcriber = SpeechTranscriber(
                    locale: supported,
                    transcriptionOptions: [],
                    reportingOptions: [.volatileResults],
                    attributeOptions: []
                )
                try await TranscriptionService.installAssets(for: transcriber)
                let task = Task {
                    do {
                        for try await result in transcriber.results {
                            handler(String(result.text.characters), result.isFinal)
                        }
                    } catch {}
                }
                try await begin(module: transcriber, resultsTask: task)
                return
            } catch {
                Self.unavailableLocales.insert(locale.identifier)
                guard await DictationTranscriber.supportedLocale(equivalentTo: locale) != nil else { throw error }
            }
        }

        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else {
            throw TranscriptionError.unsupportedLanguage(locale.identifier)
        }
        let transcriber = DictationTranscriber(
            locale: supported,
            contentHints: [],
            transcriptionOptions: [.punctuation],
            reportingOptions: [.volatileResults],
            attributeOptions: []
        )
        try await TranscriptionService.installAssets(for: transcriber)
        let task = Task {
            do {
                for try await result in transcriber.results {
                    handler(String(result.text.characters), result.isFinal)
                }
            } catch {}
        }
        try await begin(module: transcriber, resultsTask: task)
    }

    private func begin(module: any SpeechModule, resultsTask task: Task<Void, Never>) async throws {
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            task.cancel()
            throw TranscriptionError.cannotReadAudio
        }

        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [module])
        do {
            try await analyzer.start(inputSequence: stream)
        } catch {
            task.cancel()
            throw error
        }

        queue.sync {
            self.targetFormat = format
            self.analyzer = analyzer
            self.continuation = continuation
            self.resultsTask = task
        }
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        queue.async {
            guard let continuation = self.continuation, let converted = self.convert(buffer) else { return }
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    func stop() {
        queue.async {
            let continuation = self.continuation
            let analyzer = self.analyzer
            let task = self.resultsTask
            self.continuation = nil
            self.analyzer = nil
            self.resultsTask = nil
            continuation?.finish()
            // Завершение идёт в фоне: остановка записи его не ждёт.
            Task {
                try? await analyzer?.finalizeAndFinishThroughEndOfInput()
                task?.cancel()
            }
        }
    }

    private func convert(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let target = targetFormat else { return nil }
        if source.format == target { return source }

        if converter == nil || converterSource != source.format {
            converter = AVAudioConverter(from: source.format, to: target)
            converterSource = source.format
        }
        guard let converter else { return nil }

        let ratio = target.sampleRate / source.format.sampleRate
        let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return source
        }
        if status == .error || output.frameLength == 0 { return nil }
        return output
    }
}
