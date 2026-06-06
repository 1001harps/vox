import { useCallback, useEffect, useRef, useState } from 'react'

const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]

// Lenient periodicity check: reject only clearly aperiodic frames (broadband
// noise, transients). Kept low on purpose so it works across all mics and the
// full vocal range -- voice is the priority, not perfect noise rejection.
const CLARITY_THRESHOLD = 0.5

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
  if (maxLag <= 0 || maxLag >= n - 1) return -1

  // Clarity = peak correlation relative to zero-lag energy (c[0]). Periodic
  // tones approach 1; noise/transients stay low. Reject anything too low.
  if (maxVal / c[0] < CLARITY_THRESHOLD) return -1

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

// Piano-roll vertical range: E2 (guitar low E) up to C6.
const MIN_MIDI = 40
const MAX_MIDI = 84
const LANES = MAX_MIDI - MIN_MIDI + 1

// How many seconds of pitch history the X axis spans (now at the right edge).
const WINDOW_MS = 6000

// One pitch reading over time. `midi` is NaN for frames with no detected pitch,
// which breaks the contour into separate phrases.
type Sample = { t: number; midi: number }

// Continuous MIDI number for a frequency (float, for smooth dot placement).
function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440)
}

function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12)
}

// idle = nothing running, monitoring = live graph only, recording = monitor +
// capture, playing = playing back a recorded clip.
type Status = 'idle' | 'monitoring' | 'recording' | 'playing'

// A saved take. In-memory only for now -- lost on refresh.
type Recording = {
  id: string
  createdAt: number // ms epoch, captured when recording started
  durationMs: number
  url: string // object URL for the captured blob
}

// Which screen is showing.
type View = 'graph' | 'list'

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

const WAVEFORM_BARS = 200

async function computeWaveformPeaks(url: string): Promise<Float32Array> {
  const response = await fetch(url)
  const arrayBuffer = await response.arrayBuffer()
  const audioContext = new OfflineAudioContext(1, 1, 44100)
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  const channelData = audioBuffer.getChannelData(0)
  const samplesPerBar = Math.floor(channelData.length / WAVEFORM_BARS)
  const peaks = new Float32Array(WAVEFORM_BARS)
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    let max = 0
    const start = bar * samplesPerBar
    const end = Math.min(start + samplesPerBar, channelData.length)
    for (let i = start; i < end; i++) {
      const abs = Math.abs(channelData[i])
      if (abs > max) max = abs
    }
    peaks[bar] = max
  }
  return peaks
}

