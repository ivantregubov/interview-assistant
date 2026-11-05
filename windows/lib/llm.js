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

async function streamChat({ fetchImpl, url, provider, model, apiKey, messages, maxTokens, onText, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    const parse = createSseParser(onText);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
    parse('\n');
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('сервис не ответил вовремя');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { PROVIDERS, streamChat, createSseParser, httpError, requestBody };
