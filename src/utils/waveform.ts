export const WAVEFORM_BARS = 200;

export async function computeWaveformPeaks(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const audioContext = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / WAVEFORM_BARS);
  const peaks = new Float32Array(WAVEFORM_BARS);
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    let max = 0;
    const start = bar * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let i = start; i < end; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > max) max = abs;
    }
    peaks[bar] = max;
  }
  return peaks;
}
