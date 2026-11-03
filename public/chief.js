(() => {
  const root = document.getElementById('chief')
  if (!root) return
  const thread = document.getElementById('chief-thread')
  const form = root.querySelector('[data-chief-form]')
  const input = form ? form.querySelector('textarea[name="text"]') : null
  const status = root.querySelector('[data-chief-status]')
  const api = root.dataset.chiefApi || ''
  const events = root.dataset.chiefEvents || ''
  const messageApi = root.dataset.chiefMessage || ''
  let pendingMessage = null
  const csrf = root.dataset.chiefCsrf || ''
  const zh = (document.documentElement.dataset.locale || 'zh') !== 'en'
  const t = (a, b) => (zh ? a : b)

  const empty = () => {
    const note = document.createElement('p')
    note.className = 'muted chief-empty'
    note.textContent = t('还没有对话。给 Chief 发第一句。', 'No conversation yet. Send the Chief the first message.')
    return note
  }

  const messageNode = (message, pending = false) => {
    const card = document.createElement('div')
    card.className = `chief-msg ${message.role}${pending ? ' is-pending' : ''}`
    const role = document.createElement('div')
    role.className = 'chief-role'
    const stamp = Number(message.at) > 0 ? new Date(Number(message.at)).toLocaleString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
    role.textContent = `${message.role === 'user' ? t('你', 'You') : 'Chief'}${stamp === '' ? '' : ` · ${stamp}`}`
    const text = document.createElement('div')
    text.className = 'chief-text'
    text.textContent = String(message.text || '')
    card.append(role, text)
    return card
  }

  const render = (messages) => {
    if (!thread) return
    thread.replaceChildren()
    if (!Array.isArray(messages) || messages.length === 0) {
      thread.append(empty())
      return
    }
    for (const message of messages) thread.append(messageNode(message))
    thread.scrollTop = thread.scrollHeight
  }

  const append = (message) => {
    if (!thread) return null
    thread.querySelector('.chief-empty')?.remove()
    const node = messageNode(message, true)
    thread.append(node)
    thread.scrollTop = thread.scrollHeight
    return node
  }

  const setStatus = (text, bad = false) => {
    if (!status) return
    status.textContent = text
    status.className = bad ? 'chief-status bad' : 'chief-status'
  }

  const apply = (data) => {
    if (!data || !Array.isArray(data.messages)) return
    const messages = data.messages.slice()
    if (pendingMessage !== null) {
      if (messages.some((message) => message.role === 'user' && message.text === pendingMessage.text)) {
        pendingMessage = null
      } else {
        messages.push(pendingMessage)
      }
    }
    render(messages)
    if (status?.dataset.pending === '1') {
      if (messages.at(-1)?.role === 'chief') {
        delete status.dataset.pending
        setStatus('')
      }
    } else {
      setStatus('')
    }
  }

  let polling = null
  const startPolling = () => {
    if (polling !== null || api === '') return
    const tick = async () => {
      try {
        const response = await fetch(api, { headers: { accept: 'application/json' } })
        if (response.ok) apply(await response.json())
      } catch {
        // The next poll retries; keep the rendered conversation.
      }
    }
    void tick()
    polling = setInterval(tick, 5_000)
  }

  if (events !== '' && typeof EventSource !== 'undefined') {
    const source = new EventSource(events)
    source.addEventListener('snapshot', (event) => {
      try { apply(JSON.parse(event.data)) } catch {}
    })
    source.addEventListener('error', () => {
      source.close()
      startPolling()
    })
    window.addEventListener('beforeunload', () => source.close())
  } else {
    startPolling()
  }

  if (form && input) {
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`
    }
    input.addEventListener('input', resize)
    resize()
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        form.requestSubmit()
      }
    })
    root.querySelectorAll('[data-chief-prompt]').forEach((button) => {
      button.addEventListener('click', () => {
        input.value = button.getAttribute('data-chief-prompt') || ''
        resize()
        input.focus()
      })
    })
    form.addEventListener('submit', async (event) => {
      if (messageApi === '') return
      event.preventDefault()
      const text = input.value.trim()
      if (text === '') return
      const submit = form.querySelector('button[type="submit"]')
      if (submit) submit.disabled = true
      input.disabled = true
      pendingMessage = { role: 'user', text, at: Date.now() }
      const pending = append(pendingMessage)
      input.value = ''
      resize()
      setStatus(t('已发送，等待 Chief 回复…', 'Sent; waiting for the Chief…'))
      if (status) status.dataset.pending = '1'
      try {
        const response = await fetch(messageApi, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ text }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
        input.disabled = false
        if (submit) submit.disabled = false
        input.focus()
      } catch (error) {
        pendingMessage = null
        pending?.remove()
        if (!thread?.querySelector('.chief-msg')) thread?.append(empty())
        input.value = text
        resize()
        input.disabled = false
        if (submit) submit.disabled = false
        if (status) delete status.dataset.pending
        setStatus(error instanceof Error ? error.message : String(error), true)
        input.focus()
      }
    })
  }
})()
