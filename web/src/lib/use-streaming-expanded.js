import { useEffect, useRef, useState } from 'react'

/**
 * Density-aware expand state for tool rows.
 *
 * - `isRunning`: when true (and user hasn't toggled), keep expanded so
 *   streaming output is visible. When false, collapse.
 * - `expandOnceWhen`: one-shot force expand (e.g. first error) without
 *   treating the card as permanently "running". After the one-shot fires
 *   we leave the card alone until the user toggles.
 *
 * After the user manually toggles we never override their choice.
 */
export function useStreamingExpanded(isRunning, options = {}) {
  const { expandOnceWhen = false } = options
  const [expanded, setExpanded] = useState(Boolean(isRunning))
  const userToggled = useRef(false)
  const didExpandOnce = useRef(false)

  useEffect(() => {
    if (userToggled.current) return
    if (expandOnceWhen && !didExpandOnce.current) {
      didExpandOnce.current = true
      setExpanded(true)
      return
    }
    // One-shot expand already applied — don't immediately collapse via
    // isRunning=false on the next effect pass.
    if (didExpandOnce.current) return
    setExpanded(Boolean(isRunning))
  }, [isRunning, expandOnceWhen])

  const toggle = () => {
    userToggled.current = true
    setExpanded(v => !v)
  }

  return [expanded, toggle, setExpanded]
}
