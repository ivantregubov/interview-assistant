// Сервис LLM для тестов: отвечает потоком, как настоящий API.
const http = require('http');
function start() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      seen.push({ auth: req.headers.authorization, model: body.model });
      if (req.headers.authorization === 'Bearer wrong') { res.writeHead(401); res.end('{}'); return; }
      const user = body.messages[body.messages.length - 1].content;
      const isEval = body.messages[0].content.startsWith('Оцени');
      let text = 'NONE';
      if (isEval) {
        if (/подпись|подписью/.test(user)) text = 'VERDICT: CORRECT\nCOMMENT: Ответ верный.';
        else if (/не знаю/.test(user)) text = 'VERDICT: WRONG\nCOMMENT: Ответа по сути нет: это протокол взаимодействия сервисов.';
        else text = 'VERDICT: PARTIAL\nCOMMENT: Назван брокер, но не сказано про партиции и консьюмер-группы.';
      } else if (/Новая фраза:.*JWT/s.test(user)) text = 'QUESTION: Что такое JWT?\n- Токен из трёх частей: header, payload, signature\n- Части кодируются в Base64URL\n- Подпись защищает от подмены\n- Данные не зашифрованы\n- Срок жизни задаёт поле exp\n- Отзыв сложен, поэтому TTL короткий';
      else if (/Новая фраза:.*REST/s.test(user)) text = 'QUESTION: Что такое REST?\n- Архитектурный стиль API\n- Ресурсы адресуются через URL\n- Методы GET, POST, PUT, DELETE\n- Сервер не хранит состояние клиента';
      else if (/Новая фраза:.*Kafka/s.test(user)) text = 'QUESTION: Как устроена Kafka?\n- Топики делятся на партиции\n- Сообщения хранятся в логе\n- Консьюмеры объединяются в группы';
      else if (/Новая фраза:.*шардирован/s.test(user)) text = 'QUESTION: Что такое шардирование?\n- Разделение данных между серверами\n- Ключ шардирования определяет сервер';
      else if (/готово/.test(user)) text = 'Готово';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < text.length; i += 6) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 6) } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, seen, server })));
}
module.exports = { start };
