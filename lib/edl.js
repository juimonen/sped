'use strict'

// EDL region: a contiguous slice of a source audio file
// { file, offset, duration, fadeIn, fadeOut }
//
// The EDL is a flat array of regions played sequentially.
// Total duration = sum of region durations.
// This is the SPED model: EDL and processing graph are the same structure.

function totalDuration(regions) {
  return regions.reduce((sum, r) => sum + r.duration, 0)
}

// Find which region contains timeline position t, and the local offset within it.
// Returns { index, localOffset } or null if t is beyond end.
function findPosition(regions, t) {
  let cursor = 0
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]
    if (t <= cursor + r.duration) {
      return { index: i, localOffset: t - cursor }
    }
    cursor += r.duration
  }
  return null // beyond end
}

// Split a region at a local offset within it.
// Returns [before, after] — either can be null if the split is at an edge.
function splitRegion(region, localOffset) {
  if (localOffset <= 0) return [null, { ...region }]
  if (localOffset >= region.duration) return [{ ...region }, null]

  const before = {
    ...region,
    duration: localOffset,
    fadeOut: 0  // crossfade handled separately
  }
  const after = {
    ...region,
    offset: region.offset + localOffset,
    duration: region.duration - localOffset,
    fadeIn: 0
  }
  return [before, after]
}

// Extract regions corresponding to timeline [start, end].
// Clips the first and last regions to fit exactly.
function extractRegions(regions, start, end) {
  const result = []
  let cursor = 0

  for (const region of regions) {
    const regionStart = cursor
    const regionEnd = cursor + region.duration

    if (regionEnd <= start || regionStart >= end) {
      cursor += region.duration
      continue
    }

    const clipStart = Math.max(start, regionStart) - regionStart
    const clipEnd = Math.min(end, regionEnd) - regionStart

    result.push({
      ...region,
      offset: region.offset + clipStart,
      duration: clipEnd - clipStart
    })

    cursor += region.duration
  }

  return result
}

// Cut timeline [start, end] out of regions.
// Returns new regions array with that section removed.
function cut(regions, start, end) {
  const result = []
  let cursor = 0

  for (const region of regions) {
    const regionStart = cursor
    const regionEnd = cursor + region.duration

    if (regionEnd <= start || regionStart >= end) {
      // Fully outside cut range — keep as is
      result.push({ ...region })
    } else {
      // Partially or fully inside cut range — keep what's outside
      if (regionStart < start) {
        const localOffset = start - regionStart
        const [before] = splitRegion(region, localOffset)
        if (before) result.push(before)
      }
      if (regionEnd > end) {
        const localOffset = end - regionStart
        const [, after] = splitRegion(region, localOffset)
        if (after) result.push(after)
      }
    }

    cursor += region.duration
  }

  return result
}

// Paste clipboard regions into regions at timeline position t.
function paste(regions, clipboardRegions, t) {
  const result = []
  let cursor = 0
  let inserted = false

  for (const region of regions) {
    const regionStart = cursor
    const regionEnd = cursor + region.duration

    if (!inserted && t <= regionEnd) {
      const localOffset = t - regionStart

      if (localOffset <= 0) {
        // Insert before this region
        result.push(...clipboardRegions.map(r => ({ ...r })))
        result.push({ ...region })
      } else if (localOffset >= region.duration) {
        // Insert after this region
        result.push({ ...region })
        result.push(...clipboardRegions.map(r => ({ ...r })))
      } else {
        // Split this region and insert between the halves
        const [before, after] = splitRegion(region, localOffset)
        if (before) result.push(before)
        result.push(...clipboardRegions.map(r => ({ ...r })))
        if (after) result.push(after)
      }

      inserted = true
    } else {
      result.push({ ...region })
    }

    cursor += region.duration
  }

  // If t is beyond the end, append
  if (!inserted) {
    result.push(...clipboardRegions.map(r => ({ ...r })))
  }

  return result
}

// Create a fresh EDL from a source file
function createEDL(file, duration) {
  return {
    regions: [{ file, offset: 0, duration, fadeIn: 0, fadeOut: 0 }],
    clipboard: null
  }
}

module.exports = { createEDL, cut, paste, extractRegions, totalDuration, findPosition }
