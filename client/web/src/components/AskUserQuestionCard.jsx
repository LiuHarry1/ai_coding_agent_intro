import React, { useState, useMemo } from 'react'
import { useChatActions } from '../lib/chat-actions.jsx'
import { getTur } from '../lib/tool-result.js'

function normalizeQuestions(raw) {
  if (Array.isArray(raw)) return raw.filter(q => q && typeof q === 'object')
  if (raw && typeof raw === 'object') return [raw]
  return []
}

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(opt => opt && typeof opt.label === 'string')
}

function QuestionBlock({ question, answers, onChange }) {
  const { question: text, header, options, multiSelect } = question
  const opts = normalizeOptions(options)
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
        {opts.map(opt => (
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

export default function AskUserQuestionCard({ part, onAnswer }) {
  const { answerQuestion } = useChatActions()
  const submitAnswer = onAnswer ?? answerQuestion
  const tur = getTur(part)
  const [answers, setAnswers] = useState({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(
    part.status === 'answered' ||
      part.status === 'done' ||
      tur?.answered === true,
  )

  const questions = useMemo(
    () => normalizeQuestions(part.questions),
    [part.questions],
  )
  const allAnswered = useMemo(
    () =>
      questions.length > 0 &&
      questions.every(q => answers[q.question]?.trim()),
    [questions, answers],
  )

  const handleChange = (questionText, value) => {
    setAnswers(prev => ({ ...prev, [questionText]: value }))
  }

  const handleSubmit = async () => {
    if (!allAnswered || submitting || done) return
    setSubmitting(true)
    try {
      await submitAnswer(
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
    const saved =
      tur?.answers && typeof tur.answers === 'object' ? tur.answers : answers
    const entries = Object.entries(saved || {})
    return (
      <div className='ask-card ask-card--done'>
        <span className='ask-card__title'>Answers submitted</span>
        {entries.length > 0 && (
          <ul className='ask-card__answers'>
            {entries.map(([q, a]) => (
              <li key={q}>
                <span className='ask-card__q'>{q}</span>
                <span className='ask-card__a'>{a}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className='ask-card'>
      <div className='ask-card__header'>
        <span className='ask-card__title'>Clarifying questions</span>
        <span className='ask-card__hint'>Select options to continue</span>
      </div>
      {questions.length === 0 ? (
        <p className='ask-card__hint'>No valid questions in this request.</p>
      ) : (
        questions.map(q => (
          <QuestionBlock
            key={q.question}
            question={q}
            answers={answers}
            onChange={handleChange}
          />
        ))
      )}
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
