import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import ModePicker from './ModePicker.jsx'
import SchedulePicker from './SchedulePicker.jsx'
import { agentApi } from '../lib/api/agent.js'
import { workspaceApi } from '../lib/api/workspace.js'
import {
  extractCompletionToken,
  extractSearchToken,
  formatAtMentionReplacement,
  applyFileSuggestion,
  toWorkspaceRelative,
  insertTextAtCursor,
} from '../lib/at-mention.js'
import {
  MAX_IMAGES,
  ACCEPTED_TYPES,
  fileToAttachment,
  revokeAttachment,
  revokeAttachments,
  extractDroppedFiles,
  extractImages,
  isImageFile,
} from '../lib/composer-attachments.js'
import {
  INITIAL_VISIBLE,
  getSlashFilter,
  groupEntries,
  rowFromSectionRow,
  clearSlashToken,
  SlashMenuIcon,
} from '../lib/slash-menu.jsx'

const MODE_PLACEHOLDERS = {
  agent: 'Describe your task… @file',
  ask: 'Ask about your codebase…',
  plan: 'Plan your implementation…',
}

export default function InputArea() {
  const sendMessage = useChatStore(s => s.sendMessage)
  const isStreaming = useChatStore(s => s.isStreaming)
  const isAwaitingInteraction = useChatStore(s => s.isAwaitingInteraction)
  const stopStreaming = useChatStore(s => s.stopStreaming)
  const workspace = useChatStore(s => s.workspace)
  const agentMode = useChatStore(s => s.agentMode)
  const cycleAgentMode = useChatStore(s => s.cycleAgentMode)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const slashMenuRef = useRef(null)
  const atMenuRef = useRef(null)
  const slashActiveRef = useRef(null)
  const [images, setImages] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [inputValue, setInputValue] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [slashEntries, setSlashEntries] = useState([])
  const [slashIndex, setSlashIndex] = useState(0)
  const [expandedSections, setExpandedSections] = useState(new Set())
  const [atSuggestions, setAtSuggestions] = useState([])
  const [atIndex, setAtIndex] = useState(0)
  const [uploadingDrop, setUploadingDrop] = useState(false)
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false)
  const [atMenuSuppressed, setAtMenuSuppressed] = useState(false)
  const imagesRef = useRef(images)
  imagesRef.current = images

  useEffect(() => {
    return () => revokeAttachments(imagesRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await agentApi.getSlashCommands(workspace || undefined)
        if (!cancelled && Array.isArray(data.entries)) {
          setSlashEntries(data.entries)
        }
      } catch {
        if (!cancelled) setSlashEntries([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace])

  const syncCursor = useCallback(() => {
    const el = textareaRef.current
    if (el) setCursorPos(el.selectionStart ?? 0)
  }, [])

  const slashFilter = useMemo(() => getSlashFilter(inputValue), [inputValue])

  const slashMatches = useMemo(() => {
    if (slashFilter === null) return []
    return slashEntries.filter(e =>
      e.name.toLowerCase().startsWith(slashFilter),
    )
  }, [slashEntries, slashFilter])

  const showSlashMenu =
    !slashMenuSuppressed &&
    slashFilter !== null &&
    slashEntries.length > 0 &&
    slashMatches.length > 0

  const atToken = useMemo(() => {
    if (showSlashMenu) return null
    return extractCompletionToken(inputValue, cursorPos, true)
  }, [inputValue, cursorPos, showSlashMenu])

  const showAtMenu =
    !atMenuSuppressed &&
    atToken?.token.startsWith('@') &&
    atSuggestions.length > 0 &&
    !showSlashMenu

  const slashGroups = useMemo(() => groupEntries(slashMatches), [slashMatches])

  const { slashMenuSections, slashMenuRows } = useMemo(() => {
    let flatIdx = 0
    const sections = slashGroups.map(group => {
      const expanded = expandedSections.has(group.label)
      const shown = expanded
        ? group.items
        : group.items.slice(0, INITIAL_VISIBLE)
      const hiddenCount = group.items.length - shown.length
      const rows = []

      for (const entry of shown) {
        rows.push({ kind: 'item', flatIdx: flatIdx++, entry })
      }
      if (hiddenCount > 0) {
        rows.push({ kind: 'more', flatIdx: flatIdx++, count: hiddenCount })
      } else if (expanded && group.items.length > INITIAL_VISIBLE) {
        rows.push({ kind: 'less', flatIdx: flatIdx++ })
      }

      return { label: group.label, icon: group.icon, rows }
    })

    const rows = sections.flatMap(section =>
      section.rows.map(row => rowFromSectionRow(section, row)),
    )
    return { slashMenuSections: sections, slashMenuRows: rows }
  }, [slashGroups, expandedSections])

  const toggleSlashSection = useCallback((groupLabel, expand) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (expand) next.add(groupLabel)
      else next.delete(groupLabel)
      return next
    })
  }, [])

  useEffect(() => {
    setSlashMenuSuppressed(false)
    if (slashFilter === null) {
      setSlashIndex(0)
      setExpandedSections(new Set())
      return
    }
    setSlashIndex(0)
  }, [slashFilter])

  useEffect(() => {
    setAtMenuSuppressed(false)
  }, [atToken?.token])

  useEffect(() => {
    setSlashIndex(i => Math.min(i, Math.max(0, slashMenuRows.length - 1)))
  }, [slashMenuRows.length])

  useEffect(() => {
    slashActiveRef.current?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashMenuRows])

  useEffect(() => {
    setAtIndex(0)
  }, [atToken?.token, atSuggestions.length])

  // Clear stale suggestions when workspace changes.
  useEffect(() => {
    setAtSuggestions([])
  }, [workspace])

  // Debounced @ file search
  useEffect(() => {
    if (!atToken?.token.startsWith('@') || showSlashMenu || !workspace) {
      setAtSuggestions([])
      return undefined
    }
    const searchToken = extractSearchToken(atToken)
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const data = await workspaceApi.searchFiles(searchToken, workspace)
        if (!cancelled && Array.isArray(data.entries)) {
          setAtSuggestions(data.entries)
        }
      } catch {
        if (!cancelled) setAtSuggestions([])
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [atToken, showSlashMenu, workspace])

  useEffect(() => {
    if (!showSlashMenu && !showAtMenu) return undefined

    const onDocMouseDown = e => {
      const target = e.target
      if (slashMenuRef.current?.contains(target)) return
      if (atMenuRef.current?.contains(target)) return
      if (textareaRef.current?.contains(target)) return
      if (showSlashMenu) setSlashMenuSuppressed(true)
      if (showAtMenu) setAtMenuSuppressed(true)
    }

    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [showSlashMenu, showAtMenu])

  const addImageFiles = useCallback(files => {
    const accepted = files.filter(isImageFile)
    setImages(prev => {
      const remaining = MAX_IMAGES - prev.length
      const next = accepted.slice(0, remaining).map(fileToAttachment)
      return [...prev, ...next].slice(0, MAX_IMAGES)
    })
  }, [])

  const removeImage = useCallback(idx => {
    setImages(prev => {
      const doomed = prev[idx]
      if (doomed) revokeAttachment(doomed)
      return prev.filter((_, i) => i !== idx)
    })
  }, [])

  const handleInput = useCallback(e => {
    setInputValue(e.target.value)
    setCursorPos(e.target.selectionStart ?? 0)
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'
  }, [])

  const applySlashSelection = useCallback(
    entry => {
      const el = textareaRef.current
      if (!el) return
      const hint = entry.argumentHint ? ` ${entry.argumentHint}` : ' '
      const next = `/${entry.name}${hint}`
      el.value = next
      setInputValue(next)
      el.focus()
      const pos = `/${entry.name} `.length
      el.setSelectionRange(pos, pos)
      setCursorPos(pos)
      handleInput({ target: el })
    },
    [handleInput],
  )

  const activateSlashRow = useCallback(
    row => {
      if (row.kind === 'item') {
        applySlashSelection(row.entry)
      } else if (row.kind === 'more') {
        toggleSlashSection(row.groupLabel, true)
      } else if (row.kind === 'less') {
        toggleSlashSection(row.groupLabel, false)
      }
    },
    [applySlashSelection, toggleSlashSection],
  )

  const dismissSlashMenu = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const next = clearSlashToken(el.value)
    el.value = next
    setInputValue(next)
    el.focus()
    setCursorPos(el.selectionStart ?? 0)
    handleInput({ target: el })
  }, [handleInput])

  const applyAtSelection = useCallback(
    entry => {
      const el = textareaRef.current
      if (!el || !atToken) return
      const hasAtPrefix = atToken.token.startsWith('@')
      const needsQuotes = entry.path.includes(' ')
      const replacementValue = formatAtMentionReplacement(entry.path, {
        hasAtPrefix,
        needsQuotes,
        isQuoted: atToken.isQuoted,
        isDir: entry.isDir,
      })
      const { newInput, newCursorPos } = applyFileSuggestion(
        replacementValue,
        inputValue,
        atToken.token,
        atToken.startPos,
      )
      el.value = newInput
      setInputValue(newInput)
      el.setSelectionRange(newCursorPos, newCursorPos)
      setCursorPos(newCursorPos)
      el.focus()
      if (!entry.isDir) setAtSuggestions([])
      handleInput({ target: el })
    },
    [atToken, inputValue, handleInput],
  )

  const insertAtMentions = useCallback(
    relativePaths => {
      const el = textareaRef.current
      if (!el || relativePaths.length === 0) return
      const mentions = relativePaths
        .filter(Boolean)
        .map(p => (p.includes(' ') ? `@"${p}" ` : `@${p} `))
        .join('')
      insertTextAtCursor(el, mentions, setInputValue)
      setCursorPos(el.selectionStart ?? 0)
      handleInput({ target: el })
    },
    [handleInput],
  )

  const handleSend = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const text = el.value.trim()
    if ((!text && images.length === 0) || isStreaming) return
    el.value = ''
    setInputValue('')
    setCursorPos(0)
    el.style.height = 'auto'
    const attachments = images
    setImages([])
    setAtSuggestions([])
    sendMessage(text || '(image)', attachments)
  }, [sendMessage, isStreaming, images])

  const handleKeyDown = useCallback(
    e => {
      if (showSlashMenu && slashMenuRows.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSlashIndex(i => (i + 1) % slashMenuRows.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSlashIndex(
            i => (i - 1 + slashMenuRows.length) % slashMenuRows.length,
          )
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          activateSlashRow(slashMenuRows[slashIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissSlashMenu()
          return
        }
      }

      if (showAtMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setAtIndex(i => (i + 1) % atSuggestions.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setAtIndex(i => (i - 1 + atSuggestions.length) % atSuggestions.length)
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          applyAtSelection(atSuggestions[atIndex])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setAtMenuSuppressed(true)
          return
        }
      }

      if (e.key === 'Tab' && e.shiftKey && !showSlashMenu && !showAtMenu) {
        e.preventDefault()
        cycleAgentMode()
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      showSlashMenu,
      slashMenuRows,
      slashIndex,
      activateSlashRow,
      dismissSlashMenu,
      showAtMenu,
      atSuggestions,
      atIndex,
      applyAtSelection,
      handleSend,
      cycleAgentMode,
    ],
  )

  const handlePaste = useCallback(
    e => {
      const files = extractImages(e.clipboardData)
      if (files.length > 0) {
        e.preventDefault()
        addImageFiles(files)
      }
    },
    [addImageFiles],
  )

  const handleDragOver = useCallback(e => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(e => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback(
    async e => {
      e.preventDefault()
      setDragOver(false)
      const allFiles = extractDroppedFiles(e.dataTransfer)
      const imageFiles = allFiles.filter(isImageFile)
      const otherFiles = allFiles.filter(f => !isImageFile(f))

      if (imageFiles.length > 0) addImageFiles(imageFiles)

      if (otherFiles.length === 0) return
      if (!workspace) return

      setUploadingDrop(true)
      try {
        const result = await workspaceApi.uploadFiles(workspace, otherFiles)
        const paths = (result.uploaded ?? []).map(u =>
          toWorkspaceRelative(u.path, workspace),
        )
        insertAtMentions(paths)
      } catch (err) {
        console.error('Drop upload failed:', err)
      } finally {
        setUploadingDrop(false)
      }
    },
    [addImageFiles, workspace, insertAtMentions],
  )

  const handleFileChange = useCallback(
    e => {
      const files = [...e.target.files].filter(f =>
        ACCEPTED_TYPES.includes(f.type),
      )
      if (files.length > 0) addImageFiles(files)
      e.target.value = ''
    },
    [addImageFiles],
  )

  return (
    <div
      className={`input-area ${dragOver ? 'input-area--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showSlashMenu && (
        <div
          className='slash-menu'
          ref={slashMenuRef}
          role='listbox'
          aria-label='Slash commands'
        >
          {slashMenuSections.map(section =>
            section.rows.length === 0 ? null : (
              <div key={section.label} className='slash-menu__group'>
                <div className='slash-menu__section'>{section.label}</div>
                {section.rows.map(row => {
                  const active = row.flatIdx === slashIndex
                  if (row.kind === 'item') {
                    return (
                      <button
                        key={`${row.entry.kind}-${row.entry.name}`}
                        type='button'
                        role='option'
                        aria-selected={active}
                        ref={active ? slashActiveRef : undefined}
                        className={`slash-menu__item${active ? ' slash-menu__item--active' : ''}`}
                        onMouseDown={ev => {
                          ev.preventDefault()
                          applySlashSelection(row.entry)
                        }}
                        onMouseEnter={() => setSlashIndex(row.flatIdx)}
                      >
                        <SlashMenuIcon type={section.icon} />
                        <span className='slash-menu__label'>
                          {row.entry.name}
                        </span>
                      </button>
                    )
                  }
                  if (row.kind === 'more') {
                    return (
                      <button
                        key={`more-${section.label}`}
                        type='button'
                        role='option'
                        aria-selected={active}
                        ref={active ? slashActiveRef : undefined}
                        className={`slash-menu__show-more${active ? ' slash-menu__show-more--active' : ''}`}
                        onMouseDown={ev => {
                          ev.preventDefault()
                          toggleSlashSection(section.label, true)
                        }}
                        onMouseEnter={() => setSlashIndex(row.flatIdx)}
                      >
                        Show {row.count} more
                      </button>
                    )
                  }
                  return (
                    <button
                      key={`less-${section.label}`}
                      type='button'
                      role='option'
                      aria-selected={active}
                      ref={active ? slashActiveRef : undefined}
                      className={`slash-menu__show-more${active ? ' slash-menu__show-more--active' : ''}`}
                      onMouseDown={ev => {
                        ev.preventDefault()
                        toggleSlashSection(section.label, false)
                      }}
                      onMouseEnter={() => setSlashIndex(row.flatIdx)}
                    >
                      Show less
                    </button>
                  )
                })}
              </div>
            ),
          )}
        </div>
      )}
      {showAtMenu && (
        <div
          className='slash-menu at-menu'
          ref={atMenuRef}
          role='listbox'
          aria-label='File suggestions'
        >
          <div className='slash-menu__section'>Files</div>
          {atSuggestions.map((entry, idx) => (
            <button
              key={entry.path}
              type='button'
              role='option'
              aria-selected={idx === atIndex}
              className={`slash-menu__item${idx === atIndex ? ' slash-menu__item--active' : ''}`}
              onMouseDown={ev => {
                ev.preventDefault()
                applyAtSelection(entry)
              }}
            >
              <div className='slash-menu__row-top'>
                <span className='slash-menu__name'>
                  @{entry.path}
                  {entry.isDir ? '/' : ''}
                </span>
                {entry.isDir && <span className='slash-menu__badge'>dir</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      <div
        className={`input-wrapper input-wrapper--${agentMode} ${images.length > 0 ? 'has-images' : ''}`}
      >
        {images.length > 0 && (
          <div className='image-preview-bar'>
            {images.map((att, i) => (
              <div key={att.id} className='image-preview-item'>
                <img
                  src={att.previewUrl}
                  alt={`Attachment ${i + 1}`}
                  onClick={() => setLightbox(att.previewUrl)}
                />
                <button
                  className='image-preview-remove'
                  onClick={() => removeImage(i)}
                  title='Remove'
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
        <div className='input-row'>
          <ModePicker />
          <button
            className='attach-btn'
            onClick={() => fileInputRef.current?.click()}
            title='Attach image'
            type='button'
          >
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <rect x='3' y='3' width='18' height='18' rx='2' ry='2' />
              <circle cx='8.5' cy='8.5' r='1.5' />
              <polyline points='21 15 16 10 5 21' />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type='file'
            accept='image/png,image/jpeg,image/gif,image/webp'
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <SchedulePicker />
          <textarea
            ref={textareaRef}
            className='input-textarea'
            rows='1'
            placeholder={
              MODE_PLACEHOLDERS[agentMode] ?? MODE_PLACEHOLDERS.agent
            }
            title='Enter to send · Shift+Tab switch mode · Shift+Enter newline'
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            onPaste={handlePaste}
            autoFocus
          />
          {isAwaitingInteraction ? (
            <button
              className='composer-btn composer-btn--stop'
              onClick={stopStreaming}
              title='Cancel'
              aria-label='Cancel'
              type='button'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
              >
                <line x1='6' y1='6' x2='18' y2='18' />
                <line x1='18' y1='6' x2='6' y2='18' />
              </svg>
            </button>
          ) : isStreaming ? (
            <button
              className='composer-btn composer-btn--stop'
              onClick={stopStreaming}
              title='Stop'
              aria-label='Stop'
              type='button'
            >
              <svg
                width='14'
                height='14'
                viewBox='0 0 24 24'
                fill='currentColor'
              >
                <rect x='6' y='6' width='12' height='12' rx='2' />
              </svg>
            </button>
          ) : (
            <button
              className='composer-btn composer-btn--send'
              onClick={handleSend}
              title='Send (Enter)'
              type='button'
              disabled={!inputValue.trim() && images.length === 0}
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
                <line x1='12' y1='19' x2='12' y2='5' />
                <polyline points='5 12 12 5 19 12' />
              </svg>
            </button>
          )}
        </div>
      </div>
      {dragOver && (
        <div className='drop-overlay'>
          {uploadingDrop
            ? 'Uploading…'
            : 'Drop files here (images attach, others → @path)'}
        </div>
      )}
      {lightbox && (
        <div className='lightbox' onClick={() => setLightbox(null)}>
          <img src={lightbox} alt='Preview' />
        </div>
      )}
    </div>
  )
}
