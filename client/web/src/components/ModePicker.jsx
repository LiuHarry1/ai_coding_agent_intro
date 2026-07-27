import React, { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { agentApi } from '../lib/api/agent.js'

const MODES = [
  { id: 'agent', label: 'Agent', desc: 'Edit and run commands' },
  { id: 'ask', label: 'Ask', desc: 'Read-only exploration' },
  { id: 'plan', label: 'Plan', desc: 'Design before building' },
]

/** Short blurb for hover tip — keep full whenToUse for the model. */
function pickerBlurb(whenToUse, fallback = '') {
  const t = String(whenToUse || fallback || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t) return ''
  const m = t.match(/^(.+?[.!?])(?:\s|$)/)
  return m ? m[1] : t.length > 96 ? `${t.slice(0, 96)}…` : t
}

export default function ModePicker() {
  const agentMode = useChatStore(s => s.agentMode)
  const agentType = useChatStore(s => s.agentType)
  const setAgentMode = useChatStore(s => s.setAgentMode)
  const setAgentType = useChatStore(s => s.setAgentType)
  const workspace = useChatStore(s => s.workspace)
  const [open, setOpen] = useState(false)
  const [primaryAgents, setPrimaryAgents] = useState([])
  const [hovered, setHovered] = useState(null)
  const ref = useRef(null)
  const flyoutRef = useRef(null)

  const showTip = (e, label, desc) => {
    if (!desc) {
      setHovered(null)
      return
    }
    const flyout = flyoutRef.current
    const row = e.currentTarget
    if (!flyout || !row) {
      setHovered({ label, desc, top: 0 })
      return
    }
    const flyRect = flyout.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const top = rowRect.top - flyRect.top + rowRect.height / 2
    setHovered({ label, desc, top })
  }

  const hideTip = () => setHovered(null)

  useEffect(() => {
    let cancelled = false
    agentApi
      .getAgents(workspace || undefined)
      .then(data => {
        if (cancelled) return
        const list = Array.isArray(data?.agents) ? data.agents : []
        setPrimaryAgents(
          list
            .filter(a => a.mode === 'primary')
            .map(a => ({
              id: a.agentType,
              label: a.label || a.agentType,
              desc: pickerBlurb(a.whenToUse, a.description),
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        )
      })
      .catch(() => {
        if (!cancelled) setPrimaryAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  const current = useMemo(() => {
    if (agentType) {
      const specialist = primaryAgents.find(a => a.id === agentType)
      if (specialist) {
        return {
          id: specialist.id,
          label: specialist.label,
          pillClass: 'specialist',
        }
      }
      return { id: agentType, label: agentType, pillClass: 'specialist' }
    }
    const mode = MODES.find(m => m.id === agentMode) ?? MODES[0]
    return { id: mode.id, label: mode.label, pillClass: mode.id }
  }, [agentMode, agentType, primaryAgents])

  useEffect(() => {
    if (!open) setHovered(null)
  }, [open])

  useEffect(() => {
    const onDoc = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selectMode = id => {
    setAgentMode(id)
    setOpen(false)
  }

  const selectSpecialist = id => {
    setAgentType(id)
    setOpen(false)
  }

  const isModeActive = id => !agentType && agentMode === id
  const isSpecialistActive = id => agentType === id

  const checkIcon = (
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
  )

  const renderRow = ({ key, label, desc, active, onClick }) => (
    <button
      key={key}
      type='button'
      role='option'
      aria-selected={active}
      aria-description={desc || undefined}
      className={`mode-picker__item${active ? ' mode-picker__item--active' : ''}`}
      onClick={onClick}
      onMouseEnter={e => showTip(e, label, desc)}
      onFocus={e => showTip(e, label, desc)}
      onMouseLeave={hideTip}
      onBlur={hideTip}
    >
      <span className='mode-picker__item-label'>{label}</span>
      {active && checkIcon}
    </button>
  )

  return (
    <div className='mode-picker' ref={ref}>
      <button
        type='button'
        className={`mode-pill mode-pill--${current.pillClass}${open ? ' mode-pill--open' : ''}`}
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
        <div className='mode-picker__flyout' ref={flyoutRef}>
          {hovered?.desc ? (
            <div
              className='mode-picker__tip'
              role='tooltip'
              style={{ top: hovered.top ?? 0 }}
            >
              {hovered.desc}
            </div>
          ) : null}
          <div
            className='mode-picker__menu'
            role='listbox'
            aria-label='Select mode'
          >
            {MODES.map(m =>
              renderRow({
                key: m.id,
                label: m.label,
                desc: m.desc,
                active: isModeActive(m.id),
                onClick: () => selectMode(m.id),
              }),
            )}
            {primaryAgents.length > 0 && (
              <>
                <div className='mode-picker__divider' role='separator' />
                {primaryAgents.map(a =>
                  renderRow({
                    key: a.id,
                    label: a.label,
                    desc: a.desc,
                    active: isSpecialistActive(a.id),
                    onClick: () => selectSpecialist(a.id),
                  }),
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
