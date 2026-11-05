import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

enum RecorderError: LocalizedError {
    case displayNotFound
    case writerSetup
    case writerFailed(String)
    case noFrames

    var errorDescription: String? {
        switch self {
        case .displayNotFound: return "Выбранный экран не найден."
        case .writerSetup: return "Не удалось подготовить файл записи."
        case .writerFailed(let details): return "Ошибка записи файла: \(details)"
        case .noFrames: return "С экрана не пришло ни одного кадра."
        }
    }
}

/// Одна аудиодорожка в отдельном .m4a. Позиция в файле всегда соответствует времени записи:
/// если буферов не было (тишина, отвал устройства), промежуток заполняется нулями.
/// Поэтому метки времени из расшифровок mic.m4a и system.m4a можно сводить в один диалог.
final class TimelineAudioFile {
    private var file: AVAudioFile?
    private let format: AVAudioFormat
    private var framesWritten: AVAudioFramePosition = 0
    private var converter: AVAudioConverter?
    private var converterSource: AVAudioFormat?
    private var pendingPeak: Float = 0
    private var framesSinceLevel: AVAudioFrameCount = 0

    init(url: URL, channels: Int, bitRate: Int) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: bitRate,
        ]
        let audioFile = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        file = audioFile
        format = audioFile.processingFormat
    }

    /// Примерно 10 раз в секунду возвращает пиковый уровень от 0 до 1 для индикатора, в остальное время nil.
    func append(_ sampleBuffer: CMSampleBuffer, atSeconds seconds: Double) throws -> Float? {
        guard let file,
              let source = Self.makePCMBuffer(from: sampleBuffer),
              let buffer = convert(source)
        else { return nil }

        let expected = AVAudioFramePosition((seconds * format.sampleRate).rounded())
        let tolerance = AVAudioFramePosition(format.sampleRate * 0.05)
        if expected - framesWritten > tolerance {
            try writeSilence(frames: expected - framesWritten)
        }
        try file.write(from: buffer)
        framesWritten += AVAudioFramePosition(buffer.frameLength)

        pendingPeak = max(pendingPeak, Self.peak(of: buffer))
        framesSinceLevel += buffer.frameLength
        guard framesSinceLevel >= 4_800 else { return nil }
        let level = pendingPeak
        pendingPeak = 0
        framesSinceLevel = 0
        return level
    }

    /// Дополняет файл тишиной до конца записи и закрывает его.
    func finish(totalSeconds: Double) {
        let total = AVAudioFramePosition((totalSeconds * format.sampleRate).rounded())
        if total > framesWritten {
            try? writeSilence(frames: total - framesWritten)
        }
        // AVAudioFile дописывает служебные данные при освобождении объекта.
        file = nil
    }

    private func writeSilence(frames: AVAudioFramePosition) throws {
        guard let file else { return }
        var remaining = frames
        while remaining > 0 {
            let count = AVAudioFrameCount(min(remaining, 48_000))
            guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count),
                  let channels = silence.floatChannelData
            else { return }
            silence.frameLength = count
            for channel in 0..<Int(format.channelCount) {
                channels[channel].initialize(repeating: 0, count: Int(count))
            }
            try file.write(from: silence)
            framesWritten += AVAudioFramePosition(count)
            remaining -= AVAudioFramePosition(count)
        }
    }

    private func convert(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if source.format == format { return source }

        if converter == nil || converterSource != source.format {
            converter = AVAudioConverter(from: source.format, to: format)
            converterSource = source.format
        }
        guard let converter else { return nil }

        let ratio = format.sampleRate / source.format.sampleRate
        let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

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

    static func makePCMBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return nil }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return nil }

        let sourceFormat = AVAudioFormat(cmAudioFormatDescription: description)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            frameCapacity: AVAudioFrameCount(frames)
        ) else { return nil }

        buffer.frameLength = AVAudioFrameCount(frames)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: buffer.mutableAudioBufferList
        )
        return status == noErr ? buffer : nil
    }

    private static func peak(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channels = buffer.floatChannelData else { return 0 }
        var peak: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            for frame in 0..<Int(buffer.frameLength) {
                peak = max(peak, abs(channels[channel][frame]))
            }
        }
        return peak
    }
}

