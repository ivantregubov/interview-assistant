import AVFoundation
import CoreMedia
import Foundation
import Speech
import UniformTypeIdentifiers

enum TranscriptionError: LocalizedError {
    case missingAudio
    case cannotReadAudio
    case unsupportedLanguage(String)

    var errorDescription: String? {
        switch self {
        case .missingAudio:
            return "В папке нет файлов mic.m4a и system.m4a."
        case .cannotReadAudio:
            return "Не удалось прочитать звук из файла."
        case .unsupportedLanguage(let language):
            return "macOS не поддерживает распознавание языка \(language) на этом Mac."
        }
    }
}

/// Распознавание идёт на самом Mac средствами macOS. Аудио никуда не отправляется,
/// с серверов Apple при первом запуске скачивается только языковая модель.
enum TranscriptionService {
    /// Распознаёт дорожки записи и сохраняет transcript.md и transcript.json в её папку.
    static func transcribe(
        folder: URL,
        languageIdentifier: String,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> URL {
        let micURL = folder.appendingPathComponent("mic.m4a")
        let systemURL = folder.appendingPathComponent("system.m4a")
        guard FileManager.default.fileExists(atPath: micURL.path),
              FileManager.default.fileExists(atPath: systemURL.path)
        else { throw TranscriptionError.missingAudio }

        let locale = Locale(identifier: languageIdentifier)

        let mic = try await transcribeTrack(url: micURL, speaker: .me, locale: locale) { fraction in
            onProgress(fraction * 0.5)
        }
        let system = try await transcribeTrack(url: systemURL, speaker: .interviewer, locale: locale) { fraction in
            onProgress(0.5 + fraction * 0.5)
        }

        let turns = TranscriptBuilder.dialogue(mic: mic, system: system)
        let markdown = TranscriptBuilder.markdown(turns: turns, title: "Запись: \(folder.lastPathComponent)")

        let transcriptURL = folder.appendingPathComponent("transcript.md")
        try markdown.write(to: transcriptURL, atomically: true, encoding: .utf8)
        try TranscriptBuilder.json(turns: turns).write(to: folder.appendingPathComponent("transcript.json"))
        onProgress(1)
        return transcriptURL
    }

    /// Распознаёт отдельный файл без разделения на собеседников.
    /// Рядом с ним появляются файлы с окончанием .transcript.md и .transcript.json.
    static func transcribe(
        file: URL,
        languageIdentifier: String,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> URL {
        let locale = Locale(identifier: languageIdentifier)
        let audio = try await audioFile(for: file)
        defer {
            if audio != file {
                try? FileManager.default.removeItem(at: audio)
            }
        }

        let segments = try await transcribeTrack(url: audio, speaker: .unknown, locale: locale, onProgress: onProgress)
        let markdown = TranscriptBuilder.markdown(turns: segments, title: "Файл: \(file.lastPathComponent)")

        let base = file.deletingPathExtension().lastPathComponent + ".transcript"
        let folder = file.deletingLastPathComponent()
        let transcriptURL = folder.appendingPathComponent(base + ".md")
        try markdown.write(to: transcriptURL, atomically: true, encoding: .utf8)
        try TranscriptBuilder.json(turns: segments).write(to: folder.appendingPathComponent(base + ".json"))
        onProgress(1)
        return transcriptURL
    }

    /// Из видео сначала извлекаем звук во временный файл, аудио используем как есть.
    private static func audioFile(for file: URL) async throws -> URL {
        let type = UTType(filenameExtension: file.pathExtension)
        guard type?.conforms(to: .movie) == true else { return file }

        let asset = AVURLAsset(url: file)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw TranscriptionError.cannotReadAudio
        }
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("m4a")
        session.outputURL = output
        session.outputFileType = .m4a
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously {
                continuation.resume()
            }
        }
        guard session.status == .completed else {
            throw session.error ?? TranscriptionError.cannotReadAudio
        }
        return output
    }

    private static func transcribeTrack(
        url: URL,
        speaker: Speaker,
        locale: Locale,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> [TranscriptSegment] {
        // SpeechTranscriber точнее, но поддерживает меньше языков. Если он не подходит или не сработал,
        // используем DictationTranscriber: это те же модели, что и в системной диктовке.
        if SpeechTranscriber.isAvailable,
           let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            do {
                return try await transcribeWithSpeechTranscriber(
                    url: url,
                    speaker: speaker,
                    locale: supported,
                    onProgress: onProgress
                )
            } catch {
                guard await DictationTranscriber.supportedLocale(equivalentTo: locale) != nil else { throw error }
            }
        }

        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else {
            throw TranscriptionError.unsupportedLanguage(languageIdentifier(for: locale))
        }
        return try await transcribeWithDictation(
            url: url,
            speaker: speaker,
            locale: supported,
            onProgress: onProgress
        )
    }

    private static func transcribeWithSpeechTranscriber(
        url: URL,
        speaker: Speaker,
        locale: Locale,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> [TranscriptSegment] {
        let file = try AVAudioFile(forReading: url)
        let duration = duration(of: file)

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        try await installAssets(for: transcriber)

        let collector = Task { () throws -> [TranscriptSegment] in
            var segments: [TranscriptSegment] = []
            for try await result in transcriber.results {
                append(
                    text: String(result.text.characters),
                    range: result.range,
                    speaker: speaker,
                    duration: duration,
                    to: &segments,
                    onProgress: onProgress
                )
            }
            return segments
        }

        try await analyze(file: file, module: transcriber, collector: collector)
        return try await collector.value
    }

    private static func transcribeWithDictation(
        url: URL,
        speaker: Speaker,
        locale: Locale,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> [TranscriptSegment] {
        let file = try AVAudioFile(forReading: url)
        let duration = duration(of: file)

        let transcriber = DictationTranscriber(locale: locale, preset: .longDictation)
        try await installAssets(for: transcriber)

        let collector = Task { () throws -> [TranscriptSegment] in
            var segments: [TranscriptSegment] = []
            for try await result in transcriber.results {
                append(
                    text: String(result.text.characters),
                    range: result.range,
                    speaker: speaker,
                    duration: duration,
                    to: &segments,
                    onProgress: onProgress
                )
            }
            return segments
        }

        try await analyze(file: file, module: transcriber, collector: collector)
        return try await collector.value
    }

    static func installAssets(for module: any SpeechModule) async throws {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await request.downloadAndInstall()
        }
    }

    private static func analyze(
        file: AVAudioFile,
        module: any SpeechModule,
        collector: Task<[TranscriptSegment], Error>
    ) async throws {
        let analyzer = SpeechAnalyzer(modules: [module])
        do {
            if let lastSample = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }
        } catch {
            collector.cancel()
            throw error
        }
    }

    private static func append(
        text: String,
        range: CMTimeRange,
        speaker: Speaker,
        duration: Double,
        to segments: inout [TranscriptSegment],
        onProgress: @Sendable (Double) -> Void
    ) {
        let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
        if duration > 0 {
            onProgress(min(end / duration, 1))
        }

        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        segments.append(TranscriptSegment(
            start: CMTimeGetSeconds(range.start),
            end: end,
            speaker: speaker,
            text: cleaned
        ))
    }

    private static func duration(of file: AVAudioFile) -> Double {
        Double(file.length) / file.processingFormat.sampleRate
    }

    private static func languageIdentifier(for locale: Locale) -> String {
        Locale(identifier: "ru_RU").localizedString(forIdentifier: locale.identifier) ?? locale.identifier
    }
}
