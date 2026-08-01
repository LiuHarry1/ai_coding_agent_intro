import React from 'react'
import { useChatStore } from '../stores/chat-store.js'
import BaizeLogo from './BaizeLogo.jsx'
import { APP_NAME, APP_TAGLINE } from '../lib/brand.js'

const TOOL_HINTS = [
  {
    icon: '\u{1F50D}',
    label: 'Explore project',
    prompt:
      "Read the current directory structure, find the main entry points, and give me a brief summary of this project's architecture",
  },
  {
    icon: '\u{1F41B}',
    label: 'Fix a bug',
    prompt:
      "I'm getting an error in my code. Let me describe it — help me find the root cause and fix it",
  },
  {
    icon: '\u{1F4DD}',
    label: 'Improve code',
    prompt:
      'Read the main source files in this project and suggest refactoring improvements for better readability and maintainability',
  },
]

const PROJECT_HINTS = [
  {
    icon: '\u{1F40D}',
    label: 'Snake',
    prompt:
      'Create a Snake game using a single HTML file with embedded CSS and JavaScript. Include: canvas-based rendering, arrow key controls, score display, speed increase per 5 points, game over screen with restart button, and a modern dark-themed UI. Make it immediately playable by opening the HTML file.',
  },
  {
    icon: '\u{1F3AE}',
    label: 'Flappy Bird',
    prompt:
      'Create a Flappy Bird clone using a single HTML file with embedded CSS and JavaScript. Include: canvas rendering, click/space to flap, randomly generated pipes, score counter, gravity physics, collision detection, game over with restart, and pixel-art style visuals. Make it immediately playable.',
  },
  {
    icon: '\u{1F3B2}',
    label: 'Tetris',
    prompt:
      'Create a Tetris game in a single HTML file with embedded CSS and JavaScript. Include: all 7 tetromino shapes with colors, rotation, soft/hard drop, line clearing with animation, score and level system, next piece preview, and keyboard controls (arrows + up to rotate). Modern neon-style dark UI.',
  },
  {
    icon: '\u{1F3D3}',
    label: 'Pong',
    prompt:
      'Create a Pong game using a single HTML file with embedded CSS and JavaScript. Include: canvas-based rendering, two paddles (W/S vs arrow keys), ball physics with angle-based bounces, score tracking to 10, serve after each point, and a retro arcade dark UI. Make it immediately playable by opening the HTML file.',
  },
  {
    icon: '\u{1F522}',
    label: '2048',
    prompt:
      'Create a 2048 puzzle game using a single HTML file with embedded CSS and JavaScript. Include: 4x4 grid, arrow key controls, tile merge animation, score and best score (localStorage), win at 2048 with continue option, and game over detection. Clean modern UI with colored tiles.',
  },
  {
    icon: '\u{1F4AC}',
    label: 'Chatbot',
    prompt:
      "Create a chatbot web app using a single HTML file with embedded CSS and JavaScript. Connect to an OpenAI-compatible API at base URL http://localhost:4141/v1 with apiKey 'dummy' and model 'gpt-4'. Include: chat message history, user input with send button, Enter to send, loading indicator while waiting, markdown rendering for assistant replies, and clear error messages on API failure. Make it immediately usable by opening the HTML file.",
  },
]

export default function WelcomeScreen() {
  const sendMessage = useChatStore(s => s.sendMessage)

  return (
    <div className='welcome'>
      <BaizeLogo size='lg' />
      <h2 className='welcome-title'>{APP_NAME}</h2>
      <p className='welcome-subtitle'>{APP_TAGLINE}</p>
      <p className='welcome-desc'>
        Build in the cloud and preview complete projects in your browser.
      </p>

      <div className='hint-section'>
        <span className='hint-section-label'>Work with your code</span>
        <div className='hint-grid hint-grid--3col'>
          {TOOL_HINTS.map((h, i) => (
            <button
              key={i}
              className='hint-card hint-card--compact'
              onClick={() => sendMessage(h.prompt)}
            >
              <span className='hint-icon'>{h.icon}</span>
              <span className='hint-label'>{h.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className='hint-section'>
        <span className='hint-section-label'>Start from a template</span>
        <div className='hint-grid hint-grid--3col'>
          {PROJECT_HINTS.map((h, i) => (
            <button
              key={i}
              className='hint-card hint-card--compact'
              onClick={() => sendMessage(h.prompt)}
            >
              <span className='hint-icon'>{h.icon}</span>
              <span className='hint-label'>{h.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
