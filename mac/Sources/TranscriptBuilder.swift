import Foundation

enum Speaker: String, Codable {
    case interviewer = "Интервьюер"
    case me = "Я"
    case unknown = "Речь"
}

struct TranscriptSegment: Codable, Equatable {
    var start: Double
    var end: Double
    var speaker: Speaker
    var text: String
}

/// Собирает распознанные фразы двух дорожек в один диалог.
enum TranscriptBuilder {
    static func dialogue(mic: [TranscriptSegment], system: [TranscriptSegment]) -> [TranscriptSegment] {
        let cleanMic = removingEcho(from: mic, system: system)
        let ordered = (cleanMic + system).sorted { $0.start < $1.start }

        var turns: [TranscriptSegment] = []
        for segment in ordered {
            if let last = turns.last, last.speaker == segment.speaker {
                turns[turns.count - 1].end = max(last.end, segment.end)
                turns[turns.count - 1].text = last.text + " " + segment.text
            } else {
                turns.append(segment)
            }
        }
        return turns
    }

    /// Без наушников микрофон слышит собеседника из динамиков, и его слова приписывались бы вам.
    /// Фраза микрофона считается эхом, если в то же время почти те же слова звучали в системной дорожке.
    static func removingEcho(from mic: [TranscriptSegment], system: [TranscriptSegment]) -> [TranscriptSegment] {
        mic.filter { segment in
            let words = self.words(in: segment.text)
            guard words.count >= 2 else { return true }

            let systemWords = system
                .filter { $0.start <= segment.end + 1 && $0.end >= segment.start - 1 }
                .reduce(into: Set<String>()) { result, other in
                    result.formUnion(self.words(in: other.text))
                }
            guard !systemWords.isEmpty else { return true }

            let matches = words.filter { systemWords.contains($0) }.count
            return Double(matches) / Double(words.count) < 0.7
        }
    }

    static func markdown(turns: [TranscriptSegment], title: String) -> String {
        var lines = ["# Расшифровка собеседования", "", title, ""]
        if turns.isEmpty {
            lines.append("Речь не распознана.")
        }
        for turn in turns {
            lines.append("**[\(timestamp(turn.start))] \(turn.speaker.rawValue):** \(turn.text)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    static func json(turns: [TranscriptSegment]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        return try encoder.encode(turns)
    }

    static func timestamp(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%02d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
    }

    private static func words(in text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }
}
