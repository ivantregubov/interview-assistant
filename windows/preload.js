'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appBridge', {
  // Команды интерфейса
  send: (action, value) => ipcRenderer.send('ui:action', action, value),
  onState: (handler) => ipcRenderer.on('ui:state', (_event, state) => handler(state)),

  // Захват идёт в окне приложения, файлы пишет основной процесс
  onCaptureStart: (handler) => ipcRenderer.on('capture:start', (_event, options) => handler(options)),
  onCaptureStop: (handler) => ipcRenderer.on('capture:stop', () => handler()),
  captureStarted: (info) => ipcRenderer.send('capture:started', info),
  captureFailed: (message) => ipcRenderer.send('capture:failed', message),
  captureStopped: () => ipcRenderer.send('capture:stopped'),
  videoChunk: (buffer) => ipcRenderer.send('capture:video', buffer),
  pcmChunk: (track, buffer, peak) => ipcRenderer.send('capture:pcm', track, buffer, peak),
  microphones: (list, granted) => ipcRenderer.send('capture:microphones', list, granted),

  // Звук из существующих файлов декодирует встроенный движок браузера
  onDecode: (handler) => ipcRenderer.on('decode:request', (_event, id, buffer) => handler(id, buffer)),
  decodeResult: (id, error, samples) => ipcRenderer.send('decode:result', id, error, samples),
});

ipcRenderer.on('coach:speech', (_event, track, text) => {
  window.postMessage({ coach: 'speech', track, text }, '*');
});
ipcRenderer.on('coach:llmDelta', (_event, id, text) => {
  window.postMessage({ coach: 'delta', id, text }, '*');
});
ipcRenderer.on('coach:llmDone', (_event, id, error) => {
  window.postMessage({ coach: 'done', id, error }, '*');
});
