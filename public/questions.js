(() => {
  const zh = (document.documentElement.dataset.locale || 'zh') !== 'en'
  const t = (a, b) => (zh ? a : b)
  const empty = () => {
    const list = document.querySelector('#inbox .inbox-list')
    if (!list) return
    const note = document.createElement('p')
    note.className = 'muted'
    note.textContent = t('没有待回答的问题。', 'No open questions.')
    list.replaceChildren(note)
    const count = document.querySelector('[data-inbox-count]')
    if (count) count.textContent = '0'
  }
  const bind = () => {
    const forms = document.querySelectorAll('form[data-answer-form]')
    for (const form of forms) {
      if (form.dataset.answerBound === '1') continue
      form.dataset.answerBound = '1'
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const error = form.querySelector('[data-question-error]')
        const button = form.querySelector('button[type="submit"]')
        const selected = [...form.querySelectorAll('input[name="selected"]:checked')].map((input) => input.value)
        const customInput = form.querySelector('input[name="custom"]')
        const custom = customInput ? customInput.value.trim() : ''
        const show = (message) => {
          if (!error) return
          error.hidden = false
          error.textContent = message
        }
        if (selected.length === 0 && custom === '') {
          show(t('请选择一个选项，或填写自己的答案。', 'Choose an option or type your own answer.'))
          return
        }
        if (error) {
          error.hidden = true
          error.textContent = ''
        }
        const original = button ? button.textContent : ''
        if (button) {
          button.disabled = true
          button.textContent = t('发送中…', 'Sending…')
        }
        try {
          const response = await fetch(form.action, {
            method: 'POST',
            headers: { accept: 'application/json' },
            body: new FormData(form),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
          const card = form.closest('[data-question]')
          card?.remove()
          const count = document.querySelector('[data-inbox-count]')
          if (count) count.textContent = String(Math.max(0, Number(count.textContent || '0') - 1))
          if (!document.querySelector('[data-question]')) empty()
        } catch (cause) {
          show(cause instanceof Error ? cause.message : String(cause))
          if (button) {
            button.disabled = false
            button.textContent = original
          }
        }
      })
    }
  }
  bind()
  const inbox = document.querySelector('#inbox')
  if (inbox === null || typeof EventSource === 'undefined') return
  const source = new EventSource('/api/inbox/events')
  source.addEventListener('inbox', (event) => {
    try {
      const data = JSON.parse(event.data)
      if (typeof data.html !== 'string') return
      const current = document.querySelector('#inbox')
      if (current === null) return
      const template = document.createElement('template')
      template.innerHTML = data.html.trim()
      const next = template.content.firstElementChild
      if (next === null) return
      current.replaceWith(next)
      bind()
    } catch {}
  })
})()
