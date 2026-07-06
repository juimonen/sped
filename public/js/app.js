'use strict'

const player = new SPEDPlayer()
let currentPayload = null  // { tracks: [...] }

// ── WebSocket ──────────────────────────────────────────────
const ws = new WebSocket('ws://' + location.host)
const statusEl = document.getElementById('status')

ws.onopen = () => {
  statusEl.textContent = 'connected'
  statusEl.className = 'connected'
  ws.send(JSON.stringify({ type: 'ready' }))
}

ws.onclose = () => {
  statusEl.textContent = 'disconnected'
  statusEl.className = ''
}

ws.onmessage = e => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'edl') {
    // Normalize: old single-track format or new multitrack
    const payload = msg.edl.tracks
      ? msg.edl
      : { tracks: [{ id: '1', regions: msg.edl.regions, muted: false, gain: 1.0 }] }
    currentPayload = payload
    renderTracks(payload)
    startPlayback()
  }
  if (msg.type === 'project') {
    const name = msg.path ? msg.path.split('/').pop() : '—'
    document.title = 'sped-e — ' + name
    statusEl.textContent = 'connected · ' + name
  }
  if (msg.type === 'update') {
    // Re-render timeline without auto-playing
    const payload = msg.payload.tracks
      ? msg.payload
      : { tracks: [{ id: '1', regions: msg.payload.regions, muted: false, gain: 1.0 }] }
    currentPayload = payload
    renderTracks(payload)
  }
  if (msg.type === 'stop') player.stop()
  if (msg.type === 'terminal') term.write(msg.data)
}

// ── xterm.js terminal ──────────────────────────────────────
const term = new Terminal({
  theme: {
    background: '#1a1a1a',
    foreground: '#e0e0e0',
    cursor: '#4ec9b0',
    selection: '#2a4a5a'
  },
  fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontSize: 13,
  cursorBlink: true
})

const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)
term.open(document.getElementById('terminal'))
fitAddon.fit()

term.writeln('\x1b[32msped-e\x1b[0m — audio editor')
term.writeln('\x1b[90mQuick start:\x1b[0m')
term.writeln('  sped open ~/projects/myproject')
term.writeln('  sped import audio.wav')
term.writeln('  sped import other.wav 2')
term.writeln('  sped play')
term.writeln('')

term.onData(data => ws.send(JSON.stringify({ type: 'terminal', data })))
term.onResize(({ cols, rows }) => ws.send(JSON.stringify({ type: 'resize', cols, rows })))
window.addEventListener('resize', () => fitAddon.fit())

// ── Playback UI ────────────────────────────────────────────
const canvas = document.getElementById('timeline-canvas')
const regionsEl = document.getElementById('regions')
const noEdlEl = document.getElementById('no-edl')
const timeDisplay = document.getElementById('time-display')
const playBtn = document.getElementById('play-btn')
const stopBtn = document.getElementById('stop-btn')

function formatTime(t) {
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(3).padStart(6, '0')
  return m + ':' + s
}

// Status reporting to server ~4x/sec
let lastStatusSend = 0
player.onStatusUpdate = (t, duration, playing) => {
  const now = Date.now()
  if (now - lastStatusSend < 250) return
  lastStatusSend = now
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'playback_status', currentTime: t, duration, playing }))
  }
}

player.onTimeUpdate = (t, total) => {
  timeDisplay.textContent = formatTime(t) + ' / ' + formatTime(total)
  player.drawTimeline(canvas, currentPayload)
}

player.onStop = () => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'playback_status', currentTime: 0, duration: 0, playing: false }))
  }
  statusEl.textContent = statusEl.textContent.replace('▶ playing', 'connected')
  statusEl.className = 'connected'
  player.drawTimeline(canvas, currentPayload)
}

playBtn.onclick = () => startPlayback()
stopBtn.onclick = () => player.stop()

async function startPlayback() {
  if (!currentPayload) return
  statusEl.textContent = '▶ playing'
  statusEl.className = 'playing'
  try {
    await player.play(currentPayload)
  } catch (err) {
    console.error('Playback error:', err)
    statusEl.textContent = 'error: ' + err.message
    statusEl.className = ''
  }
}

function renderTracks(payload) {
  if (!payload || !payload.tracks || !payload.tracks.length) return
  noEdlEl.style.display = 'none'
  regionsEl.innerHTML = ''

  payload.tracks.forEach(track => {
    // Track header
    const header = document.createElement('div')
    header.className = 'track-header'
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 8px;background:#161616;font-size:11px;color:#666;border-bottom:1px solid #222'
    const total = track.regions.reduce((s, r) => s + (r.duration || 0), 0)
    header.innerHTML = '<span style="color:#4ec9b0">track ' + track.id + '</span>' +
      '<span>' + track.regions.length + ' region(s)</span>' +
      '<span>' + total.toFixed(3) + 's</span>' +
      (track.muted ? '<span style="color:#f55">MUTED</span>' : '')
    regionsEl.appendChild(header)

    // Regions
    let cursor = 0
    track.regions.forEach((r, i) => {
      const div = document.createElement('div')
      div.className = 'region'
      div.style.opacity = track.muted ? '0.4' : '1'
      const fname = r.file.split('/').pop()
      const dur = r.duration != null ? r.duration.toFixed(3) : '?'
      div.innerHTML =
        '<span class="file">' + fname + '</span>' +
        '<span class="time">off: ' + r.offset.toFixed(3) + 's</span>' +
        '<span class="time">dur: ' + dur + 's</span>' +
        '<span class="time">@ ' + cursor.toFixed(3) + 's</span>' +
        (r.fadeIn ? '<span class="time">↑' + r.fadeIn + 's</span>' : '') +
        (r.fadeOut ? '<span class="time">↓' + r.fadeOut + 's</span>' : '')
      regionsEl.appendChild(div)
      cursor += r.duration || 0
    })
  })

  requestAnimationFrame(() => player.drawTimeline(canvas, payload))
}
