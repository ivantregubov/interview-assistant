'use strict';

const PROVIDERS = {
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-flash',
    // Режим рассуждений заметно увеличивает задержку, для подсказок он не нужен.
    extra: { thinking: { type: 'disabled' } },
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'deepseek/deepseek-v4-flash',
    extra: { reasoning: { enabled: false } },
  },
};

function requestBody(provider, model, messages, maxTokens) {
  return JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    stream: true,
    ...PROVIDERS[provider].extra,
  });
}

/** Понятный текст вместо необработанного ответа сервиса. */
function httpError(status, body) {
  if (status === 401 || status === 403) return 'неверный API-ключ';
  if (status === 402) return 'на счёте сервиса недостаточно средств';
  if (status === 404) return 'модель не найдена, проверьте её название в настройках';
  if (status === 429) return 'превышен лимит запросов сервиса';
  let message = '';
  try {
    message = JSON.parse(body).error.message;
  } catch {
    message = '';
  }
  return message ? `сервис ответил: ${message}` : `сервис ответил кодом ${status}`;
}

/** Выделяет текст из потока Server-Sent Events. Строки могут быть разрезаны между частями. */
function createSseParser(onText) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) onText(delta);
      } catch {
        // Служебные строки сервиса пропускаем.
      }
    }
  };
}

/**
 * Таймаут считается от последней активности сервиса, а не от начала запроса:
 * длинный ответ не обрывается, а зависший запрос быстро освобождает очередь подсказок.
 */
async function streamChat({ fetchImpl, url, provider, model, apiKey, messages, maxTokens, onText, idleTimeoutMs = 12000 }) {
  const controller = new AbortController();
  const started = Date.now();
  let firstByteMs = null;
  let textLength = 0;
  let timer = null;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  touch();
  try {
    const response = await fetchImpl(url || PROVIDERS[provider].url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'Interview Assistant',
      },
      body: requestBody(provider, model, messages, maxTokens),
    });
    if (!response.ok) {
      throw new Error(httpError(response.status, await response.text()));
    }
    const parse = createSseParser((text) => {
      textLength += text.length;
      onText(text);
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Date.now() - started;
      touch();
      parse(decoder.decode(value, { stream: true }));
    }
    parse('\n');
    return { firstByteMs, totalMs: Date.now() - started, textLength };
  } catch (error) {
    if (error.name === 'AbortError' || controller.signal.aborted) {
      const timeout = new Error('сервис не ответил вовремя');
      timeout.isTimeout = true;
      timeout.textLength = textLength;
      throw timeout;
    }
    error.textLength = textLength;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { PROVIDERS, streamChat, createSseParser, httpError, requestBody };