function App() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [status, setStatus] = useState<Status>('idle')
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [view, setView] = useState<View>('graph')
  const [volume, setVolume] = useState(0)
  const [pitch, setPitch] = useState(-1)
  const [hasInteracted, setHasInteracted] = useState(false)
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null)
  const [waveformPeaks, setWaveformPeaks] = useState<Float32Array | null>(null)
  const [isPaused, setIsPaused] = useState(false)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const graphRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef<Sample[]>([])

  // Recording capture + playback element.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const recordStartRef = useRef<number>(0) // ms epoch when capture started
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const peaksRef = useRef<Float32Array | null>(null)
  const playheadRef = useRef<number>(0)
  const waveformRafRef = useRef<number | null>(null)
  const isDraggingRef = useRef<boolean>(false)
  const hasDraggedRef = useRef<boolean>(false)

  // Match the canvas backing store to its CSS size (and DPR) so it stays crisp.
  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = graphRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = container.clientWidth * dpr
    canvas.height = container.clientHeight * dpr
    // Setting width/height resets the transform, so re-apply DPR scaling here.
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [])

  // Draw the piano-roll grid and the buffered pitch history scrolling across
  // time (now at the right edge, older readings trailing left). Imperative +
  // called every frame, so it never triggers a React re-render.
  const renderGraph = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    const laneH = height / LANES
    // Center of the lane for a (possibly fractional) MIDI value.
    const midiToY = (midi: number) => (MAX_MIDI - midi + 0.5) * laneH
    // Map a timestamp to X: now -> center, now - WINDOW_MS -> left edge.
    // The right half is "future" (empty) so the contour reads like a playhead.
    const now = performance.now()
    const timeToX = (t: number) => (width / 2) * (1 - (now - t) / WINDOW_MS)

    // Opaque white background so saved PNGs aren't transparent.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)

    // --- Piano-roll grid ---
    ctx.textBaseline = 'middle'
    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
      const top = (MAX_MIDI - midi) * laneH
      const mid = top + laneH / 2

      if (isBlackKey(midi)) {
        ctx.fillStyle = '#f2f2f2'
        ctx.fillRect(0, top, width, laneH)
      }
      ctx.strokeStyle = '#ececec'
      ctx.beginPath()
      ctx.moveTo(0, top)
      ctx.lineTo(width, top)
      ctx.stroke()

      // Label natural notes only; make each C bolder for octave orientation.
      if (!isBlackKey(midi)) {
        const name = NOTE_NAMES[((midi % 12) + 12) % 12]
        const isC = midi % 12 === 0
        ctx.fillStyle = isC ? '#555' : '#aaa'
        ctx.font = `${isC ? 600 : 400} 11px system-ui, sans-serif`
        ctx.fillText(`${name}${Math.floor(midi / 12) - 1}`, 6, mid)
      }
    }

    // Faint "now" playhead down the center.
    ctx.strokeStyle = '#ddd'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(width / 2, 0)
    ctx.lineTo(width / 2, height)
    ctx.stroke()

    // --- Pitch contour: connect samples, breaking the line on NaN (silence) ---
    const history = historyRef.current
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let penDown = false
    for (const s of history) {
      if (Number.isNaN(s.midi)) {
        penDown = false
        continue
      }
      const x = timeToX(s.t)
      const y = midiToY(Math.min(MAX_MIDI, Math.max(MIN_MIDI, s.midi)))
      if (penDown) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      penDown = true
    }
    ctx.stroke()

    // --- Head dot: the most recent reading, colored by how in-tune it is ---
    const last = history[history.length - 1]
    if (last && !Number.isNaN(last.midi)) {
      const freq = 440 * Math.pow(2, (last.midi - 69) / 12)
      const inTune = Math.abs(noteFromPitch(freq).cents) <= 5
      const midi = Math.min(MAX_MIDI, Math.max(MIN_MIDI, last.midi))
      ctx.fillStyle = inTune ? '#2e9e4f' : '#111'
      ctx.beginPath()
      ctx.arc(timeToX(last.t), midiToY(midi), 6, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [])

  // Size + draw the grid on mount, and re-fit on resize / orientation change.
  useEffect(() => {
    sizeCanvas()
    renderGraph()
    const container = graphRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      sizeCanvas()
      renderGraph()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [sizeCanvas, renderGraph])

  const renderWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    ctx.clearRect(0, 0, width, height)
    const peaks = peaksRef.current
    if (!peaks || peaks.length === 0) return
    const barWidth = width / peaks.length
    const midY = height / 2
    const progress = playheadRef.current
    for (let i = 0; i < peaks.length; i++) {
      const barHeight = peaks[i] * height
      const x = i * barWidth
      ctx.fillStyle = i / peaks.length <= progress ? '#333' : '#ccc'
      ctx.fillRect(x, midY - barHeight / 2, barWidth - 1, barHeight)
    }
  }, [])

  useEffect(() => {
    const canvas = waveformCanvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvas.clientWidth * dpr
    canvas.height = canvas.clientHeight * dpr
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    renderWaveform()
  }, [renderWaveform, waveformPeaks])

  async function selectRecording(rec: Recording) {
    setSelectedRecording(rec)
    const peaks = await computeWaveformPeaks(rec.url)
    peaksRef.current = peaks
    setWaveformPeaks(peaks)
    playheadRef.current = 0
  }

  function seekToPosition(clientX: number) {
    const canvas = waveformCanvasRef.current
    if (!canvas || !audioElRef.current || !selectedRecording) return
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const progress = Math.max(0, Math.min(1, x / rect.width))
    audioElRef.current.currentTime = progress * audioElRef.current.duration
    playheadRef.current = progress
    renderWaveform()
  }

  function handleWaveformPointerDown(e: React.MouseEvent | React.TouchEvent) {
    isDraggingRef.current = true
    hasDraggedRef.current = false
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    seekToPosition(clientX)
  }

  function handleWaveformPointerMove(e: React.MouseEvent | React.TouchEvent) {
    if (!isDraggingRef.current) return
    hasDraggedRef.current = true
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    seekToPosition(clientX)
  }

  function handleWaveformPointerUp() {
    isDraggingRef.current = false
  }

  function handleWaveformClick(e: React.MouseEvent) {
    if (hasDraggedRef.current) {
      e.preventDefault()
      hasDraggedRef.current = false
      return
    }
    seekToPosition(e.clientX)
  }

  // Populate the device list. Labels only appear once we have mic permission,
  // so refresh again after the stream starts.
  async function refreshDevices() {
    const all = await navigator.mediaDevices.enumerateDevices()
    setDevices(all.filter((d) => d.kind === 'audioinput'))
  }

  useEffect(() => {
    refreshDevices()
  }, [])

  // The detect-smooth-graph loop, run against any analyser node -- the live mic
  // while recording, or the recorded clip on playback. Identical pitch handling
  // either way, so playback is graphed exactly as if the mic were live.
  const runAnalysis = useCallback(
    (analyser: AnalyserNode, sampleRate: number) => {
      const timeData = new Float32Array(analyser.fftSize)

      // Stabilize the reading: gate quiet noise, median-filter jitter, require
      // big jumps to persist before committing (octave-distance jumps -- the
      // most likely detection error -- need much longer), then ease the
      // displayed pitch toward the committed note so transitions ramp instead
      // of jumping squarely.
      const NOISE_GATE = 0.015 // RMS below this counts as silence
      const MEDIAN_WINDOW = 3 // median of recent raw readings smooths jitter
      const SNAP_CENTS = 60 // within this, readings are treated as the same note
      const CONFIRM_FRAMES = 3 // a normal jump must persist this long to commit
      const OCTAVE_CONFIRM_FRAMES = 9 // octave jumps must persist much longer
      const DISPLAY_EASE = 0.25 // how fast the displayed pitch eases to target
      const HOLD_MS = 750 // keep showing the last note this long after silence

      // True when `a` is within ~1 semitone of an octave (or two) away from `b`
      // -- i.e. the gap looks like an octave-doubling/halving error, not a leap.
      const nearOctave = (a: number, b: number) => {
        const c = Math.abs(1200 * Math.log2(a / b))
        return Math.abs(c - 1200) < 100 || Math.abs(c - 2400) < 100
      }

      let smoothed = -1 // displayed pitch (eases toward target)
      let target = -1 // the note we currently believe is being sung
      let lastGoodTime = 0
      let recentRaw: number[] = []
      let candidate = -1 // a pending note-change waiting to be confirmed
      let candidateFrames = 0
      historyRef.current = []

      const tick = () => {
        analyser.getFloatTimeDomainData(timeData)
        // RMS of the waveform -> perceived loudness, roughly 0..1
        let sum = 0
        for (let i = 0; i < timeData.length; i++) {
          sum += timeData[i] * timeData[i]
        }
        const volume = Math.sqrt(sum / timeData.length)
        setVolume(volume)

        // Noise gate: ignore detections when the signal is too quiet to be a note.
        const raw = volume >= NOISE_GATE ? detectPitch(timeData, sampleRate) : -1
        const now = performance.now()

        if (raw > 0) {
          // Median-filter the raw readings to smooth frame-to-frame jitter.
          recentRaw.push(raw)
          if (recentRaw.length > MEDIAN_WINDOW) recentRaw.shift()
          const sorted = [...recentRaw].sort((a, b) => a - b)
          const value = sorted[Math.floor(sorted.length / 2)]

          const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b))

          if (target < 0) {
            target = value // first note after silence: lock on immediately
            smoothed = value
            candidate = -1
            candidateFrames = 0
          } else if (cents(value, target) <= SNAP_CENTS) {
            target = value // same note: follow the voice (drift, vibrato)
            candidate = -1
            candidateFrames = 0
          } else {
            // Big jump: a real note change or (more often) an octave error. Only
            // commit once it persists; octave-distance jumps must persist longer.
            const need = nearOctave(value, target)
              ? OCTAVE_CONFIRM_FRAMES
              : CONFIRM_FRAMES
            if (candidate > 0 && cents(value, candidate) <= SNAP_CENTS) {
              candidateFrames++
            } else {
              candidate = value
              candidateFrames = 1
            }
            if (candidateFrames >= need) {
              target = candidate
              candidate = -1
              candidateFrames = 0
            }
          }

          // Ease the displayed pitch toward the target in log space, so any
          // transition ramps smoothly (like a voice) instead of a square jump.
          smoothed *= Math.pow(target / smoothed, DISPLAY_EASE)
          lastGoodTime = now
          setPitch(smoothed)
        } else {
          // Gap: reset filters so the next phrase starts clean.
          recentRaw = []
          candidate = -1
          candidateFrames = 0
          if (now - lastGoodTime > HOLD_MS) {
            smoothed = -1
            target = -1
            setPitch(-1)
          }
        }

        // Append this frame to the history. Plot only frames that actually had a
        // detection (raw > 0); silence pushes NaN so the contour ends immediately
        // instead of trailing the held note across the hold window.
        const history = historyRef.current
        history.push({ t: now, midi: raw > 0 ? freqToMidi(smoothed) : NaN })
        const cutoff = now - WINDOW_MS
        while (history.length && history[0].t < cutoff) history.shift()

        renderGraph()
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    },
    [renderGraph],
  )

  // Tear down the audio graph + RAF loop, shared by both record and playback.
  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.onended = null
      audioElRef.current = null
    }
    audioContextRef.current?.close()
    audioContextRef.current = null
    setVolume(0)
    setPitch(-1)
  }, [])

  // Open the mic and start the live pitch graph. Shared by Start and Record so
  // recording can layer onto an already-running monitor (or open the mic itself).
  async function openMic() {
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

    runAnalysis(analyser, audioContext.sampleRate)
    refreshDevices()
  }

  async function startMonitor() {
    setHasInteracted(true)
    await openMic()
    setStatus('monitoring')
  }

  async function startRecording() {
    setHasInteracted(true)
    // Record straight from idle by opening the mic first; if we're already
    // monitoring, just attach the recorder to the live stream.
    if (!streamRef.current) await openMic()

    const recorder = new MediaRecorder(streamRef.current!)
    mediaRecorderRef.current = recorder
    const startedAt = Date.now()
    recordStartRef.current = startedAt
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      const recording: Recording = {
        id: crypto.randomUUID(),
        createdAt: startedAt,
        durationMs: Date.now() - startedAt,
        url: URL.createObjectURL(blob),
      }
      // Newest first.
      setRecordings((prev) => [recording, ...prev])
      selectRecording(recording)
    }
    recorder.start()
    setStatus('recording')
  }

  // Stop capturing but leave the mic + graph running, so you can keep going.
  function stopRecording() {
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    setStatus('monitoring')
  }

  async function startPlayback(url: string) {
    // Playback drives its own audio graph, so release the mic first.
    teardown()

    const audio = new Audio(url)
    audioElRef.current = audio

    const audioContext = new AudioContext()
    audioContextRef.current = audioContext
    await audioContext.resume()

    // Route the clip through an analyser (for the graph) and on to the speakers.
    const source = audioContext.createMediaElementSource(audio)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    analyser.connect(audioContext.destination)

    audio.onended = () => stopPlayback()

    const updatePlayhead = () => {
      if (audio.duration && selectedRecording) {
        playheadRef.current = audio.currentTime / audio.duration
        renderWaveform()
      }
      if (!isPaused) {
        waveformRafRef.current = requestAnimationFrame(updatePlayhead)
      }
    }

    runAnalysis(analyser, audioContext.sampleRate)
    await audio.play()
    setStatus('playing')
    setIsPaused(false)
    updatePlayhead()
  }

  function pausePlayback() {
    audioElRef.current?.pause()
    setIsPaused(true)
    if (waveformRafRef.current !== null) {
      cancelAnimationFrame(waveformRafRef.current)
      waveformRafRef.current = null
    }
  }

  async function resumePlayback() {
    if (audioElRef.current) {
      await audioElRef.current.play()
      setIsPaused(false)
      const audio = audioElRef.current
      const updatePlayhead = () => {
        if (audio.duration && selectedRecording) {
          playheadRef.current = audio.currentTime / audio.duration
          renderWaveform()
        }
        if (!isPaused) {
          waveformRafRef.current = requestAnimationFrame(updatePlayhead)
        }
      }
      updatePlayhead()
    }
  }

  function stopPlayback() {
    teardown()
    if (waveformRafRef.current !== null) {
      cancelAnimationFrame(waveformRafRef.current)
      waveformRafRef.current = null
    }
    setStatus('idle')
    setIsPaused(false)
    playheadRef.current = 0
    renderWaveform()
  }

  // Clean up the audio graph on unmount. (Recording object URLs live for the
  // session; the browser frees them when the page closes.)
  useEffect(() => teardown, [teardown])

  // Play a take and switch to the graph so its pitch contour is visible.
  function playRecording(rec: Recording) {
    setView('graph')
    selectRecording(rec)
    startPlayback(rec.url)
  }

  return (
    <div className="app">
    <nav className="nav">
      <div className="nav-controls">
        <button onClick={() => setView(view === 'graph' ? 'list' : 'graph')}>
          {view === 'graph' ? `Takes (${recordings.length})` : 'Graph'}
        </button>

        <select
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          disabled={status !== 'idle'}
        >
          <option value="">Default input</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </div>

      <div className="nav-readouts">
        {(() => {
          const note = pitch > 0 ? noteFromPitch(pitch) : null
          const inTune = note ? Math.abs(note.cents) <= 5 : false
          return (
            <div className="nav-pitch">
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  color: note ? (inTune ? '#2e9e4f' : '#111') : '#ccc',
                }}
              >
                {note ? note.name : '—'}
              </span>
            </div>
          )
        })()}

        <div style={{ fontSize: 28, fontWeight: 700 }}>{volume.toFixed(3)}</div>
      </div>
    </nav>

      {/* Graph stays mounted (display toggle) so the canvas keeps its size and
          the live loop never draws to a torn-down canvas. */}
      <div
        className="graph"
        ref={graphRef}
        style={{ display: view === 'graph' ? undefined : 'none' }}
      >
        <canvas ref={canvasRef} />
        {!hasInteracted && status === 'idle' && (
          <button className="graph-overlay" onClick={startMonitor}>
            <svg viewBox="0 0 100 100" className="graph-overlay-icon">
              <polygon points="30,20 30,80 80,50" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>

      {view === 'list' && (
        <div className="list">
          {recordings.length === 0 ? (
            <div className="list-empty">No takes yet. Hit Record to capture one.</div>
          ) : (
            recordings.map((rec) => (
              <button
                key={rec.id}
                className="list-row"
                onClick={() => playRecording(rec)}
              >
                <span className="list-time">{formatTimestamp(rec.createdAt)}</span>
                <span className="list-dur">{formatDuration(rec.durationMs)}</span>
              </button>
            ))
          )}
        </div>
      )}

      <div className="transport">
        <button
          className="transport-waveform-btn"
          onClick={handleWaveformClick}
          onMouseDown={handleWaveformPointerDown}
          onMouseMove={handleWaveformPointerMove}
          onMouseUp={handleWaveformPointerUp}
          onMouseLeave={handleWaveformPointerUp}
          onTouchStart={handleWaveformPointerDown}
          onTouchMove={handleWaveformPointerMove}
          onTouchEnd={handleWaveformPointerUp}
        >
          <canvas ref={waveformCanvasRef} />
        </button>
        <div className="transport-controls">
          {status === 'recording' ? (
            <button onClick={stopRecording}>Stop rec</button>
          ) : (
            <button onClick={startRecording} disabled={status === 'playing'}>
              Record
            </button>
          )}

          {status === 'playing' && !isPaused ? (
            <button onClick={pausePlayback}>Pause</button>
          ) : status === 'playing' && isPaused ? (
            <button onClick={resumePlayback}>Resume</button>
          ) : (
            <button
              onClick={() => selectedRecording && playRecording(selectedRecording)}
              disabled={status === 'recording' || !selectedRecording}
            >
              Play
            </button>
          )}

          {status === 'playing' && (
            <button onClick={stopPlayback}>Stop</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
