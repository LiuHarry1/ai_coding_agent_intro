import React, { useState } from 'react'

function TodoListIcon() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 14 14'
      fill='none'
      aria-hidden='true'
    >
      <circle cx='2' cy='3' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='3'
        x2='13'
        y2='3'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
      <circle cx='2' cy='7' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='7'
        x2='13'
        y2='7'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
      <circle cx='2' cy='11' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='11'
        x2='13'
        y2='11'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
    </svg>
  )
}

function TodoStatusIcon({ status }) {
  if (status === 'completed') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <path
          d='M4.25 7L6.25 9L9.75 5'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    )
  }
  if (status === 'cancelled') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <path
          d='M5 5L9 9M9 5L5 9'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinecap='round'
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <circle cx='7' cy='7' r='2.5' fill='currentColor' />
      </svg>
    )
  }
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 14 14'
      fill='none'
      aria-hidden='true'
    >
      <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
    </svg>
  )
}

export default function TodoListCard({ part }) {
  const { todos = [] } = part
  if (todos.length === 0) return null

  const total = todos.length
  const [manualToggle, setManualToggle] = useState(null)
  const open = manualToggle !== null ? manualToggle : true

  return (
    <div className='todo-card'>
      <button
        className='todo-header'
        onClick={() => setManualToggle(v => (v === null ? !open : !v))}
        aria-expanded={open}
      >
        <TodoListIcon />
        <span className='todo-title'>
          To-dos <span className='todo-count'>{total}</span>
        </span>
        <svg
          className={`todo-arrow ${open ? 'open' : ''}`}
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>
      {open && (
        <ul className='todo-list'>
          {todos.map(t => (
            <li key={t.id} className={`todo-item todo-${t.status}`}>
              <span className={`todo-icon todo-icon-${t.status}`}>
                <TodoStatusIcon status={t.status} />
              </span>
              <span className='todo-content'>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
