import AVFoundation
import CoreMedia
import Foundation

/// Проверка микрофона: четыре секунды записи с индикатором уровня и воспроизведение результата.
final class MicrophoneTester: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private static let duration = 4.0

    private let queue = DispatchQueue(label: "interviewassistant.mictest", qos: .userInitiated)
    private let update: @Sendable ([String: Any]) -> Void
    private let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("interview-assistant-mic-test-\(UUID().uuidString).m4a")

    private var session: AVCaptureSession?
    private var file: TimelineAudioFile?
    private var start: CMTime?
    private var peak: Float = 0
    private var finished = false
    private var player: AVAudioPlayer?

    init(update: @escaping @Sendable ([String: Any]) -> Void) {
        self.update = update
    }

    func run(device: AVCaptureDevice) {
        queue.async {
            do {
                self.file = try TimelineAudioFile(url: self.url, channels: 1, bitRate: 64_000)
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
                output.setSampleBufferDelegate(self, queue: self.queue)
                guard session.canAddOutput(output) else { throw RecorderError.writerSetup }
                session.addOutput(output)

                self.session = session
                session.startRunning()
                self.update(["stage": "recording"])
                self.queue.asyncAfter(deadline: .now() + Self.duration) {
                    self.finishRecording()
                }
            } catch {
                self.update(["stage": "done", "error": error.localizedDescription, "peak": 0])
            }
        }
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard !finished, CMSampleBufferIsValid(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let origin = start ?? time
        start = origin
        let seconds = CMTimeGetSeconds(CMTimeSubtract(time, origin))
        if let level = try? file?.append(sampleBuffer, atSeconds: seconds) {
            peak = max(peak, level)
            update(["level": level])
        }
    }

    private func finishRecording() {
        guard !finished else { return }
        finished = true
        session?.stopRunning()
        session = nil
        file?.finish(totalSeconds: Self.duration)
        file = nil

        do {
            let player = try AVAudioPlayer(contentsOf: url)
            self.player = player
            player.play()
            update(["stage": "playing"])
            queue.asyncAfter(deadline: .now() + Self.duration + 0.2) {
                self.complete(error: nil)
            }
        } catch {
            complete(error: error.localizedDescription)
        }
    }

    private func complete(error: String?) {
        player?.stop()
        player = nil
        try? FileManager.default.removeItem(at: url)
        var result: [String: Any] = ["stage": "done", "peak": Double(peak)]
        if let error { result["error"] = error }
        update(result)
    }
}
