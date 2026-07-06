'use strict'

// sped-e Web Audio playback engine — multitrack
// Receives { tracks: [ { id, regions, muted, gain }, ... ] }
// Schedules all tracks simultaneously, mixed to destination

class SPEDPlayer {
  constructor() {
    this.ctx = null
    this.sources = []
    this.bufferCache = {}
    this.startedAt = null
    this.totalDuration = 0
    this.playing = false
    this.animFrame = null
    this.onTimeUpdate = null
    this.onStatusUpdate = null
    this.onStop = null
  }

  _ensureContext() {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  async _loadBuffer(file) {
    if (this.bufferCache[file]) return this.bufferCache[file]
    const url = '/audio?file=' + encodeURIComponent(file)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('Failed to load ' + file + ': ' + resp.status)
    const arrayBuf = await resp.arrayBuffer()
    const audioBuf = await this.ctx.decodeAudioData(arrayBuf)
    this.bufferCache[file] = audioBuf
    return audioBuf
  }

  async play(payload) {
    this.stop()
    this._ensureContext()

    const tracks = payload.tracks || []
    const scheduleAhead = this.ctx.currentTime + 0.1

    // Find total duration across all unmuted tracks
    this.totalDuration = Math.max(0, ...tracks
      .filter(t => !t.muted)
      .map(t => t.regions.reduce((s, r) => s + (r.duration || 0), 0))
    )

    // Schedule each track
    for (const track of tracks) {
      if (track.muted) continue

      // Track gain node for volume/mute
      const trackGain = this.ctx.createGain()
      trackGain.gain.value = track.gain != null ? track.gain : 1.0
      trackGain.connect(this.ctx.destination)

      let cursor = 0
      for (const region of track.regions) {
        if (!region.duration) continue
        const buf = await this._loadBuffer(region.file)
        const src = this.ctx.createBufferSource()
        src.buffer = buf

        // Region gain for fades
        const regionGain = this.ctx.createGain()
        src.connect(regionGain)
        regionGain.connect(trackGain)

        const whenStart = scheduleAhead + cursor
        const whenEnd = whenStart + region.duration

        if (region.fadeIn > 0) {
          regionGain.gain.setValueAtTime(0, whenStart)
          regionGain.gain.linearRampToValueAtTime(1, whenStart + region.fadeIn)
        } else {
          regionGain.gain.setValueAtTime(1, whenStart)
        }
        if (region.fadeOut > 0) {
          regionGain.gain.setValueAtTime(1, whenEnd - region.fadeOut)
          regionGain.gain.linearRampToValueAtTime(0, whenEnd)
        }

        src.start(whenStart, region.offset, region.duration)
        src.stop(whenEnd)

        this.sources.push({ src, gain: regionGain, trackGain })
        cursor += region.duration
      }
    }

    this.startedAt = this.ctx.currentTime + 0.1
    this.playing = true
    this._tick()

    setTimeout(() => this.stop(), (this.totalDuration + 0.5) * 1000)
  }

  stop() {
    this.playing = false
    cancelAnimationFrame(this.animFrame)
    for (const { src, gain, trackGain } of this.sources) {
      try { src.stop() } catch {}
      try { src.disconnect(); gain.disconnect() } catch {}
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
    if (this.onTimeUpdate) this.onTimeUpdate(t, this.totalDuration)
    if (this.onStatusUpdate) this.onStatusUpdate(t, this.totalDuration, true)
    this.animFrame = requestAnimationFrame(() => this._tick())
  }

  // Draw a single track on its own canvas
  drawTrack(canvas, track, currentTime, payload) {
    const ctx = canvas.getContext('2d')
    const w = canvas.width = canvas.offsetWidth
    const h = canvas.height = canvas.offsetHeight
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, h)

    if (!track || !track.regions.length) return

    // Total duration is max across all tracks for consistent scale
    const total = payload
      ? Math.max(1, ...payload.tracks.map(t => t.regions.reduce((s, r) => s + (r.duration || 0), 0)))
      : Math.max(1, track.regions.reduce((s, r) => s + (r.duration || 0), 0))

    const colors = ['#1e3a4a', '#1e4a3a', '#3a1e4a', '#4a3a1e', '#1e3a3a']
    const color = colors[parseInt(track.id) % colors.length]

    let cursor = 0
    track.regions.forEach((region, ri) => {
      if (!region.duration) return
      const x = (cursor / total) * w
      const rw = (region.duration / total) * w
      ctx.fillStyle = track.muted ? '#2a2a2a' : color
      ctx.fillRect(x + 1, 2, rw - 2, h - 4)
      if (rw > 20) {
        ctx.fillStyle = track.muted ? '#444' : 'rgba(255,255,255,0.4)'
        ctx.font = '9px monospace'
        ctx.fillText(region.duration.toFixed(1) + 's', x + 3, h / 2 + 3)
      }
      cursor += region.duration
    })

    // Playhead
    if (this.playing && currentTime > 0) {
      const px = (currentTime / total) * w
      ctx.strokeStyle = '#4ec9b0'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, h)
      ctx.stroke()
    }
  }

  drawTimeline(canvas, payload) {
    if (!payload || !payload.tracks) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width = canvas.offsetWidth
    const h = canvas.height = canvas.offsetHeight
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, h)

    const tracks = payload.tracks
    if (!tracks.length) return

    const total = Math.max(1, ...tracks.map(t =>
      t.regions.reduce((s, r) => s + (r.duration || 0), 0)
    ))

    const trackH = Math.min(Math.floor((h - 4) / tracks.length), 40)
    const trackColors = ['#1e3a4a', '#1e4a3a', '#3a1e4a', '#4a3a1e', '#1e3a3a', '#4a1e3a']

    tracks.forEach((track, ti) => {
      const ty = ti * trackH + 2
      const color = trackColors[ti % trackColors.length]
      let cursor = 0

      // Track label background
      ctx.fillStyle = track.muted ? '#1a1a1a' : '#181818'
      ctx.fillRect(0, ty, w, trackH - 1)

      track.regions.forEach((region, ri) => {
        if (!region.duration) return
        const x = (cursor / total) * w
        const rw = (region.duration / total) * w
        ctx.fillStyle = track.muted ? '#2a2a2a' : color
        ctx.fillRect(x + 1, ty + 1, rw - 2, trackH - 3)

        if (rw > 30) {
          ctx.fillStyle = track.muted ? '#444' : 'rgba(255,255,255,0.5)'
          ctx.font = '9px monospace'
          ctx.fillText('t' + track.id, x + 3, ty + trackH / 2 + 3)
        }
        cursor += region.duration
      })

      // Muted indicator
      if (track.muted) {
        ctx.fillStyle = 'rgba(255,80,80,0.3)'
        ctx.fillRect(0, ty, w, trackH - 1)
        ctx.fillStyle = '#f55'
        ctx.font = '9px monospace'
        ctx.fillText('muted', 4, ty + trackH / 2 + 3)
      }
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
