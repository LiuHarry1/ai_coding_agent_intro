import React, { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../stores/chat-store.js'

const MODES = [
  { id: 'agent', label: 'Agent', desc: 'Edit and run commands' },
  { id: 'ask', label: 'Ask', desc: 'Read-only exploration' },
  { id: 'plan', label: 'Plan', desc: 'Design before building' },
]

export default function ModePicker() {
  const agentMode = useChatStore(s => s.agentMode)
  const setAgentMode = useChatStore(s => s.setAgentMode)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const current = MODES.find(m => m.id === agentMode) ?? MODES[0]

  useEffect(() => {
    const onDoc = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div className='mode-picker' ref={ref}>
      <button
        type='button'
        className={`mode-pill mode-pill--${current.id}${open ? ' mode-pill--open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-haspopup='listbox'
        aria-expanded={open}
      >
        <span className='mode-pill__label'>{current.label}</span>
        <svg
          className={`mode-pill__chevron${open ? ' mode-pill__chevron--open' : ''}`}
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>
      {open && (
        <div
          className='mode-picker__menu'
          role='listbox'
          aria-label='Select mode'
        >
          {MODES.map(m => (
            <button
              key={m.id}
              type='button'
              role='option'
              aria-selected={m.id === agentMode}
              className={`mode-picker__item mode-picker__item--${m.id}${m.id === agentMode ? ' mode-picker__item--active' : ''}`}
              onClick={() => {
                setAgentMode(m.id)
                setOpen(false)
              }}
            >
              <span className='mode-picker__item-label'>{m.label}</span>
              <span className='mode-picker__item-desc'>{m.desc}</span>
              {m.id === agentMode && (
                <svg
                  className='mode-picker__check'
                  width='14'
                  height='14'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2.5'
                  aria-hidden='true'
                >
                  <polyline points='20 6 9 17 4 12' />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
