'use strict'

const fs = require('fs')

// Read duration from WAV file by scanning for chunks
function getWavDuration(filepath) {
  try {
    const fd = fs.openSync(filepath, 'r')
    const header = Buffer.alloc(12)
    fs.readSync(fd, header, 0, 12, 0)

    if (header.toString('ascii', 0, 4) !== 'RIFF') {
      fs.closeSync(fd)
      return null
    }
    if (header.toString('ascii', 8, 12) !== 'WAVE') {
      fs.closeSync(fd)
      return null
    }

    // Scan chunks to find fmt and data
    let offset = 12
    let sampleRate = null
    let numChannels = null
    let bitsPerSample = null
    let dataSize = null
    const chunk = Buffer.alloc(8)

    while (offset < 1000000) { // safety limit
      const read = fs.readSync(fd, chunk, 0, 8, offset)
      if (read < 8) break

      const id = chunk.toString('ascii', 0, 4)
      const size = chunk.readUInt32LE(4)

      if (id === 'fmt ') {
        const fmt = Buffer.alloc(size)
        fs.readSync(fd, fmt, 0, size, offset + 8)
        numChannels  = fmt.readUInt16LE(2)
        sampleRate   = fmt.readUInt32LE(4)
        bitsPerSample = fmt.readUInt16LE(14)
      } else if (id === 'data') {
        dataSize = size
        break
      }

      offset += 8 + size
      // chunks must be word-aligned
      if (size % 2 !== 0) offset++
    }

    fs.closeSync(fd)

    if (!sampleRate || !numChannels || !bitsPerSample || !dataSize) return null

    const bytesPerSample = bitsPerSample / 8
    const totalSamples = dataSize / (numChannels * bytesPerSample)
    return totalSamples / sampleRate

  } catch (e) {
    return null
  }
}

module.exports = { getWavDuration }
