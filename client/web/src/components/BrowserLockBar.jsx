import React, { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { agentApi } from '../lib/api/agent.js'

/**
 * Shown while a browser session is live. The user can take the page back
 * (Cursor Take Control) without waiting for the model to call browser_lock.
 */
export default function BrowserLockBar() {
  const currentSessionId = useChatStore(s => s.currentSessionId)
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
    refresh()
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  }, [refresh])

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
          ? 'You have control of the browser. The agent will not click or type.'
          : 'The agent is driving the browser.'}
      </span>
      <button
        type="button"
        className="browser-lock-bar-btn"
        disabled={busy}
        onClick={() => handoff(!userHasControl)}
      >
        {userHasControl ? 'Resume agent' : 'Take control'}
      </button>
    </div>
  )
}
