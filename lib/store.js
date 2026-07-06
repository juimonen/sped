'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const GLOBAL_DIR = path.join(os.homedir(), '.sped')
const ACTIVE_FILE = path.join(GLOBAL_DIR, 'active')

function getActiveProject() {
  if (!fs.existsSync(ACTIVE_FILE)) return null
  return fs.readFileSync(ACTIVE_FILE, 'utf8').trim()
}

function setActiveProject(projectPath) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.writeFileSync(ACTIVE_FILE, projectPath)
}

// Per-track EDL store — each track lives in project/tracks/track_N/
class EDLStore {
  constructor(trackDir) {
    this.dir = trackDir
    this.indexFile = path.join(trackDir, 'current')
    fs.mkdirSync(trackDir, { recursive: true })
  }

  // Get store for a specific track in a project
  static forTrack(projectPath, trackId) {
    return new EDLStore(path.join(projectPath, 'tracks', 'track_' + trackId))
  }

  // Get store for active track in active project
  static fromActive() {
    const projectPath = getActiveProject()
    if (!projectPath) return null
    const trackId = getActiveTrack(projectPath)
    return EDLStore.forTrack(projectPath, trackId)
  }

  currentIndex() {
    if (!fs.existsSync(this.indexFile)) return null
    return parseInt(fs.readFileSync(this.indexFile, 'utf8').trim(), 10)
  }

  edlPath(index) {
    return path.join(this.dir, 'edl_' + String(index).padStart(4, '0') + '.json')
  }

  read() {
    const idx = this.currentIndex()
    if (idx === null) return null
    return JSON.parse(fs.readFileSync(this.edlPath(idx), 'utf8'))
  }

  write(edl) {
    const idx = (this.currentIndex() ?? -1) + 1
    fs.writeFileSync(this.edlPath(idx), JSON.stringify(edl, null, 2))
    fs.writeFileSync(this.indexFile, String(idx))
    return idx
  }

  undo() {
    const idx = this.currentIndex()
    if (idx === null || idx === 0) { console.error('Nothing to undo'); return false }
    fs.writeFileSync(this.indexFile, String(idx - 1))
    return true
  }

  clipboardPath() { return path.join(this.dir, 'clipboard.json') }

  readClipboard() {
    if (!fs.existsSync(this.clipboardPath())) return null
    return JSON.parse(fs.readFileSync(this.clipboardPath(), 'utf8'))
  }

  writeClipboard(regions) {
    fs.writeFileSync(this.clipboardPath(), JSON.stringify(regions, null, 2))
  }

  slotsDir() {
    const d = path.join(this.dir, 'slots')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  slotPath(slot) { return path.join(this.slotsDir(), 'slot_' + slot + '.json') }

  writeSlot(slot, edlIndex, start, end) {
    fs.writeFileSync(this.slotPath(slot), JSON.stringify({ edlIndex, start, end }, null, 2))
  }

  readSlot(slot) {
    const p = this.slotPath(slot)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }

  listSlots() {
    const dir = this.slotsDir()
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('slot_') && f.endsWith('.json'))
      .map(f => {
        const slot = f.replace('slot_', '').replace('.json', '')
        return { slot, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }
      })
      .sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }))
  }

  resolveSlot(slot) {
    const ref = this.readSlot(slot)
    if (!ref) return null
    const edlData = JSON.parse(fs.readFileSync(this.edlPath(ref.edlIndex), 'utf8'))
    const { extractRegions } = require('./edl')
    return extractRegions(edlData.regions, ref.start, ref.end)
  }

  // Signal browser to play — writes multitrack play.json at project level
  signalPlay(projectPath, allTracks) {
    const signalPath = path.join(projectPath, 'play.json')
    fs.writeFileSync(signalPath, JSON.stringify(allTracks, null, 2))
  }
}

// Track metadata (mute, gain) lives in project/tracks/meta.json
function getTracksMeta(projectPath) {
  const metaPath = path.join(projectPath, 'tracks', 'meta.json')
  if (!fs.existsSync(metaPath)) return {}
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
}

function setTrackMeta(projectPath, trackId, meta) {
  const metaPath = path.join(projectPath, 'tracks', 'meta.json')
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  const all = getTracksMeta(projectPath)
  all[trackId] = { ...(all[trackId] || {}), ...meta }
  fs.writeFileSync(metaPath, JSON.stringify(all, null, 2))
}

// Active track pointer lives in project/active_track
function getActiveTrack(projectPath) {
  const f = path.join(projectPath, 'active_track')
  if (!fs.existsSync(f)) return '1'
  return fs.readFileSync(f, 'utf8').trim()
}

function setActiveTrack(projectPath, trackId) {
  fs.writeFileSync(path.join(projectPath, 'active_track'), String(trackId))
}

// List all track IDs that exist in the project
function listTracks(projectPath) {
  const tracksDir = path.join(projectPath, 'tracks')
  if (!fs.existsSync(tracksDir)) return []
  return fs.readdirSync(tracksDir)
    .filter(f => f.startsWith('track_'))
    .map(f => f.replace('track_', ''))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// Build the full multitrack payload for browser playback
function buildPlayPayload(projectPath) {
  const meta = getTracksMeta(projectPath)
  const trackIds = listTracks(projectPath)
  const tracks = []
  for (const id of trackIds) {
    const store = EDLStore.forTrack(projectPath, id)
    const edl = store.read()
    if (!edl) continue
    const trackMeta = meta[id] || {}
    tracks.push({
      id,
      regions: edl.regions,
      muted: trackMeta.muted || false,
      gain: trackMeta.gain != null ? trackMeta.gain : 1.0
    })
  }
  return { tracks }
}

// Write update.json to trigger browser re-render without playback
function signalUpdate(projectPath, payload) {
  fs.writeFileSync(path.join(projectPath, 'update.json'), JSON.stringify(payload, null, 2))
}

module.exports = {
  EDLStore,
  signalUpdate,
  getActiveProject, setActiveProject,
  getActiveTrack, setActiveTrack,
  getTracksMeta, setTrackMeta,
  listTracks, buildPlayPayload
}
