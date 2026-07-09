'use strict'

// Browser-side WAV export using OfflineAudioContext
// Renders the EDL exactly as playback but to a buffer, then downloads as WAV

class SPEDExporter {
  constructor() {
    this.bufferCache = {}
  }

  async _loadBuffer(ctx, file) {
    if (this.bufferCache[file]) return this.bufferCache[file]
    const url = '/audio?file=' + encodeURIComponent(file)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('Failed to load ' + file)
    const arrayBuf = await resp.arrayBuffer()
    const audioBuf = await ctx.decodeAudioData(arrayBuf)
    this.bufferCache[file] = audioBuf
    return audioBuf
  }

  async export(payload, onProgress) {
    const tracks = (payload.tracks || []).filter(t => !t.muted)
    if (!tracks.length) throw new Error('No unmuted tracks to export')

    // Determine sample rate and total duration
    let sampleRate = 44100
    let totalDuration = 0

    for (const track of tracks) {
      let dur = 0
      for (const r of track.regions) dur += r.duration || 0
      if (dur > totalDuration) totalDuration = dur
    }

    if (totalDuration === 0) throw new Error('Nothing to export')

    // Use a temporary AudioContext to decode files and get sample rate
    const tmpCtx = new AudioContext()
    for (const track of tracks) {
      for (const r of track.regions) {
        if (r.file) {
          try {
            const buf = await this._loadBuffer(tmpCtx, r.file)
            sampleRate = buf.sampleRate
            break
          } catch {}
        }
      }
      break
    }
    tmpCtx.close()

    if (onProgress) onProgress('Creating offline context...', 0)

    const totalFrames = Math.ceil(totalDuration * sampleRate)
    const offlineCtx = new OfflineAudioContext(2, totalFrames, sampleRate)

    // Decode all buffers using offline context
    const fileCache = {}
    const loadBuf = async (file) => {
      if (fileCache[file]) return fileCache[file]
      const url = '/audio?file=' + encodeURIComponent(file)
      const resp = await fetch(url)
      const arrayBuf = await resp.arrayBuffer()
      const audioBuf = await offlineCtx.decodeAudioData(arrayBuf)
      fileCache[file] = audioBuf
      return audioBuf
    }

    let trackIdx = 0
    for (const track of tracks) {
      if (onProgress) onProgress('Scheduling track ' + track.id + '...', trackIdx / tracks.length * 0.5)

      const trackGain = offlineCtx.createGain()
      trackGain.gain.value = track.gain || 1.0
      trackGain.connect(offlineCtx.destination)

      let cursor = 0
      for (const region of track.regions) {
        if (!region.duration) { cursor += region.duration || 0; continue }

        let buf
        try {
          buf = await loadBuf(region.file)
        } catch (e) {
          console.warn('Could not load', region.file, e)
          cursor += region.duration
          continue
        }

        const src = offlineCtx.createBufferSource()
        src.buffer = buf

        const gainNode = offlineCtx.createGain()
        src.connect(gainNode)
        gainNode.connect(trackGain)

        const whenStart = cursor
        const whenEnd = cursor + region.duration

        if (region.fadeIn > 0) {
          gainNode.gain.setValueAtTime(0, whenStart)
          gainNode.gain.linearRampToValueAtTime(1, whenStart + region.fadeIn)
        }
        if (region.fadeOut > 0) {
          gainNode.gain.setValueAtTime(1, whenEnd - region.fadeOut)
          gainNode.gain.linearRampToValueAtTime(0, whenEnd)
        }

        src.start(whenStart, region.offset, region.duration)

        cursor += region.duration
      }
      trackIdx++
    }

    if (onProgress) onProgress('Rendering...', 0.5)

    const rendered = await offlineCtx.startRendering()

    if (onProgress) onProgress('Encoding WAV...', 0.9)

    const wav = this._encodeWav(rendered)
    this._download(wav, 'sped-export.wav')

    if (onProgress) onProgress('Done', 1.0)

    return rendered.duration
  }

  _encodeWav(audioBuffer) {
    const numChannels = 2
    const sampleRate = audioBuffer.sampleRate
    const bitsPerSample = 16
    const numFrames = audioBuffer.length
    const dataSize = numFrames * numChannels * (bitsPerSample / 8)

    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
    }

    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)                          // PCM
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true)
    view.setUint16(32, numChannels * (bitsPerSample / 8), true)
    view.setUint16(34, bitsPerSample, true)
    writeStr(36, 'data')
    view.setUint32(40, dataSize, true)

    // Get channel data
    const left  = audioBuffer.getChannelData(0)
    const right = audioBuffer.numberOfChannels > 1
      ? audioBuffer.getChannelData(1)
      : audioBuffer.getChannelData(0)

    let offset = 44
    for (let i = 0; i < numFrames; i++) {
      // Clamp and convert to 16-bit
      const l = Math.max(-1, Math.min(1, left[i]))
      const r = Math.max(-1, Math.min(1, right[i]))
      view.setInt16(offset, l < 0 ? l * 32768 : l * 32767, true); offset += 2
      view.setInt16(offset, r < 0 ? r * 32768 : r * 32767, true); offset += 2
    }

    return new Blob([buffer], { type: 'audio/wav' })
  }

  _download(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

window.SPEDExporter = SPEDExporter