/// Захват экрана, звука системы и микрофона.
/// Все колбэки приходят на одну последовательную очередь, поэтому состояние записи не требует блокировок.
final class CaptureEngine: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    var onMicLevel: (@Sendable (Float) -> Void)?
    var onSystemLevel: (@Sendable (Float) -> Void)?
    /// Копии звука для распознавания во время записи.
    var onMicBuffer: (@Sendable (AVAudioPCMBuffer) -> Void)?
    var onSystemBuffer: (@Sendable (AVAudioPCMBuffer) -> Void)?
    /// Запись оборвалась сама: экран отключили, закончилось место на диске и тому подобное.
    var onFailure: (@Sendable (String) -> Void)?

    private let queue = DispatchQueue(label: "interviewassistant.capture", qos: .userInitiated)

    private var stream: SCStream?
    private var micSession: AVCaptureSession?
    private var micClock: CMClock?

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var systemInput: AVAssetWriterInput?
    private var micFile: TimelineAudioFile?
    private var systemFile: TimelineAudioFile?

    private var origin: CMTime?
    private var lastVideoSample: CMSampleBuffer?
    private var isFinishing = false
    private var failureReported = false

    // MARK: Запуск

    func start(displayID: CGDirectDisplayID, microphone: AVCaptureDevice, folder: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw RecorderError.displayNotFound
        }

        // Окно самого приложения в запись не попадает.
        let ownApps = content.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])

        let size = Self.outputSize(for: display)

        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 6
        configuration.showsCursor = true
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        #if compiler(>=6.0)
        if #available(macOS 15.0, *) {
            configuration.showMouseClicks = true
        }
        #endif

        try prepareOutput(folder: folder, width: size.width, height: size.height)
        try startMicrophone(microphone)

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
    }

    private static func outputSize(for display: SCDisplay) -> (width: Int, height: Int) {
        var scale = 2.0
        if let mode = CGDisplayCopyDisplayMode(display.displayID), display.width > 0 {
            scale = Double(mode.pixelWidth) / Double(display.width)
        }
        var width = Double(display.width) * scale
        var height = Double(display.height) * scale

        // Для разбора собеседования хватает 1080p: текст читается, файл остаётся разумного размера.
        let longSide = max(width, height)
        if longSide > 1920 {
            width *= 1920 / longSide
            height *= 1920 / longSide
        }
        // H.264 требует чётные размеры.
        return (Int(width) / 2 * 2, Int(height) / 2 * 2)
    }

    private func prepareOutput(folder: URL, width: Int, height: Int) throws {
        let writer = try AVAssetWriter(outputURL: folder.appendingPathComponent("screen.mov"), fileType: .mov)
        // Фрагменты каждые 10 секунд: при сбое или отключении питания запись до этого момента сохранится.
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 4_000_000,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ]
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        video.expectsMediaDataInRealTime = true

        let mic = Self.makeAudioInput(channels: 1, bitRate: 64_000)
        let system = Self.makeAudioInput(channels: 2, bitRate: 128_000)

        // Порядок дорожек в screen.mov: видео, микрофон, звук системы.
        for input in [video, mic, system] {
            guard writer.canAdd(input) else { throw RecorderError.writerSetup }
            writer.add(input)
        }

        micFile = try TimelineAudioFile(
            url: folder.appendingPathComponent("mic.m4a"),
            channels: 1,
            bitRate: 64_000
        )
        systemFile = try TimelineAudioFile(
            url: folder.appendingPathComponent("system.m4a"),
            channels: 2,
            bitRate: 128_000
        )

        guard writer.startWriting() else {
            throw RecorderError.writerFailed(writer.error?.localizedDescription ?? "неизвестная ошибка")
        }

        self.writer = writer
        videoInput = video
        micInput = mic
        systemInput = system
    }

    private static func makeAudioInput(channels: Int, bitRate: Int) -> AVAssetWriterInput {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: bitRate,
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        return input
    }

    private func startMicrophone(_ device: AVCaptureDevice) throws {
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw RecorderError.writerSetup }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw RecorderError.writerSetup }
        session.addOutput(output)

        micSession = session
        micClock = session.synchronizationClock
        session.startRunning()
    }

    // MARK: Остановка

    /// Возвращает длительность записи в секундах. Файлы к этому моменту полностью закрыты.
    func stop() async throws -> Double {
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        micSession?.stopRunning()
        micSession = nil

        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.finishWriting { result in
                    continuation.resume(with: result)
                }
            }
        }
    }

    private func finishWriting(completion: @escaping (Result<Double, Error>) -> Void) {
        isFinishing = true

        guard let writer, let origin else {
            self.writer?.cancelWriting()
            micFile?.finish(totalSeconds: 0)
            systemFile?.finish(totalSeconds: 0)
            micFile = nil
            systemFile = nil
            completion(.failure(RecorderError.noFrames))
            return
        }

        var end = CMClockGetTime(CMClockGetHostTimeClock())
        if let last = lastVideoSample {
            let lastTime = CMSampleBufferGetPresentationTimeStamp(last)
            if CMTimeCompare(end, lastTime) <= 0 {
                end = lastTime
            } else if let videoInput, videoInput.isReadyForMoreMediaData {
                // При статичном экране кадры не приходят, поэтому последний кадр повторяем в момент остановки,
                // иначе видео окажется короче звука.
                let timing = CMSampleTimingInfo(
                    duration: CMSampleBufferGetDuration(last),
                    presentationTimeStamp: end,
                    decodeTimeStamp: .invalid
                )
                if let finalFrame = try? CMSampleBuffer(copying: last, withNewTiming: [timing]) {
                    videoInput.append(finalFrame)
                }
            }
        }
        lastVideoSample = nil

        let duration = CMTimeGetSeconds(CMTimeSubtract(end, origin))
        micFile?.finish(totalSeconds: duration)
        systemFile?.finish(totalSeconds: duration)
        micFile = nil
        systemFile = nil

        if writer.status == .writing {
            writer.endSession(atSourceTime: end)
            videoInput?.markAsFinished()
            micInput?.markAsFinished()
            systemInput?.markAsFinished()
            writer.finishWriting {
                if writer.status == .completed {
                    completion(.success(duration))
                } else {
                    let details = writer.error?.localizedDescription ?? "неизвестная ошибка"
                    completion(.failure(RecorderError.writerFailed(details)))
                }
            }
        } else {
            let details = writer.error?.localizedDescription ?? "неизвестная ошибка"
            completion(.failure(RecorderError.writerFailed(details)))
        }
    }

    // MARK: Экран и звук системы

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferIsValid(sampleBuffer), !isFinishing else { return }
        if type == .screen {
            handleVideo(sampleBuffer)
        } else if type == .audio {
            handleAudio(
                sampleBuffer,
                input: systemInput,
                file: systemFile,
                levelHandler: onSystemLevel,
                bufferHandler: onSystemBuffer
            )
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        reportFailure(error.localizedDescription)
    }

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        // Статус .idle означает, что экран не менялся: изображения в таком буфере нет.
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus),
            status == .complete,
            CMSampleBufferGetImageBuffer(sampleBuffer) != nil,
            let writer,
            let videoInput
        else { return }

        guard writer.status == .writing else {
            checkWriter()
            return
        }

        if origin == nil {
            let start = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: start)
            origin = start
        }

        if videoInput.isReadyForMoreMediaData {
            if videoInput.append(sampleBuffer) {
                lastVideoSample = sampleBuffer
            } else {
                checkWriter()
            }
        }
    }

    // MARK: Микрофон

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard CMSampleBufferIsValid(sampleBuffer), !isFinishing else { return }
        guard let retimed = convertToHostClock(sampleBuffer) else { return }
        handleAudio(retimed, input: micInput, file: micFile, levelHandler: onMicLevel, bufferHandler: onMicBuffer)
    }

    /// Метки времени ScreenCaptureKit идут по часам хоста, а микрофона по часам своей сессии.
    private func convertToHostClock(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let clock = micClock else { return sampleBuffer }

        let original = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let converted = CMSyncConvertTime(original, from: clock, to: CMClockGetHostTimeClock())
        if abs(CMTimeGetSeconds(CMTimeSubtract(converted, original))) < 0.001 {
            return sampleBuffer
        }

        let timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sampleBuffer),
            presentationTimeStamp: converted,
            decodeTimeStamp: .invalid
        )
        return try? CMSampleBuffer(copying: sampleBuffer, withNewTiming: [timing])
    }

    // MARK: Общая запись звука

    private func handleAudio(
        _ sampleBuffer: CMSampleBuffer,
        input: AVAssetWriterInput?,
        file: TimelineAudioFile?,
        levelHandler: (@Sendable (Float) -> Void)?,
        bufferHandler: (@Sendable (AVAudioPCMBuffer) -> Void)?
    ) {
        // Пока нет первого кадра, нет и начала временной шкалы.
        guard let origin, let writer, writer.status == .writing else { return }

        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard CMTimeCompare(time, origin) >= 0 else { return }

        if let input, input.isReadyForMoreMediaData, !input.append(sampleBuffer) {
            checkWriter()
        }

        if let bufferHandler, let copy = TimelineAudioFile.makePCMBuffer(from: sampleBuffer) {
            bufferHandler(copy)
        }

        do {
            let seconds = CMTimeGetSeconds(CMTimeSubtract(time, origin))
            if let peak = try file?.append(sampleBuffer, atSeconds: seconds) {
                levelHandler?(peak)
            }
        } catch {
            reportFailure(error.localizedDescription)
        }
    }

    private func checkWriter() {
        if let writer, writer.status == .failed {
            reportFailure(writer.error?.localizedDescription ?? "ошибка записи файла")
        }
    }

    private func reportFailure(_ message: String) {
        queue.async {
            guard !self.failureReported, !self.isFinishing else { return }
            self.failureReported = true
            self.onFailure?(message)
        }
    }
}
