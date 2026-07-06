'use strict'

// Web Audio playback engine for sped2 EDL
// Reads EDL regions and schedules AudioBufferSourceNodes
// with precise timing — this is the "render" step SPED did at play time.

class SPEDPlayer {
  constructor() {
    this.ctx = null
    this.sources = []       // active AudioBufferSourceNodes
    this.bufferCache = {}   // file path → AudioBuffer
    this.startedAt = null   // ctx.currentTime when playback started
    this.totalDuration = 0
    this.playing = false
    this.animFrame = null
    this.onTimeUpdate = null // callback(currentTime, totalDuration)
    this.onStop = null
  }

  _ensureContext() {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  async _loadBuffer(file) {
    if (this.bufferCache[file]) return this.bufferCache[file]

    const url = `/audio?file=${encodeURIComponent(file)}`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Failed to load ${file}: ${resp.status}`)
    const arrayBuf = await resp.arrayBuffer()
    const audioBuf = await this.ctx.decodeAudioData(arrayBuf)
    this.bufferCache[file] = audioBuf
    return audioBuf
  }

  // Fill in missing durations from actual audio file lengths
  async resolveEDL(edl) {
    this._ensureContext()
    const resolved = { ...edl, regions: [] }

    for (const region of edl.regions) {
      const buf = await this._loadBuffer(region.file)
      const duration = region.duration ?? (buf.duration - region.offset)
      resolved.regions.push({ ...region, duration })
    }

    return resolved
  }

  async play(edl) {
    this.stop()
    this._ensureContext()

    const resolved = await this.resolveEDL(edl)
    this.totalDuration = resolved.regions.reduce((s, r) => s + r.duration, 0)

    // Schedule all regions sequentially
    // This is the SPKitList equivalent — fire and forget, sample accurate
    let cursor = 0
    const scheduleAhead = this.ctx.currentTime + 0.1 // small buffer

    for (const region of resolved.regions) {
      const buf = await this._loadBuffer(region.file)
      const src = this.ctx.createBufferSource()
      src.buffer = buf

      // Fade in/out via GainNode (SPKitLinearFader equivalent)
      const gain = this.ctx.createGain()
      src.connect(gain)
      gain.connect(this.ctx.destination)

      const whenStart = scheduleAhead + cursor
      const whenEnd = whenStart + region.duration

      // Schedule gain envelope
      if (region.fadeIn > 0) {
        gain.gain.setValueAtTime(0, whenStart)
        gain.gain.linearRampToValueAtTime(1, whenStart + region.fadeIn)
      } else {
        gain.gain.setValueAtTime(1, whenStart)
      }

      if (region.fadeOut > 0) {
        gain.gain.setValueAtTime(1, whenEnd - region.fadeOut)
        gain.gain.linearRampToValueAtTime(0, whenEnd)
      }

      // start(when, offset, duration)
      src.start(whenStart, region.offset, region.duration)
      src.stop(whenEnd)

      this.sources.push({ src, gain })
      cursor += region.duration
    }

    this.startedAt = this.ctx.currentTime + 0.1
    this.playing = true
    this._tick()

    // Auto-stop when done
    setTimeout(() => this.stop(), (this.totalDuration + 0.5) * 1000)
  }

  stop() {
    this.playing = false
    cancelAnimationFrame(this.animFrame)

    for (const { src, gain } of this.sources) {
      try { src.stop() } catch {}
      src.disconnect()
      gain.disconnect()
    }
    this.sources = []
    this.startedAt = null

    if (this.onStop) this.onStop()
  }

  currentTime() {
    if (!this.playing || !this.startedAt || !this.ctx) return 0
    return Math.min(this.ctx.currentTime - this.startedAt, this.totalDuration)
  }

  _tick() {
    if (!this.playing) return
    const t = this.currentTime()
    if (this.onTimeUpdate) {
      this.onTimeUpdate(t, this.totalDuration)
    }
    // Report position back to server so CLI can show it
    if (this.onStatusUpdate) {
      this.onStatusUpdate(t, this.totalDuration, true)
    }
    this.animFrame = requestAnimationFrame(() => this._tick())
  }

  // Draw timeline regions onto canvas
  drawTimeline(canvas, edl) {
    if (!edl || !edl.regions.length) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width = canvas.offsetWidth
    const h = canvas.height = canvas.offsetHeight
    const total = edl.regions.reduce((s, r) => s + r.duration, 0)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, h)

    const colors = ['#1e3a4a', '#1e4a3a', '#3a1e4a', '#4a3a1e']
    let cursor = 0

    edl.regions.forEach((region, i) => {
      const x = (cursor / total) * w
      const rw = (region.duration / total) * w
      const color = colors[i % colors.length]

      ctx.fillStyle = color
      ctx.fillRect(x + 1, 4, rw - 2, h - 8)

      // Fade in indicator
      if (region.fadeIn > 0) {
        const fw = (region.fadeIn / total) * w
        ctx.fillStyle = 'rgba(255,255,255,0.1)'
        ctx.beginPath()
        ctx.moveTo(x + 1, h - 4)
        ctx.lineTo(x + 1 + fw, 4)
        ctx.lineTo(x + 1, 4)
        ctx.fill()
      }

      // Region label
      if (rw > 40) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.font = '10px monospace'
        ctx.fillText(`${region.duration.toFixed(1)}s`, x + 4, h / 2 + 4)
      }

      cursor += region.duration
    })

    // Playhead
    if (this.playing) {
      const px = (this.currentTime() / total) * w
      ctx.strokeStyle = '#4ec9b0'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, h)
      ctx.stroke()
    }
  }
}

window.SPEDPlayer = SPEDPlayer
