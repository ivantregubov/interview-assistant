import Foundation
import Security

enum LLMProvider: String {
    case deepseek
    case openrouter

    var url: URL {
        switch self {
        case .deepseek: return URL(string: "https://api.deepseek.com/chat/completions")!
        case .openrouter: return URL(string: "https://openrouter.ai/api/v1/chat/completions")!
        }
    }

    var defaultModel: String {
        switch self {
        case .deepseek: return "deepseek-flash"
        case .openrouter: return "deepseek/deepseek-v4-flash"
        }
    }

    /// Режим рассуждений заметно увеличивает задержку, для подсказок он не нужен.
    var extraParameters: [String: Any] {
        switch self {
        case .deepseek: return ["thinking": ["type": "disabled"]]
        case .openrouter: return ["reasoning": ["enabled": false]]
        }
    }
}

enum LLMError: LocalizedError {
    case service(String)

    var errorDescription: String? {
        switch self {
        case .service(let message): return message
        }
    }
}

enum LLMClient {
    /// Отправляет запрос и передаёт текст ответа по мере его поступления.
    @MainActor
    static func stream(
        provider: LLMProvider,
        model: String,
        apiKey: String,
        messages: [[String: Any]],
        maxTokens: Int,
        onText: (String) -> Void
    ) async throws {
        var body: [String: Any] = [
            "model": model,
            "messages": messages,
            "max_tokens": maxTokens,
            "temperature": 0.2,
            "stream": true,
        ]
        body.merge(provider.extraParameters) { _, new in new }

        var request = URLRequest(url: provider.url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("Interview Assistant", forHTTPHeaderField: "X-Title")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var errorBody = ""
            for try await line in bytes.lines {
                errorBody += line
                if errorBody.count > 2000 { break }
            }
            throw LLMError.service(errorMessage(status: status, body: errorBody))
        }

        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            if let text = deltaText(payload) {
                onText(text)
            }
        }
    }

    private static func deltaText(_ payload: String) -> String? {
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = object["choices"] as? [[String: Any]],
              let delta = choices.first?["delta"] as? [String: Any],
              let content = delta["content"] as? String,
              !content.isEmpty
        else { return nil }
        return content
    }

    private static func errorMessage(status: Int, body: String) -> String {
        switch status {
        case 401, 403: return "неверный API-ключ"
        case 402: return "на счёте сервиса недостаточно средств"
        case 404: return "модель не найдена, проверьте её название в настройках"
        case 429: return "превышен лимит запросов сервиса"
        default:
            if let data = body.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let error = object["error"] as? [String: Any],
               let message = error["message"] as? String {
                return "сервис ответил: \(message)"
            }
            return "сервис ответил кодом \(status)"
        }
    }
}

/// API-ключи хранятся в Связке ключей macOS, у каждого сервиса свой.
enum APIKeyStore {
    // Имя осталось от прежнего названия приложения: так сохранённые ключи не придётся вводить заново.
    private static let service = "local.ivan.interviewrecorder.apikey"

    private static func baseQuery(_ provider: LLMProvider) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider.rawValue,
        ]
    }

    /// Проверка без чтения самого ключа: она не вызывает системный запрос пароля.
    static func exists(_ provider: LLMProvider) -> Bool {
        var query = baseQuery(provider)
        query[kSecReturnAttributes as String] = true
        var result: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess
    }

    static func load(_ provider: LLMProvider) -> String? {
        var query = baseQuery(provider)
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ value: String, for provider: LLMProvider) -> Bool {
        SecItemDelete(baseQuery(provider) as CFDictionary)
        var query = baseQuery(provider)
        query[kSecValueData as String] = Data(value.utf8)
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ provider: LLMProvider) {
        SecItemDelete(baseQuery(provider) as CFDictionary)
    }
}
