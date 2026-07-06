'use strict'

// Renders a Web Audio graph SVG for a track's regions
// Shows the node chain: Readers → Gains → TrackGain → Destination

function buildGraphData(track) {
  const nodes = []
  const edges = []
  let id = 0

  const destId = id++
  nodes.push({ id: destId, type: 'destination', label: 'Destination' })

  const trackGainId = id++
  nodes.push({ id: trackGainId, type: 'trackgain', label: 'TrackGain\ngain: ' + (track.gain || 1.0) + (track.muted ? '\n[MUTED]' : '') })
  edges.push({ from: trackGainId, to: destId })

  // If multiple regions, they fan into a Sum before TrackGain
  const needsSum = track.regions.length > 1
  let sumId = null
  if (needsSum) {
    sumId = id++
    nodes.push({ id: sumId, type: 'sum', label: 'Sum' })
    edges.push({ from: sumId, to: trackGainId })
  }

  track.regions.forEach((region, i) => {
    const fname = region.file.split('/').pop()
    const hasFade = region.fadeIn > 0 || region.fadeOut > 0

    const readerId = id++
    nodes.push({
      id: readerId,
      type: 'reader',
      label: fname + '\noff: ' + region.offset.toFixed(2) + 's\ndur: ' + (region.duration || 0).toFixed(2) + 's'
    })

    if (hasFade) {
      const fadeId = id++
      const fadeLabel = (region.fadeIn > 0 ? '↑' + region.fadeIn + 's ' : '') +
                        (region.fadeOut > 0 ? '↓' + region.fadeOut + 's' : '')
      nodes.push({ id: fadeId, type: 'fader', label: 'Fader\n' + fadeLabel })
      edges.push({ from: readerId, to: fadeId })
      edges.push({ from: fadeId, to: needsSum ? sumId : trackGainId })
    } else {
      edges.push({ from: readerId, to: needsSum ? sumId : trackGainId })
    }
  })

  return { nodes, edges }
}

function renderGraph(track, container) {
  const { nodes, edges } = buildGraphData(track)

  // Layout: readers on left, sum/trackgain/dest on right
  // Simple column layout
  const W = 520
  const nodeW = 110
  const nodeH = 50
  const colGap = 130
  const rowGap = 70

  // Assign columns
  const typeCol = { reader: 0, fader: 1, sum: 2, trackgain: 3, destination: 4 }
  const colCounts = {}
  nodes.forEach(n => {
    const col = typeCol[n.type]
    colCounts[col] = (colCounts[col] || 0)
    n.col = col
    n.row = colCounts[col]++
  })

  // Calculate positions
  const maxRows = Math.max(...Object.values(colCounts), 1)
  const H = Math.max(180, maxRows * rowGap + 60)

  nodes.forEach(n => {
    const colCount = colCounts[n.col]
    const totalH = colCount * rowGap
    const startY = (H - totalH) / 2
    n.x = 20 + n.col * colGap
    n.y = startY + n.row * rowGap
  })

  // Build SVG
  const colors = {
    reader: '#1e3a4a',
    fader: '#1e4a3a',
    sum: '#3a1e4a',
    trackgain: '#4a3a1e',
    destination: '#2a2a2a'
  }
  const borders = {
    reader: '#2a6a8a',
    fader: '#2a8a6a',
    sum: '#6a2a8a',
    trackgain: '#8a6a2a',
    destination: '#555'
  }

  const nodeMap = {}
  nodes.forEach(n => nodeMap[n.id] = n)

  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ' + (20 + 4 * colGap + nodeW + 20) + ' ' + H + '" style="font-family:monospace">'

  // Draw edges first
  edges.forEach(e => {
    const from = nodeMap[e.from]
    const to = nodeMap[e.to]
    if (!from || !to) return
    const x1 = from.x + nodeW
    const y1 = from.y + nodeH / 2
    const x2 = to.x
    const y2 = to.y + nodeH / 2
    const mx = (x1 + x2) / 2
    svg += '<path d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="#444" stroke-width="1.5" marker-end="url(#arr)"/>'
  })

  // Arrow marker
  svg += '<defs><marker id="arr" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#444"/></marker></defs>'

  // Draw nodes
  nodes.forEach(n => {
    const lines = n.label.split('\n')
    svg += '<rect x="' + n.x + '" y="' + n.y + '" width="' + nodeW + '" height="' + nodeH + '" rx="3" fill="' + colors[n.type] + '" stroke="' + borders[n.type] + '" stroke-width="1"/>'
    lines.forEach((line, i) => {
      const fontSize = i === 0 ? 10 : 8
      const color = i === 0 ? '#8cc8d8' : '#666'
      svg += '<text x="' + (n.x + nodeW/2) + '" y="' + (n.y + 14 + i * 12) + '" text-anchor="middle" font-size="' + fontSize + '" fill="' + color + '">' + line + '</text>'
    })
  })

  svg += '</svg>'
  container.innerHTML = svg
}

window.renderGraph = renderGraph
