import React, { useState } from 'react'
import { useChatActions } from '../lib/chat-actions.jsx'

function resultHint(description, choice) {
  if (typeof description !== 'string' || !description.trim()) return null
  const match = description.match(
    /permissions to (?:read from|write to) (.+), but you haven't granted it yet\.$/i,
  )
  const target = match?.[1]
  if (!target) return null
  if (choice === 'always') return `Always allow ${target}`
  if (choice === 'allow') return target
  return target
}

export default function CanUseToolCard({ part }) {
  const { answerCanUseTool } = useChatActions()
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(
    part.status === 'answered' || part.status === 'done',
  )
  const [choice, setChoice] = useState(part.decision)

  const handle = async decision => {
    if (submitting || done || !part.id) return
    setSubmitting(true)
    try {
      await answerCanUseTool(part.id, decision)
      setChoice(decision)
      setDone(true)
    } catch (err) {
      console.error('[CanUseTool] submit failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    const label =
      choice === 'always'
        ? 'Always allowed'
        : choice === 'allow'
          ? 'Allowed'
          : 'Rejected'
    const hint = resultHint(part.description, choice)
    return (
      <div className='ask-card ask-card--done'>
        <span className='ask-card__title'>{label}</span>
        {hint && <p className='ask-card__hint'>{hint}</p>}
      </div>
    )
  }

  return (
    <div className='ask-card'>
      <div className='ask-card__header'>
        <span className='ask-card__title'>
          {part.title || part.toolName || 'File permission'}
        </span>
        <span className='ask-card__hint'>Outside the workspace</span>
      </div>
      {part.description && (
        <p className='ask-question__text'>{part.description}</p>
      )}
      <div className='perm-card__actions'>
        <button
          type='button'
          className='ask-card__submit'
          disabled={submitting}
          onClick={() => handle('allow')}
        >
          Allow
        </button>
        <button
          type='button'
          className='ask-option'
          disabled={submitting}
          onClick={() => handle('always')}
        >
          <span className='ask-option__label'>Always allow</span>
        </button>
        <button
          type='button'
          className='ask-option perm-card__reject'
          disabled={submitting}
          onClick={() => handle('reject')}
        >
          <span className='ask-option__label'>Reject</span>
        </button>
      </div>
    </div>
  )
}
