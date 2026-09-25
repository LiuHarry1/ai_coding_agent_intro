/**
 * How a scroll reads back to the model: what actually moved, and how much is
 * left on each side in viewport-sized pages (browser-use's page_info format).
 *
 * The accessibility snapshot does not change with scroll position, so without
 * this the model cannot tell a scroll that worked from one stuck at the end.
 */

export interface ScrollExtent {
  x: number
  y: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  scrollHeight: number
}

export interface ScrollOutcome {
  /**
   * `wheel` means nothing had a native scroll position (canvas, custom
   * scrollers), so a wheel event was dispatched and the effect is unknown.
   */
  kind: 'page' | 'container' | 'into-view' | 'wheel'
  /** The container that scrolled, or the element brought into view. */
  label?: string
  requested: { x: number; y: number }
  moved: { x: number; y: number }
  extent: ScrollExtent
}

/** Sub-pixel leftovers from zoom and fractional layout count as the edge. */
const EDGE_PX = 1

export function scrollRemaining(e: ScrollExtent): {
  above: number
  below: number
  left: number
  right: number
} {
  const clamp = (px: number) => (px < EDGE_PX ? 0 : Math.round(px))
  return {
    above: clamp(e.y),
    below: clamp(e.scrollHeight - e.clientHeight - e.y),
    left: clamp(e.x),
    right: clamp(e.scrollWidth - e.clientWidth - e.x),
  }
}

export function formatScrollPosition(
  e: ScrollExtent,
  noun: 'page' | 'container' = 'page',
): string {
  const r = scrollRemaining(e)
  const pages = (px: number, size: number) =>
    size > 0 ? (px / size).toFixed(1) : '0.0'
  let text = `${pages(r.above, e.clientHeight)} pages above, ${pages(r.below, e.clientHeight)} pages below`
  if (r.left > 0 || r.right > 0) {
    text += `, ${pages(r.left, e.clientWidth)} pages left, ${pages(r.right, e.clientWidth)} pages right`
  }
  text += ` (viewport ${e.clientHeight}px, content ${e.scrollHeight}px)`
  if (r.above === 0) text += ` [Top of ${noun}]`
  if (r.below === 0) text += ` [End of ${noun}]`
  return text
}

export function formatScrollOutcome(o: ScrollOutcome): string {
  if (o.kind === 'into-view') {
    return `Scrolled ${o.label ?? 'element'} into view. Page position: ${formatScrollPosition(o.extent)}`
  }
  if (o.kind === 'wheel') {
    return `Nothing here has a native scroll position, so a mouse wheel of (${o.requested.x}px, ${o.requested.y}px) was dispatched at the viewport center. Take a snapshot or screenshot to see what moved.`
  }

  const noun = o.kind === 'container' ? 'container' : 'page'
  const where = o.kind === 'container' ? `container ${o.label ?? ''}`.trim() : 'page'
  const remaining = scrollRemaining(o.extent)
  const axes = [
    {
      requested: o.requested.y,
      moved: o.moved.y,
      edge: o.requested.y > 0 ? 'bottom' : 'top',
      left: o.requested.y > 0 ? remaining.below : remaining.above,
    },
    {
      requested: o.requested.x,
      moved: o.moved.x,
      edge: o.requested.x > 0 ? 'right edge' : 'left edge',
      left: o.requested.x > 0 ? remaining.right : remaining.left,
    },
  ].filter(a => a.requested !== 0)
  const position = formatScrollPosition(o.extent, noun)

  if (axes.every(a => Math.abs(a.moved) < EDGE_PX)) {
    const cannotScroll =
      o.extent.scrollHeight <= o.extent.clientHeight + EDGE_PX &&
      o.extent.scrollWidth <= o.extent.clientWidth + EDGE_PX
    if (cannotScroll) {
      return `Warning: no scroll occurred — this ${noun} has no scrollable overflow. Pass the ref of the scrollable list or panel to scroll it. Position: ${position}`
    }
    const edges = axes.map(a => a.edge).join(' and ')
    return `Warning: no scroll occurred — already at the ${edges} of the ${noun}. Position: ${position}`
  }

  const reached = axes
    .filter(a => Math.abs(a.moved) >= EDGE_PX && a.left === 0)
    .map(a => a.edge)
  const tail = reached.length
    ? `; reached the ${reached.join(' and ')} of the ${noun}`
    : ''
  return `Scrolled ${where} by (${Math.round(o.moved.x)}px, ${Math.round(o.moved.y)}px)${tail}. Position: ${position}`
}
