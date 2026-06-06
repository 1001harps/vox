import { useEffect, useRef, useState } from 'react'

const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]

// Autocorrelation pitch detection (after Chris Wilson's PitchDetect).
// Returns the fundamental frequency in Hz, or -1 if no clear pitch.
function detectPitch(buf: Float32Array, sampleRate: number): number {
  const size = buf.length

  // Bail if the signal is too quiet to have a reliable pitch.
  let rms = 0
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / size)
  if (rms < 0.01) return -1

  // Trim near-silent edges so the correlation locks onto the tone.
  const thres = 0.2
  let start = 0
  let end = size - 1
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buf[i]) < thres) { start = i; break }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buf[size - i]) < thres) { end = size - i; break }
  }

  const trimmed = buf.subarray(start, end)
  const n = trimmed.length
  const c = new Float32Array(n)
  for (let lag = 0; lag < n; lag++) {
    let sum = 0
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag]
    c[lag] = sum
  }

  // Skip the initial downslope, then find the highest correlation peak.
  let d = 0
  while (d < n - 1 && c[d] > c[d + 1]) d++
  let maxVal = -1
  let maxLag = -1
  for (let lag = d; lag < n; lag++) {
    if (c[lag] > maxVal) { maxVal = c[lag]; maxLag = lag }
  }
  if (maxLag <= 0) return -1

  // Parabolic interpolation around the peak for sub-sample accuracy.
  let t0 = maxLag
  const x1 = c[maxLag - 1]
  const x2 = c[maxLag]
  const x3 = c[maxLag + 1]
  const a = (x1 + x3 - 2 * x2) / 2
  const b = (x3 - x1) / 2
  if (a) t0 = maxLag - b / (2 * a)

  return sampleRate / t0
}

// Nearest note name + how many cents sharp/flat the pitch is.
function noteFromPitch(freq: number): { name: string; cents: number } {
  const midi = Math.round(12 * Math.log2(freq / 440) + 69)
  const refFreq = 440 * Math.pow(2, (midi - 69) / 12)
  const cents = Math.round(1200 * Math.log2(freq / refFreq))
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return { name: `${name}${octave}`, cents }
}

function App() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [volume, setVolume] = useState(0)
  const [pitch, setPitch] = useState(-1)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  // Populate the device list. Labels only appear once we have mic permission,
  // so refresh again after the stream starts.
  async function refreshDevices() {
    const all = await navigator.mediaDevices.enumerateDevices()
    setDevices(all.filter((d) => d.kind === 'audioinput'))
  }

  useEffect(() => {
    refreshDevices()
  }, [])

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    })
    streamRef.current = stream

    const audioContext = new AudioContext()
    audioContextRef.current = audioContext
    await audioContext.resume()

    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)

    const timeData = new Float32Array(analyser.fftSize)
    const sampleRate = audioContext.sampleRate

    // Stabilize the reading: smooth within a note, snap on note changes, and
    // hold the last note briefly after the sound fades (like a real tuner).
    const SMOOTHING = 0.2 // 0 = frozen, 1 = no smoothing
    const SNAP_CENTS = 60 // jumps bigger than this are treated as a new note
    const HOLD_MS = 750 // keep showing the last note this long after silence
    let smoothed = -1
    let lastGoodTime = 0

    const tick = () => {
      analyser.getFloatTimeDomainData(timeData)
      // RMS of the waveform -> perceived loudness, roughly 0..1
      let sum = 0
      for (let i = 0; i < timeData.length; i++) {
        sum += timeData[i] * timeData[i]
      }
      setVolume(Math.sqrt(sum / timeData.length))

      const raw = detectPitch(timeData, sampleRate)
      const now = performance.now()

      if (raw > 0) {
        const jumpCents =
          smoothed > 0 ? Math.abs(1200 * Math.log2(raw / smoothed)) : Infinity
        if (jumpCents > SNAP_CENTS) {
          smoothed = raw // new note (or first reading): jump straight to it
        } else {
          smoothed += SMOOTHING * (raw - smoothed) // same note: ease toward it
        }
        lastGoodTime = now
        setPitch(smoothed)
      } else if (now - lastGoodTime > HOLD_MS) {
        smoothed = -1
        setPitch(-1)
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    tick()

    setRunning(true)
    refreshDevices()
  }

  function stop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    audioContextRef.current?.close()
    rafRef.current = null
    streamRef.current = null
    audioContextRef.current = null
    setRunning(false)
    setVolume(0)
    setPitch(-1)
  }

  // Clean up on unmount.
  useEffect(() => stop, [])

  return (
    <>
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid #ccc',
        boxSizing: 'border-box',
      }}
    >
      <select
        value={deviceId}
        onChange={(e) => setDeviceId(e.target.value)}
        disabled={running}
        style={{
          fontSize: 16,
          padding: 8,
          flex: '1 1 180px',
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        <option value="">Default input</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>

      {running ? (
        <button onClick={stop} style={{ fontSize: 16, padding: '8px 16px' }}>
          Stop
        </button>
      ) : (
        <button onClick={start} style={{ fontSize: 16, padding: '8px 16px' }}>
          Start
        </button>
      )}

      <div
        style={{
          marginLeft: 'auto',
          fontSize: 28,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
        }}
      >
        {volume.toFixed(3)}
      </div>
    </nav>

    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 60px)',
        gap: 8,
      }}
    >
      {pitch > 0 ? (
        (() => {
          const { name, cents } = noteFromPitch(pitch)
          const inTune = Math.abs(cents) <= 5
          return (
            <>
              <div
                style={{
                  fontSize: 'clamp(80px, 28vw, 240px)',
                  fontWeight: 700,
                  lineHeight: 1,
                  color: inTune ? '#2e9e4f' : '#111',
                }}
              >
                {name}
              </div>
              <div
                style={{
                  fontSize: 24,
                  fontVariantNumeric: 'tabular-nums',
                  color: inTune ? '#2e9e4f' : '#c0392b',
                }}
              >
                {cents > 0 ? `+${cents}` : cents} cents
              </div>
              <div style={{ fontSize: 18, color: '#888' }}>
                {pitch.toFixed(1)} Hz
              </div>
            </>
          )
        })()
      ) : (
        <div
          style={{
            fontSize: 'clamp(80px, 28vw, 240px)',
            fontWeight: 700,
            lineHeight: 1,
            color: '#ccc',
          }}
        >
          —
        </div>
      )}
    </main>
    </>
  )
}

export default App
