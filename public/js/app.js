'use strict'

const player = new SPEDPlayer()
let currentPayload = null  // { tracks: [...] }

// ── WebSocket ──────────────────────────────────────────────
const ws = new WebSocket('ws://' + location.host + '/ws')
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
    // edl message = play command, just update payload and play, don't re-render
    const payload = msg.edl.tracks
      ? msg.edl
      : { tracks: [{ id: '1', regions: msg.edl.regions, muted: false, gain: 1.0 }] }
    currentPayload = payload
    // Only render if tracks changed structure, otherwise just play
    const existingTracks = tracksEl.querySelectorAll('.track-unit').length
    if (existingTracks !== payload.tracks.length) {
      renderTracks(payload)
    }
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
term.writeln('')
term.writeln('\x1b[90mQuick start:\x1b[0m')
term.writeln('  sped open myproject          \x1b[90m# creates ~/sped/projects/myproject/\x1b[0m')
term.writeln('  sped status                  \x1b[90m# shows audio folder path to copy files to\x1b[0m')
term.writeln('  \x1b[90m# (copy WAV files from outside sped into the audio folder shown)\x1b[0m')
term.writeln('  sped import violin.wav       \x1b[90m# import from project audio folder\x1b[0m')
term.writeln('  sped import cello.wav 2      \x1b[90m# import to track 2\x1b[0m')
term.writeln('  sped play                    \x1b[90m# play all tracks\x1b[0m')
term.writeln('  sped help                    \x1b[90m# all commands\x1b[0m')
term.writeln('')

term.onData(data => ws.send(JSON.stringify({ type: 'terminal', data })))
term.onResize(({ cols, rows }) => ws.send(JSON.stringify({ type: 'resize', cols, rows })))
window.addEventListener('resize', () => fitAddon.fit())

// ── Playback UI ────────────────────────────────────────────
// canvas now per-track
const tracksEl = document.getElementById('tracks')
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

function drawAllTracks(t) {
  if (!currentPayload) return
  currentPayload.tracks.forEach(track => {
    const canvas = document.getElementById('canvas-' + track.id)
    if (canvas) player.drawTrack(canvas, track, t, currentPayload)
  })
}

player.onTimeUpdate = (t, total) => {
  timeDisplay.textContent = formatTime(t) + ' / ' + formatTime(total)
  // Draw each track's canvas
  if (currentPayload) {
    currentPayload.tracks.forEach(track => {
      const canvas = document.getElementById('canvas-' + track.id)
      if (canvas) player.drawTrack(canvas, track, t, currentPayload)
    })
  }
}

player.onStop = () => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'playback_status', currentTime: 0, duration: 0, playing: false }))
  }
  statusEl.textContent = statusEl.textContent.replace('▶ playing', 'connected')
  statusEl.className = 'connected'
  drawAllTracks(0)
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

  // Remember which panels are open before re-rendering
  const openPanels = {}
  tracksEl.querySelectorAll('.track-unit').forEach(unit => {
    const panel = unit.querySelector('.track-unit-panel')
    const activeBtn = unit.querySelector('.track-unit-btn.active')
    if (panel && activeBtn && panel.style.display !== 'none') {
      const trackId = unit.id.replace('track-unit-', '')
      openPanels[trackId] = activeBtn.dataset.panel
    }
  })

  tracksEl.innerHTML = ''

  payload.tracks.forEach(track => {
    const total = track.regions.reduce((s, r) => s + (r.duration || 0), 0)

    // Track unit container
    const unit = document.createElement('div')
    unit.className = 'track-unit'
    unit.id = 'track-unit-' + track.id

    // Header
    const header = document.createElement('div')
    header.className = 'track-unit-header'
    header.innerHTML =
      '<span style="color:#4ec9b0;font-weight:bold">track ' + track.id + '</span>' +
      '<span>' + track.regions.length + ' region(s)</span>' +
      '<span>' + total.toFixed(2) + 's</span>' +
      (track.muted ? '<span style="color:#f55">MUTED</span>' : '')
    unit.appendChild(header)

    // Canvas for this track
    const canvas = document.createElement('canvas')
    canvas.id = 'canvas-' + track.id
    canvas.className = 'track-unit-canvas'
    unit.appendChild(canvas)

    // Buttons row
    const buttons = document.createElement('div')
    buttons.className = 'track-unit-buttons'
    buttons.innerHTML =
      '<button class="track-unit-btn" data-panel="list">≡ list</button>' +
      '<button class="track-unit-btn" data-panel="edl">{ } edl</button>' +
      '<button class="track-unit-btn" data-panel="graph">◈ graph</button>'
    unit.appendChild(buttons)

    // Panel (shared, switches content)
    const panel = document.createElement('div')
    panel.className = 'track-unit-panel'
    unit.appendChild(panel)

    tracksEl.appendChild(unit)

    // Draw canvas
    requestAnimationFrame(() => player.drawTrack(canvas, track, 0, payload))

    // Restore open panel if it was open before re-render
    if (openPanels[track.id]) {
      const btn = buttons.querySelector('[data-panel="' + openPanels[track.id] + '"]')
      if (btn) btn.click()
    }

    // Button logic
    let activePanel = null
    buttons.querySelectorAll('.track-unit-btn').forEach(btn => {
      btn.onclick = () => {
        const type = btn.dataset.panel
        if (activePanel === type) {
          panel.style.display = 'none'
          btn.classList.remove('active')
          activePanel = null
          return
        }
        buttons.querySelectorAll('.track-unit-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        activePanel = type
        panel.style.display = 'block'

        if (type === 'list') {
          let cursor = 0
          panel.innerHTML = track.regions.map(r => {
            const fname = r.file.split('/').pop()
            const dur = r.duration != null ? r.duration.toFixed(3) : '?'
            const html = '<div class="region" style="border-radius:0;border-left:none;border-right:none">' +
              '<span class="file">' + fname + '</span>' +
              '<span class="time">off: ' + r.offset.toFixed(3) + 's</span>' +
              '<span class="time">dur: ' + dur + 's</span>' +
              '<span class="time">@ ' + cursor.toFixed(3) + 's</span>' +
              (r.fadeIn ? '<span class="time">↑' + r.fadeIn + 's</span>' : '') +
              (r.fadeOut ? '<span class="time">↓' + r.fadeOut + 's</span>' : '') +
              '</div>'
            cursor += r.duration || 0
            return html
          }).join('')
        } else if (type === 'edl') {
          panel.innerHTML = '<pre style="font-size:10px;color:#4a8a6a;margin:0;padding:8px">' +
            JSON.stringify({ regions: track.regions }, null, 2) + '</pre>'
        } else if (type === 'graph') {
          renderGraph(track, panel)
        }
      }
    })
  })
}

const btnStyle = 'background:#1a2a3a;border:1px solid #2a4a6a;color:#4ec9b0;padding:1px 6px;font-size:10px;cursor:pointer;border-radius:2px;font-family:monospace'
