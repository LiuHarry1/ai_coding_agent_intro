import React, { useEffect } from 'react'
import { MarketplaceCatalog } from './WorkspacePanel.jsx'

function StoreIcon() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.8'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M3 9l1.5-5h15L21 9' />
      <path d='M5 13v7h14v-7' />
      <path d='M9 20v-6h6v6' />
      <path d='M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0' />
    </svg>
  )
}

export default function MarketplacePanel({ open, workspace, onClose }) {
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className='marketplace-modal'
      role='dialog'
      aria-modal='true'
      aria-labelledby='marketplace-title'
      onClick={onClose}
    >
      <section
        className='marketplace-panel'
        onClick={event => event.stopPropagation()}
      >
        <header className='marketplace-panel-head'>
          <div className='marketplace-title-mark'>
            <StoreIcon />
          </div>
          <div>
            <h2 id='marketplace-title'>Marketplace</h2>
            <p>
              Discover trusted skills and specialist agents for this workspace.
            </p>
          </div>
          <button
            type='button'
            className='marketplace-close'
            onClick={onClose}
            aria-label='Close marketplace'
          >
            ×
          </button>
        </header>

        <div className='marketplace-panel-body'>
          <MarketplaceCatalog workspace={workspace} />
        </div>
      </section>
    </div>
  )
}
