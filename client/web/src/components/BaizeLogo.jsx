import React from 'react'
import '../styles/baize-logo.css'

/**
 * @param {"sm" | "lg"} size  sm = header (28px), lg = welcome (56px)
 */
export default function BaizeLogo({ size = 'lg', className = '' }) {
  const mod = size === 'sm' ? 'baize-logo--sm' : 'baize-logo--lg'
  return (
    <div
      className={['baize-logo', mod, className].filter(Boolean).join(' ')}
      aria-hidden='true'
    >
      B
    </div>
  )
}
