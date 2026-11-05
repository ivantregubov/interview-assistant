(function () {
  'use strict';

  const bridge = window.appBridge;
  const TARGET_RATE = 16000;
  const VIDEO_TYPES = [
    { mime: 'video/mp4;codecs=avc1.640033,mp4a.40.2', extension: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.4d0033,mp4a.40.2', extension: 'mp4' },
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', extension: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.640033,opus', extension: 'mp4' },
    { mime: 'video/mp4;codecs=avc1,opus', extension: 'mp4' },
    { mime: 'video/mp4;codecs=vp9,opus', extension: 'mp4' },
    { mime: 'video/webm;codecs=h264,opus', extension: 'webm' },
    { mime: 'video/webm;codecs=vp9,opus', extension: 'webm' },
    { mime: 'video/webm', extension: 'webm' },
  ];

  let session = null;

  /* Микрофоны */
  async function reportMicrophones() {
    let granted = true;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
    } catch {
      granted = false;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const microphones = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId,
        name: device.label || `Микрофон ${index + 1}`,
      }));
    bridge.microphones(microphones, granted);
  }
  navigator.mediaDevices.addEventListener('devicechange', reportMicrophones);

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  async function makeTap(context, source, silence, sink, track, startAt) {
    const node = new AudioWorkletNode(context, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { targetRate: TARGET_RATE, startAt },
    });
    const finished = new Promise((resolve) => {
      node.port.onmessage = (event) => {
        if (event.data.done) {
          resolve();
        } else {
          bridge.pcmChunk(track, event.data.samples, event.data.peak);
        }
      };
    });
    silence.connect(node);
    if (source) source.connect(node);
    node.connect(sink);
    return { node, finished };
  }

  async function startCapture(options) {
    let display = null;
    let microphone = null;
    let context = null;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: options.videoWidth, max: options.videoWidth },
          height: { ideal: options.videoHeight, max: options.videoHeight },
        },
        audio: true,
      });
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.microphoneId ? { exact: options.microphoneId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      context = new AudioContext({ sampleRate: 48000 });
      await context.audioWorklet.addModule('pcm-worklet.js');
      await context.resume();

      const micSource = context.createMediaStreamSource(microphone);
      const hasSystemAudio = display.getAudioTracks().length > 0;
      const systemSource = hasSystemAudio ? context.createMediaStreamSource(display) : null;

      // Общая дорожка для видео: MediaRecorder записывает только одну аудиодорожку.
      const mix = context.createMediaStreamDestination();
      micSource.connect(mix);
      if (systemSource) systemSource.connect(mix);

      // Постоянный тихий сигнал не даёт дорожке остановиться, если устройство перестало присылать звук.
      const silence = context.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      const mute = context.createGain();
      mute.gain.value = 0;
      mute.connect(context.destination);

      const startAt = context.currentTime + 0.15;
      const micTap = await makeTap(context, micSource, silence, mute, 'mic', startAt);
      const systemTap = await makeTap(context, systemSource, silence, mute, 'system', startAt);

      const combined = new MediaStream([...display.getVideoTracks(), ...mix.stream.getAudioTracks()]);
      const type = VIDEO_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate.mime));
      if (!type) throw new Error('Этот компьютер не поддерживает запись видео.');

      const recorder = new MediaRecorder(combined, {
        mimeType: type.mime,
        videoBitsPerSecond: 4000000,
        audioBitsPerSecond: 128000,
      });

      // Блоб читается асинхронно, поэтому части записываем строго по очереди.
      let writes = Promise.resolve();
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          writes = writes.then(async () => bridge.videoChunk(await event.data.arrayBuffer()));
        }
      };

      recorder.onerror = (event) => {
        bridge.captureFailed((event.error && event.error.message) || 'Ошибка записи видео.');
      };

      const videoTrack = display.getVideoTracks()[0];
      videoTrack.addEventListener('ended', () => {
        bridge.captureFailed('Захват экрана прекратился.');
      });

      // Первые секунды записи и звук начинаются почти одновременно: ждём момент старта дорожек.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, (startAt - context.currentTime) * 1000)));
      recorder.start(1000);

      session = {
        display, microphone, context, recorder, micTap, systemTap, silence,
        get writes() { return writes; },
      };
      bridge.captureStarted({ extension: type.extension, hasSystemAudio });
    } catch (error) {
      stopTracks(display);
      stopTracks(microphone);
      if (context) context.close();
      bridge.captureFailed(error.message || String(error));
    }
  }

  async function stopCapture() {
    const current = session;
    session = null;
    if (!current) {
      bridge.captureStopped();
      return;
    }

    const stopAt = current.context.currentTime + 0.05;
    current.micTap.node.port.postMessage({ stopAt });
    current.systemTap.node.port.postMessage({ stopAt });

    const recorded = new Promise((resolve) => {
      current.recorder.onstop = resolve;
    });
    if (current.recorder.state !== 'inactive') current.recorder.stop();
    await recorded;
    await current.writes;
    await Promise.all([current.micTap.finished, current.systemTap.finished]);

    stopTracks(current.display);
    stopTracks(current.microphone);
    await current.context.close();
    bridge.captureStopped();
  }

  /* Декодирование существующих файлов в 16 кГц, моно */
  async function decodeFile(id, buffer) {
    try {
      const probe = new OfflineAudioContext(1, 1, TARGET_RATE);
      const decoded = await probe.decodeAudioData(buffer);
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      const floats = rendered.getChannelData(0);
      const samples = new Int16Array(floats.length);
      for (let index = 0; index < floats.length; index += 1) {
        const value = Math.max(-1, Math.min(1, floats[index]));
        samples[index] = value < 0 ? value * 32768 : value * 32767;
      }
      bridge.decodeResult(id, null, samples.buffer);
    } catch (error) {
      bridge.decodeResult(id, `Не удалось прочитать звук из файла: ${error.message}`, null);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.coach) return;
    const { coach, track, text, id, error } = event.data;
    if (coach === 'speech' && window.coachSpeech) window.coachSpeech(track, text, true);
    if (coach === 'delta' && window.coachLlmDelta) window.coachLlmDelta(id, text);
    if (coach === 'done' && window.coachLlmDone) window.coachLlmDone(id, error);
  });

  bridge.onCaptureStart(startCapture);
  bridge.onCaptureStop(stopCapture);
  bridge.onDecode(decodeFile);
  reportMicrophones();
})();
