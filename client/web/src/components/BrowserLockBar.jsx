import React, { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { agentApi } from '../lib/api/agent.js'

/**
 * Shown while a browser session is live. The user can take the page back
 * (Cursor Take Control) without waiting for the model to call browser_lock.
 *
 * Poll `/browser/lock` only for the browser specialist. Default / SSO
 * agents deny `browser_*` tools — a 2s poll would still hit the API and
 * can stall Chrome's per-host connection pool.
 */
export default function BrowserLockBar() {
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const agentType = useChatStore(s => s.agentType)
  const browserActive = agentType === 'browser'
  const [live, setLive] = useState(false)
  const [userHasControl, setUserHasControl] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await agentApi.getBrowserLock(currentSessionId)
      setLive(Boolean(data?.live))
      setUserHasControl(Boolean(data?.userHasControl))
    } catch {
      setLive(false)
    }
  }, [currentSessionId])

  useEffect(() => {
    if (!browserActive) {
      setLive(false)
      return
    }
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (inFlight || cancelled) return
      inFlight = true
      try {
        await refresh()
      } finally {
        inFlight = false
      }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refresh, browserActive])

  const handoff = async next => {
    setBusy(true)
    try {
      const data = await agentApi.setBrowserLock(next, currentSessionId)
      setLive(Boolean(data?.live))
      setUserHasControl(Boolean(data?.userHasControl))
    } catch {
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!live) return null

  return (
    <div
      className={`browser-lock-bar ${userHasControl ? 'is-user' : 'is-agent'}`}
      role="status"
    >
      <span className="browser-lock-bar-text">
        {userHasControl
          ? 'Agent actions paused — you can use the page freely.'
          : 'Agent is operating the browser (you can still interact; pause to avoid conflicts).'}
      </span>
      <button
        type="button"
        className="browser-lock-bar-btn"
        disabled={busy}
        onClick={() => handoff(!userHasControl)}
      >
        {userHasControl ? 'Resume agent' : 'Pause agent'}
      </button>
    </div>
  )
}
