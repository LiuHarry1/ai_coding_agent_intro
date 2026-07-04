import React, { useState } from 'react'

export default function CopyButton({ text, label, inline }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = e => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      className={`copy-btn ${inline ? 'copy-btn--inline' : ''}`}
      onClick={handleCopy}
      title={label || 'Copy to clipboard'}
      aria-label={label || 'Copy to clipboard'}
    >
      {copied ? '\u2713' : '\u2398'}
    </button>
  )
}
