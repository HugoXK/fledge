(() => {
  const root = document.getElementById('team-live')
  if (!root) return
  const api = root.dataset.teamApi
  const events = root.dataset.teamEvents
  const answerUrl = root.dataset.teamAnswer
  const stopUrl = root.dataset.teamStopUrl
  const csrf = root.dataset.teamCsrf || ''
  const zh = (root.dataset.teamLocale || 'zh') !== 'en'
  const t = (a, b) => (zh ? a : b)
  const questionsRoot = document.getElementById('team-questions')
  const control = document.querySelector('[data-team-control]')
  const stopButton = document.querySelector('[data-team-stop]')

  const activityLabel = (value) => {
    if (value === 'thinking') return t('思考中', 'Thinking')
    if (value === 'working') return t('工作中', 'Working')
    if (value === 'idle') return t('空闲', 'Idle')
    if (value === 'unknown') return t('未知', 'Unknown')
    return value
  }

  const note = (text, bad = false) => {
    if (!control) return
    control.textContent = text
    control.className = bad ? 'fine bad' : 'fine'
  }

  const labels = {
    writtenBy: t('编写', 'Written'),
    claimedBy: t('领取', 'Claimed'),
    implementedBy: t('实现', 'Implemented'),
    testedBy: t('测试', 'Tested'),
    reviewedBy: t('审核', 'Reviewed'),
  }

  const attribution = (value) => {
    if (!value || typeof value !== 'object') return ''
    const byRole = new Map()
    for (const [key, label] of Object.entries(labels)) {
      const role = value[key]
      if (typeof role !== 'string' || role.trim() === '' || role === 'not run' || role === 'pending') continue
      if (key === 'writtenBy' && value.implementedBy === role) continue
      const steps = byRole.get(role) || []
      steps.push(label)
      byRole.set(role, steps)
    }
    return [...byRole.entries()].map(([role, steps]) => `${role} ${steps.join(' + ')}`).join(' · ')
  }

  const applyBots = (bots) => {
    for (const bot of bots || []) {
      const row = root.querySelector(`[data-role="${bot.role}"]`)
      if (!row) continue
      row.classList.toggle('is-thinking', !bot.disabled && (bot.activity === 'thinking' || bot.activity === 'working'))
      row.classList.toggle('is-disabled', bot.disabled === true)
      const activity = row.querySelector('.team-activity')
      if (activity) activity.textContent = bot.disabled ? t('未启用', 'Disabled') : activityLabel(bot.activity)
      const calls = row.querySelector('.team-calls')
      if (calls) calls.textContent = !bot.disabled && bot.calls > 0 ? `${bot.calls} ${t('次调用', 'calls')}` : ''
    }
  }

  const answer = async (form, question) => {
    const selected = [...form.querySelectorAll('input[type="checkbox"]:checked, input[type="radio"]:checked')].map((item) => item.value)
    const customInput = form.querySelector('input[name="custom"]')
    const custom = customInput ? customInput.value.trim() : ''
    if (selected.length === 0 && custom === '') {
      note(t('请选择或填写一个答案。', 'Choose or type an answer first.'), true)
      return
    }
    const button = form.querySelector('button[type="submit"]')
    if (button) button.disabled = true
    try {
      const response = await fetch(answerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ sessionId: question.sessionId, questionId: question.id, selected, custom }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      note(t('答案已发送。', 'Answer sent.'))
      form.closest('[data-question]')?.remove()
      if (questionsRoot && questionsRoot.querySelectorAll('[data-question]').length === 0) {
        questionsRoot.textContent = t('没有待回答的问题。', 'No open questions.')
      }
    } catch (error) {
      note(String(error.message || error), true)
      if (button) button.disabled = false
    }
  }

  const renderQuestions = (questions) => {
    if (!questionsRoot) return
    questionsRoot.replaceChildren()
    if (!questions || questions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted'
      empty.textContent = t('没有待回答的问题。', 'No open questions.')
      questionsRoot.append(empty)
      return
    }
    for (const question of questions) {
      const card = document.createElement('div')
      card.className = 'question-card'
      card.dataset.question = question.id || ''
      const title = document.createElement('strong')
      title.textContent = question.question || t('团队提问', 'Team question')
      card.append(title)
      if (question.detail) {
        const detail = document.createElement('p')
        detail.className = 'fine'
        detail.textContent = question.detail
        card.append(detail)
      }
      const form = document.createElement('form')
      form.className = 'form'
      const group = document.createElement('div')
      group.className = 'row'
      for (const option of question.options || []) {
        const label = document.createElement('label')
        label.className = 'check'
        const input = document.createElement('input')
        input.type = question.multiSelect ? 'checkbox' : 'radio'
        input.name = 'option'
        input.value = option
        label.append(input, ` ${option}`)
        group.append(label)
      }
      if ((question.options || []).length > 0) form.append(group)
      const custom = document.createElement('input')
      custom.name = 'custom'
      custom.placeholder = t('其他答案（可选）', 'Other answer (optional)')
      custom.autocomplete = 'off'
      form.append(custom)
      const submit = document.createElement('button')
      submit.className = 'btn'
      submit.type = 'submit'
      submit.textContent = t('回答', 'Answer')
      form.append(submit)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        void answer(form, question)
      })
      card.append(form)
      questionsRoot.append(card)
    }
  }

  const applyJobs = (jobs) => {
    for (const job of jobs || []) {
      const row = document.querySelector(`[data-job-id="${job.id}"]`)
      if (!row) continue
      const cell = row.querySelector('[data-job-summary-text]')
      if (cell && job.summary) cell.textContent = String(job.summary).slice(0, 120)
      const attr = row.querySelector('[data-job-attribution]')
      if (attr) {
        const text = attribution(job.attribution)
        if (text) attr.textContent = text
      }
    }
  }

  const applySnapshot = (data) => {
    applyBots(data.bots)
    renderQuestions(data.questions)
    applyJobs(data.jobs)
    const updated = root.querySelector('[data-team-updated]')
    if (updated) updated.textContent = new Date().toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  let polling = null
  const startPolling = () => {
    if (polling !== null || !api) return
    const tick = async () => {
      try {
        const response = await fetch(api, { headers: { accept: 'application/json' } })
        if (response.ok) applySnapshot(await response.json())
      } catch {
        // Keep the last state; the next poll retries.
      }
    }
    void tick()
    polling = setInterval(tick, 5_000)
  }

  if (events && typeof EventSource !== 'undefined') {
    const source = new EventSource(events)
    source.addEventListener('snapshot', (event) => {
      try {
        applySnapshot(JSON.parse(event.data))
      } catch {
        // Ignore a malformed frame; the next snapshot is complete.
      }
    })
    source.addEventListener('error', () => {
      source.close()
      note(t('实时连接已断开，已切换为 5 秒轮询。', 'Live connection lost; falling back to 5-second polling.'), true)
      startPolling()
    })
    window.addEventListener('beforeunload', () => source.close())
  } else {
    startPolling()
  }

  if (stopButton && stopUrl) {
    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true
      try {
        const response = await fetch(stopUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ target: '' }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
        const hard = (data.stopped || []).length
        const soft = (data.requested || []).length
        note(hard > 0
          ? t(`已停止 ${hard} 个角色；${soft} 个角色收到暂停请求。`, `Stopped ${hard} role(s); requested a stop for ${soft}.`)
          : soft > 0
            ? t(`已发送暂停请求给 ${soft} 个角色，将在下一个安全点生效。`, `Requested a stop for ${soft} role(s); it takes effect at the next safe point.`)
            : t('当前没有正在工作的角色。', 'No role is working right now.'))
      } catch (error) {
        note(String(error.message || error), true)
      } finally {
        stopButton.disabled = false
      }
    })
  }
})()
