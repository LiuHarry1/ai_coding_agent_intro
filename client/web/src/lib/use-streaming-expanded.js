import { useEffect, useRef, useState } from 'react'

/**
 * Tool cards should auto-expand ONLY while the tool is running so the
 * user can see streaming output. Once the call finishes (or for any
 * already-finished card on first mount) we collapse it to keep the
 * conversation scannable. After the user manually toggles the card we
 * stop overriding their choice.
 *
 * Usage:
 *   const [expanded, toggle] = useStreamingExpanded(!isDone);
 *   <ToolRowHeader expanded={expanded} onToggle={toggle} … />
 */
export function useStreamingExpanded(isRunning) {
  const [expanded, setExpanded] = useState(Boolean(isRunning))
  const userToggled = useRef(false)

  useEffect(() => {
    if (userToggled.current) return
    setExpanded(Boolean(isRunning))
  }, [isRunning])

  const toggle = () => {
    userToggled.current = true
    setExpanded(v => !v)
  }

  return [expanded, toggle, setExpanded]
}
