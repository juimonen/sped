'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

// Global sped config dir — just stores the active project path
const GLOBAL_DIR = path.join(os.homedir(), '.sped')
const ACTIVE_FILE = path.join(GLOBAL_DIR, 'active')

// Get the currently active project path
function getActiveProject() {
  if (!fs.existsSync(ACTIVE_FILE)) return null
  return fs.readFileSync(ACTIVE_FILE, 'utf8').trim()
}

// Set the active project path
function setActiveProject(projectPath) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.writeFileSync(ACTIVE_FILE, projectPath)
}

// EDLStore manages versioned EDL files inside a project folder
class EDLStore {
  constructor(projectDir) {
    this.dir = projectDir
    this.indexFile = path.join(projectDir, 'current')
    fs.mkdirSync(projectDir, { recursive: true })
  }

  // Factory: load from active project, or null if none set
  static fromActive() {
    const projectPath = getActiveProject()
    if (!projectPath) return null
    return new EDLStore(projectPath)
  }

  currentIndex() {
    if (!fs.existsSync(this.indexFile)) return null
    return parseInt(fs.readFileSync(this.indexFile, 'utf8').trim(), 10)
  }

  edlPath(index) {
    return path.join(this.dir, `edl_${String(index).padStart(4, '0')}.json`)
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
    if (idx === null || idx === 0) {
      console.error('Nothing to undo')
      return false
    }
    fs.writeFileSync(this.indexFile, String(idx - 1))
    return true
  }

  clipboardPath() {
    return path.join(this.dir, 'clipboard.json')
  }

  readClipboard() {
    if (!fs.existsSync(this.clipboardPath())) return null
    return JSON.parse(fs.readFileSync(this.clipboardPath(), 'utf8'))
  }

  writeClipboard(regions) {
    fs.writeFileSync(this.clipboardPath(), JSON.stringify(regions, null, 2))
  }

  // play.json is watched by the server to trigger browser playback
  signalPlay(edl) {
    const signalPath = path.join(this.dir, 'play.json')
    fs.writeFileSync(signalPath, JSON.stringify(edl, null, 2))
  }
  writeClipboard(regions) {
    fs.writeFileSync(this.clipboardPath(), JSON.stringify(regions, null, 2))
  }

  // Copy slots — lightweight references into an EDL, extracted lazily at join time
  slotsDir() {
    const d = path.join(this.dir, 'slots')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  slotPath(slot) {
    return path.join(this.slotsDir(), 'slot_' + slot + '.json')
  }

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

  // Resolve a slot to actual regions by reading the referenced EDL
  resolveSlot(slot) {
    const ref = this.readSlot(slot)
    if (!ref) return null
    const edlData = JSON.parse(fs.readFileSync(this.edlPath(ref.edlIndex), 'utf8'))
    const { extractRegions } = require('./edl')
    return extractRegions(edlData.regions, ref.start, ref.end)
  }
}

module.exports = { EDLStore, getActiveProject, setActiveProject }