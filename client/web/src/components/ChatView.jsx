import React, {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
  Suspense,
  lazy,
} from 'react'
import { useChatStore } from '../stores/chat-store.js'
import WelcomeScreen from './WelcomeScreen.jsx'

const MessageBubble = lazy(() => import('./MessageBubble.jsx'))

const PIN_THRESHOLD_PX = 140
const SHOW_BUTTON_PX = 120
/** Mount at most this many recent bubbles; older ones load on demand. */
const INITIAL_VISIBLE = 40
const LOAD_MORE_STEP = 40
/** Skip content-visibility on the newest N (streaming / expand-heavy). */
const LIVE_TAIL = 4

function distanceFromBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export default function ChatView() {
  const messages = useChatStore(s => s.messages)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const sessionLoading = useChatStore(s => s.sessionLoading)
  const scrollRef = useRef(null)
  const messagesRef = useRef(null)
  const pinToBottomRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const hasMessages = messages.length > 0

  // Reset window when switching sessions.
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
  }, [currentSessionId])

  const startIndex = Math.max(0, messages.length - visibleCount)
  const visibleMessages = useMemo(
    () => messages.slice(startIndex),
    [messages, startIndex],
  )
  const hiddenCount = startIndex

  const stickToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el || !pinToBottomRef.current) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  useLayoutEffect(() => {
    pinToBottomRef.current = true
    setShowScrollBtn(false)
    stickToBottom()
  }, [currentSessionId, stickToBottom])

  useLayoutEffect(() => {
    stickToBottom()
  }, [messages, visibleCount, stickToBottom])

  useEffect(() => {
    const root = scrollRef.current
    const inner = messagesRef.current
    if (!root || !inner || !hasMessages) return
    const ro = new ResizeObserver(() => {
      if (pinToBottomRef.current) stickToBottom()
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [currentSessionId, hasMessages, stickToBottom])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = distanceFromBottom(el)
    if (programmaticScrollRef.current) {
      if (dist < PIN_THRESHOLD_PX) programmaticScrollRef.current = false
    } else {
      pinToBottomRef.current = dist < PIN_THRESHOLD_PX
    }
    setShowScrollBtn(dist > SHOW_BUTTON_PX)
  }, [])

  const releaseProgrammatic = useCallback(() => {
    programmaticScrollRef.current = false
  }, [])

  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinToBottomRef.current = true
    programmaticScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    pinToBottomRef.current = false
    setVisibleCount(c => Math.min(messages.length, c + LOAD_MORE_STEP))
    // Preserve viewport anchor after prepending older bubbles.
    requestAnimationFrame(() => {
      if (!el) return
      const delta = el.scrollHeight - prevHeight
      programmaticScrollRef.current = true
      el.scrollTop = prevTop + delta
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
  }, [messages.length])

  return (
    <div className='chat-view-wrap'>
      <div
        className='chat-view'
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={releaseProgrammatic}
        onPointerDown={releaseProgrammatic}
      >
        {sessionLoading ? (
          <div className='messages' ref={messagesRef} aria-busy='true' />
        ) : !hasMessages ? (
          <WelcomeScreen />
        ) : (
          <div className='messages' ref={messagesRef}>
            {hiddenCount > 0 && (
              <button
                type='button'
                className='load-earlier-msgs'
                onClick={loadEarlier}
              >
                Show {Math.min(LOAD_MORE_STEP, hiddenCount)} earlier
                {hiddenCount > LOAD_MORE_STEP
                  ? ` (${hiddenCount} hidden)`
                  : ''}
              </button>
            )}
            <Suspense fallback={null}>
              {visibleMessages.map((msg, i) => {
                const absIndex = startIndex + i
                const fromEnd = messages.length - 1 - absIndex
                const skipContain = fromEnd < LIVE_TAIL
                return (
                  <div
                    key={msg.id ?? `msg-${absIndex}-${msg.type}`}
                    className={
                      skipContain
                        ? 'msg-slot msg-slot--live'
                        : 'msg-slot msg-slot--contain'
                    }
                  >
                    <MessageBubble message={msg} />
                  </div>
                )
              })}
            </Suspense>
          </div>
        )}
      </div>
      {showScrollBtn && (
        <button
          className='scroll-to-bottom'
          onClick={scrollToBottomSmooth}
          title='Scroll to bottom'
          aria-label='Scroll to bottom'
        >
          <svg
            width='16'
            height='16'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2.5'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <polyline points='6 9 12 15 18 9' />
          </svg>
        </button>
      )}
    </div>
  )
}
