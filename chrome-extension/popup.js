/** Pairing + tab-sharing UI. All state lives in the service worker. */

const $ = id => document.getElementById(id)

function send(message) {
  return chrome.runtime.sendMessage(message)
}

async function render() {
  const state = await send({ type: 'get-state' })
  if (!state) return

  $('status').textContent = state.status
  $('detail').textContent = state.statusDetail || ''
  $('dot').className = `dot ${state.status}`
  $('port').value = state.port

  // Once paired, the token field is only clutter unless it was rejected.
  $('pairing').style.display =
    state.hasToken && state.status !== 'rejected' && state.status !== 'unpaired'
      ? 'none'
      : 'block'

  const connected = state.status === 'connected'
  $('control').style.display = connected ? 'block' : 'none'
  $('take-control').disabled = !connected || state.userHasControl
  $('resume-agent').disabled = !connected || !state.userHasControl
  $('control-label').textContent = state.userHasControl
    ? 'You have control. The agent will not click or type.'
    : 'The agent is driving the page.'

  const list = $('tabs')
  list.innerHTML = ''
  if (!state.tabs.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'None. The agent opens its own tabs when it needs one.'
    list.appendChild(li)
    return
  }
  for (const tab of state.tabs) {
    const li = document.createElement('li')
    const title = document.createElement('span')
    title.className = 'tab-title'
    title.textContent = tab.title || tab.url
    title.title = tab.url
    const stop = document.createElement('button')
    stop.textContent = 'Stop'
    stop.addEventListener('click', async () => {
      await send({ type: 'unshare', targetId: tab.targetId })
      render()
    })
    li.append(title, stop)
    list.appendChild(li)
  }
}

$('pair').addEventListener('click', async () => {
  const token = $('token').value.trim()
  if (!token) return
  // The service worker watches storage and reconnects on its own.
  await chrome.storage.local.set({
    token,
    port: Number($('port').value) || 8766,
  })
  $('token').value = ''
  setTimeout(render, 400)
})

$('share').addEventListener('click', async () => {
  await send({ type: 'share-active-tab' })
  render()
})

$('take-control').addEventListener('click', async () => {
  await send({ type: 'set-user-control', hasControl: true })
  render()
})

$('resume-agent').addEventListener('click', async () => {
  await send({ type: 'set-user-control', hasControl: false })
  render()
})

render()
setInterval(render, 2000)
