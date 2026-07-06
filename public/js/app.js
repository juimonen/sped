'use strict'

const player = new SPEDPlayer()
let currentEDL = null

// ── WebSocket ──────────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}`)
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
    currentEDL = msg.edl
    renderEDL(msg.edl)
    startPlayback()
  }
  if (msg.type === 'project') {
    const name = msg.path ? msg.path.split('/').pop() : '—'
    document.title = 'sped — ' + name
    statusEl.textContent = 'connected · ' + name
  }
  if (msg.type === 'stop') {
    player.stop()
  }
  if (msg.type === 'play_region') {
    // Play a sub-region of the EDL for monitoring
    currentEDL = msg.edl
    renderEDL(msg.edl)
    startPlayback()
  }
  if (msg.type === 'terminal') {
    term.write(msg.data)
  }
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

// When the server is running node-pty, terminal input goes to the shell.
// Without node-pty (dev mode), show a helpful message.
term.writeln('\x1b[32msped-e\x1b[0m — audio editor')
term.writeln('\x1b[90mType sped commands in your system terminal.\x1b[0m')
term.writeln('\x1b[90mThis panel will show shell output when node-pty is connected.\x1b[0m')
term.writeln('')
term.writeln('\x1b[90mQuick start:\x1b[0m')
term.writeln('  sped init <file.wav>')
term.writeln('  sped copy 2.0 5.0')
term.writeln('  sped paste 10.0')
term.writeln('  sped play')
term.writeln('')

term.onData(data => {
  ws.send(JSON.stringify({ type: 'terminal', data }))
})

term.onResize(({ cols, rows }) => {
  ws.send(JSON.stringify({ type: 'resize', cols, rows }))
})

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
  return `${m}:${s}`
}

player.onTimeUpdate = (t, total) => {
  timeDisplay.textContent = `${formatTime(t)} / ${formatTime(total)}`
  player.drawTimeline(canvas, currentEDL)
}

// Report playback position to server ~4x per second
let lastStatusSend = 0
player.onStatusUpdate = (t, duration, playing) => {
  const now = Date.now()
  if (now - lastStatusSend < 250) return
  lastStatusSend = now
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'playback_status', currentTime: t, duration, playing }))
  }
}

player.onStop = () => {
  // Tell server playback stopped
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'playback_status', currentTime: 0, duration: 0, playing: false }))
  }
  statusEl.textContent = 'connected'
  statusEl.className = 'connected'
  timeDisplay.textContent = currentEDL
    ? `0:00.000 / ${formatTime(currentEDL.regions.reduce((s, r) => s + r.duration, 0))}`
    : '0:00.000'
  player.drawTimeline(canvas, currentEDL)
}

playBtn.onclick = () => startPlayback()
stopBtn.onclick = () => player.stop()

async function startPlayback() {
  if (!currentEDL) return
  statusEl.textContent = '▶ playing'
  statusEl.className = 'playing'
  try {
    await player.play(currentEDL)
  } catch (err) {
    console.error('Playback error:', err)
    statusEl.textContent = `error: ${err.message}`
    statusEl.className = ''
  }
}

function renderEDL(edl) {
  noEdlEl.style.display = 'none'
  regionsEl.innerHTML = ''

  let cursor = 0
  edl.regions.forEach((r, i) => {
    const div = document.createElement('div')
    div.className = 'region'
    const fname = r.file.split('/').pop()
    div.innerHTML = `
      <span class="file">${fname}</span>
      <span class="time">offset: ${r.offset.toFixed(3)}s</span>
      <span class="time">dur: ${r.duration?.toFixed(3) ?? '?'}s</span>
      <span class="time">@ ${cursor.toFixed(3)}s</span>
      ${r.fadeIn ? `<span class="time">↑${r.fadeIn}s</span>` : ''}
      ${r.fadeOut ? `<span class="time">↓${r.fadeOut}s</span>` : ''}
    `
    regionsEl.appendChild(div)
    cursor += r.duration ?? 0
  })

  // Draw initial timeline
  requestAnimationFrame(() => player.drawTimeline(canvas, edl))
}
