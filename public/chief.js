(() => {
  const root = document.getElementById('chief')
  if (!root) return
  const thread = document.getElementById('chief-thread')
  const api = root.dataset.chiefApi || ''
  const events = root.dataset.chiefEvents || ''
  const zh = (document.documentElement.dataset.locale || 'zh') !== 'en'
  const t = (a, b) => (zh ? a : b)

  const render = (messages) => {
    if (!thread) return
    thread.replaceChildren()
    if (!Array.isArray(messages) || messages.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted'
      empty.textContent = t('还没有对话。给 Chief 发第一句。', 'No conversation yet. Send the Chief the first message.')
      thread.append(empty)
      return
    }
    for (const message of messages) {
      const card = document.createElement('div')
      card.className = `chief-msg ${message.role}`
      const role = document.createElement('div')
      role.className = 'chief-role'
      const stamp = Number(message.at) > 0 ? new Date(Number(message.at)).toLocaleString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : ''
      role.textContent = `${message.role === 'user' ? t('你', 'You') : 'Chief'}${stamp === '' ? '' : ` · ${stamp}`}`
      const text = document.createElement('div')
      text.className = 'chief-text'
      text.textContent = String(message.text || '')
      card.append(role, text)
      thread.append(card)
    }
    thread.scrollTop = thread.scrollHeight
  }

  const apply = (data) => {
    if (data && Array.isArray(data.messages)) render(data.messages)
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
})()
