/**
 * Session-startup block for the Browser Automation primary agent.
 * Isolated vs extension are different products; say which one this process is.
 */
export interface BrowserSessionHandoff {
  url: string
  title?: string
  targetId?: string
}

function handoffLines(handoff?: BrowserSessionHandoff): string {
  if (!handoff?.url) return ''
  const title = handoff.title?.trim() ? `${handoff.title} — ` : ''
  const tab = handoff.targetId ? ` (tab ${handoff.targetId})` : ''
  return `This chat already has a page open: ${title}${handoff.url}${tab}. Reuse it with browser_snapshot or browser_tabs. Do not navigate away unless the task needs a different page.\n\n`
}

export function browserAgentSessionSection(
  mode: 'isolated' | 'extension',
  handoff?: BrowserSessionHandoff,
): string {
  const reuse = handoffLines(handoff)
  if (mode === 'extension') {
    return `Session startup (this process is driving the user's signed-in Chrome):

${reuse}Call \`browser_tabs\` with action \`list\` first. Reuse a tab the user shared or one whose URL matches the task. An empty list is normal — open one with action \`new\` (same profile, cookies apply), then navigate. Do not snapshot leftover unshared tabs or guess an id.

Public sites and localhost are usually faster in \`browser.mode: "isolated"\` (agent-only Chrome). Use extension when the task needs the user's real login session.

Reads (navigate, snapshot, screenshot) briefly activate the agent tab in the background window, then restore the tab the user had open. Clicks and typing do the same — only the tab strip changes, not the focused window, unless Chrome rejects input on a hidden tab.

Pages they asked you to open are their own data on a screen they can already open. Reading it because they asked is the job; do not refuse on privacy grounds before trying.

If captcha, 2FA, or payment appears, \`browser_lock\` action \`unlock\`, let them finish, then \`lock\`.`
  }

  return `Session startup (this process launched an agent-only Chrome, not the user's daily browser):

${reuse}${
    handoff?.url
      ? 'If the task needs a different URL, browser_navigate there.'
      : 'If the user or a skill named a URL, `browser_navigate` there as the first browser call. Do not pick a leftover tab from a previous task.'
  }

A login wall on a site they said they are logged into means this isolated profile has no session. Say so. Do not invent credentials. Their signed-in Chrome is \`browser.mode: "extension"\` plus a restart.

A captcha or bot-check on a public site is often this blank profile looking like a bot — say that rather than retrying.`
}
