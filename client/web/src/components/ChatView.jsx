import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  Suspense,
  lazy,
} from 'react'
import { useChatStore } from '../stores/chat-store.js'
import WelcomeScreen from './WelcomeScreen.jsx'

const MessageBubble = lazy(() => import('./MessageBubble.jsx'))

export default function ChatView() {
  const messages = useChatStore(s => s.messages)
  const scrollRef = useRef(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [])

  // Only stick to bottom when the user is already near it — otherwise stream
  // updates yank the viewport closed while they read an expanded Worked group
  // (Cursor transcript keeps scroll position on disclosure).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    if (dist < 140) scrollToBottom()
  }, [messages, scrollToBottom])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 120)
  }, [])

  return (
    <div className='chat-view' ref={scrollRef} onScroll={handleScroll}>
      {messages.length === 0 ? (
        <WelcomeScreen />
      ) : (
        <Suspense fallback={<div className='messages' aria-busy='true' />}>
          <div className='messages'>
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id ?? `msg-${i}-${msg.type}`}
                message={msg}
                isLast={i === messages.length - 1}
              />
            ))}
          </div>
        </Suspense>
      )}
      {showScrollBtn && (
        <button
          className='scroll-to-bottom'
          onClick={scrollToBottom}
          title='Scroll to bottom'
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
