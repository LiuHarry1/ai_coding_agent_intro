import React, {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  Suspense,
  lazy,
} from 'react'
import { useChatStore } from '../stores/chat-store.js'
import WelcomeScreen from './WelcomeScreen.jsx'

const MessageBubble = lazy(() => import('./MessageBubble.jsx'))

const PIN_THRESHOLD_PX = 140
const SHOW_BUTTON_PX = 120

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
  const hasMessages = messages.length > 0

  const stickToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el || !pinToBottomRef.current) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  // Opening a session (including history) should land on the latest turn.
  useLayoutEffect(() => {
    pinToBottomRef.current = true
    setShowScrollBtn(false)
    stickToBottom()
  }, [currentSessionId, stickToBottom])

  // Follow stream updates only while pinned. Expanding a Worked group after
  // scrolling up must not yank the viewport (Cursor transcript behavior).
  useLayoutEffect(() => {
    stickToBottom()
  }, [messages, stickToBottom])

  // Images / lazy bubbles can grow after `messages` settles.
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
            <Suspense fallback={null}>
              {messages.map((msg, i) => (
                <MessageBubble
                  key={msg.id ?? `msg-${i}-${msg.type}`}
                  message={msg}
                  isLast={i === messages.length - 1}
                />
              ))}
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
