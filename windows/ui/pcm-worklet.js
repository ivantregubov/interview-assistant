/* Пишет дорожку в 16 кГц, моно. Обе дорожки идут от одного аудиоклока, поэтому метки времени совпадают,
   а если устройство замолчало, в файл попадает тишина и выравнивание не сбивается. */
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions;
    this.targetRate = settings.targetRate;
    this.startAt = settings.startAt;
    this.stopAt = Infinity;
    // Части по 0,2 с: живое распознавание начинает работу без лишней задержки.
    this.chunk = new Int16Array(Math.floor(settings.targetRate / 5));
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.phase = 0;
    this.peak = 0;
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data.stopAt !== undefined) this.stopAt = event.data.stopAt;
    };
  }

  flush() {
    if (this.filled === 0) return;
    const samples = this.chunk.slice(0, this.filled);
    this.port.postMessage({ samples: samples.buffer, peak: this.peak }, [samples.buffer]);
    this.filled = 0;
    this.peak = 0;
  }

  process(inputs) {
    if (this.finished) return false;
    if (currentTime < this.startAt) return true;

    if (currentTime >= this.stopAt) {
      this.flush();
      this.finished = true;
      this.port.postMessage({ done: true });
      return false;
    }

    const channels = inputs[0];
    const frames = channels.length ? channels[0].length : 128;
    const step = this.targetRate / sampleRate;

    for (let frame = 0; frame < frames; frame += 1) {
      let value = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        value += channels[channel][frame];
      }
      if (channels.length > 1) value /= channels.length;

      // Усреднение отсчётов внутри интервала заодно убирает частоты, которые не помещаются в 16 кГц.
      this.sum += value;
      this.count += 1;
      this.phase += step;

      if (this.phase >= 1) {
        this.phase -= 1;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.peak = Math.max(this.peak, Math.abs(sample));
        this.chunk[this.filled] = sample < 0 ? sample * 32768 : sample * 32767;
        this.filled += 1;
        if (this.filled === this.chunk.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
