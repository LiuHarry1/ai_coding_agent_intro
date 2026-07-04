import React, { useState, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'

function QuestionBlock({ question, answers, onChange }) {
  const { question: text, header, options, multiSelect } = question
  const selected = answers[text] ?? (multiSelect ? [] : '')

  const toggle = label => {
    if (multiSelect) {
      const arr = Array.isArray(selected) ? [...selected] : []
      const idx = arr.indexOf(label)
      if (idx >= 0) arr.splice(idx, 1)
      else arr.push(label)
      onChange(text, arr.join(', '))
    } else {
      onChange(text, label)
    }
  }

  const isSelected = label => {
    if (multiSelect) {
      const arr =
        typeof selected === 'string' ? selected.split(', ').filter(Boolean) : []
      return arr.includes(label)
    }
    return selected === label
  }

  return (
    <div className='ask-question'>
      {header && <div className='ask-question__chip'>{header}</div>}
      <p className='ask-question__text'>{text}</p>
      <div className='ask-question__options'>
        {options.map(opt => (
          <button
            key={opt.label}
            type='button'
            className={`ask-option${isSelected(opt.label) ? ' ask-option--selected' : ''}`}
            onClick={() => toggle(opt.label)}
          >
            <span className='ask-option__label'>{opt.label}</span>
            {opt.description && (
              <span className='ask-option__desc'>{opt.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function AskUserQuestionCard({ part }) {
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const [answers, setAnswers] = useState({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(part.status === 'answered')

  const questions = part.questions ?? []
  const allAnswered = useMemo(
    () => questions.every(q => answers[q.question]?.trim()),
    [questions, answers],
  )

  const handleChange = (questionText, value) => {
    setAnswers(prev => ({ ...prev, [questionText]: value }))
  }

  const handleSubmit = async () => {
    if (!allAnswered || submitting || done) return
    setSubmitting(true)
    try {
      await answerQuestion(
        part.id,
        answers,
        notes.trim() ? { notes } : undefined,
      )
      setDone(true)
    } catch (err) {
      console.error('[AskUserQuestion] submit failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className='ask-card ask-card--done'>
        <span className='ask-card__title'>Answers submitted</span>
      </div>
    )
  }

  return (
    <div className='ask-card'>
      <div className='ask-card__header'>
        <span className='ask-card__title'>Clarifying questions</span>
        <span className='ask-card__hint'>Select options to continue</span>
      </div>
      {questions.map(q => (
        <QuestionBlock
          key={q.question}
          question={q}
          answers={answers}
          onChange={handleChange}
        />
      ))}
      <textarea
        className='ask-card__notes'
        placeholder='Additional notes (optional)'
        value={notes}
        onChange={e => setNotes(e.target.value)}
        rows={2}
      />
      <button
        type='button'
        className='ask-card__submit'
        disabled={!allAnswered || submitting}
        onClick={handleSubmit}
      >
        {submitting ? 'Submitting…' : 'Submit answers'}
      </button>
    </div>
  )
}
