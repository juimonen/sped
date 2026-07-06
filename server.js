'use strict'

const express = require('express')
const http = require('http')
const { WebSocketServer } = require('ws')
const fs = require('fs')
const path = require('path')
const os = require('os')

let pty
try {
  pty = require('node-pty')
} catch {
  console.warn('node-pty not available — shell panel disabled')
}

const PORT = process.env.PORT || 3000
const GLOBAL_DIR = path.join(os.homedir(), '.sped')
const ACTIVE_FILE = path.join(GLOBAL_DIR, 'active')

fs.mkdirSync(GLOBAL_DIR, { recursive: true })

function getActiveProject() {
  if (!fs.existsSync(ACTIVE_FILE)) return null
  return fs.readFileSync(ACTIVE_FILE, 'utf8').trim()
}

function getPlaySignal() {
  const p = getActiveProject()
  return p ? path.join(p, 'play.json') : null
}

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

app.use(express.static(path.join(__dirname, 'public')))

// Stop endpoint — CLI calls this on Ctrl+C
app.get('/stop', (req, res) => {
  broadcast({ type: 'stop' })
  res.send('ok')
})

// Serve audio files — only from paths that exist on disk
app.get('/audio', (req, res) => {
  const file = req.query.file
  if (!file) return res.status(400).send('no file')
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) return res.status(404).send('not found')
  res.sendFile(abs)
})

const clients = new Set()

wss.on('connection', ws => {
  clients.add(ws)
  console.log('Browser connected')

  // Spawn a real shell
  let shell = null
  if (pty) {
    shell = pty.spawn(process.env.SHELL || 'bash', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env: {
        ...process.env,
        PATH: `${path.join(__dirname, 'bin')}:${process.env.PATH}`
      }
    })

    shell.onData(data => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal', data }))
    })

    shell.onExit(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal', data: '\r\n[shell exited]\r\n' }))
    })

    console.log(`Shell spawned (pid ${shell.pid})`)
  } else {
    ws.send(JSON.stringify({ type: 'terminal', data: '\r\nnode-pty not available. Use your system terminal.\r\n' }))
  }

  // Send current EDL if a project is active
  const signal = getPlaySignal()
  if (signal && fs.existsSync(signal)) {
    try {
      const edl = JSON.parse(fs.readFileSync(signal, 'utf8'))
      ws.send(JSON.stringify({ type: 'edl', edl }))
    } catch {}
  }

  ws.on('close', () => {
    clients.delete(ws)
    if (shell) try { shell.kill() } catch {}
  })

  ws.on('message', msg => {
    try {
      const { type, data, cols, rows, currentTime, duration, playing } = JSON.parse(msg)
      if (type === 'terminal' && shell) shell.write(data)
      if (type === 'resize' && shell) shell.resize(cols, rows)
      if (type === 'playback_status') {
        // Browser reports playback position — write to status file for CLI to read
        const projectPath = getActiveProject()
        if (projectPath) {
          const statusPath = path.join(projectPath, 'playback_status.json')
          fs.writeFileSync(statusPath, JSON.stringify({ currentTime, duration, playing, ts: Date.now() }))
        }
      }
    } catch {}
  })
})

function broadcast(msg) {
  const str = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(str)
  }
}

// Watch ~/.sped/active for project switches
// and the active project's play.json for play commands
let currentWatcher = null
let currentWatchDir = null

function watchActiveProject() {
  const projectPath = getActiveProject()
  if (!projectPath || projectPath === currentWatchDir) return

  // Stop watching previous project
  if (currentWatcher) { currentWatcher.close(); currentWatcher = null }

  if (!fs.existsSync(projectPath)) return

  currentWatchDir = projectPath
  let debounce = null

  currentWatcher = fs.watch(projectPath, (event, filename) => {
    if (filename === 'stop.json') {
      broadcast({ type: 'stop' })
      return
    }
    // update.json: re-render without auto-play
    if (filename === 'update.json') {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(projectPath, 'update.json'), 'utf8'))
          broadcast({ type: 'update', payload })
        } catch {}
      }, 50)
      return
    }
    // play.json: render and auto-play
    if (filename !== 'play.json') return
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        const payload = JSON.parse(fs.readFileSync(path.join(projectPath, 'play.json'), 'utf8'))
        broadcast({ type: 'edl', edl: payload })
      } catch {}
    }, 50)
  })

  console.log(`Watching project: ${projectPath}`)
}

// Watch for active project changes
fs.watch(GLOBAL_DIR, (event, filename) => {
  if (filename === 'active') {
    const p = getActiveProject()
    console.log(`Active project → ${p}`)
    // Tell browser which project is active
    broadcast({ type: 'project', path: p })
    watchActiveProject()
  }
})

// Start watching whatever project is currently active
watchActiveProject()

server.listen(PORT, () => {
  console.log(`sped server at http://localhost:${PORT}`)
  const open = process.platform === 'darwin' ? 'open' :
               process.platform === 'win32' ? 'start' : 'xdg-open'
  require('child_process').exec(`${open} http://localhost:${PORT}`)
})
