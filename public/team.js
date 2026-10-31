(() => {
  const root = document.getElementById('team-live')
  if (!root) return
  const api = root.dataset.teamApi
  if (!api) return
  const zh = (root.dataset.teamLocale || 'zh') !== 'en'
  const t = (a, b) => (zh ? a : b)
  const activityLabel = (value) => {
    if (value === 'thinking') return t('思考中', 'Thinking')
    if (value === 'working') return t('工作中', 'Working')
    if (value === 'idle') return t('空闲', 'Idle')
    if (value === 'unknown') return t('未知', 'Unknown')
    return value
  }
  const tick = async () => {
    try {
      const response = await fetch(api, { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const data = await response.json()
      for (const bot of data.bots || []) {
        const row = root.querySelector(`[data-role="${bot.role}"]`)
        if (!row) continue
        row.classList.toggle('is-thinking', !bot.disabled && (bot.activity === 'thinking' || bot.activity === 'working'))
        row.classList.toggle('is-disabled', bot.disabled === true)
        const activity = row.querySelector('.team-activity')
        if (activity) activity.textContent = bot.disabled ? t('未启用', 'Disabled') : activityLabel(bot.activity)
        const calls = row.querySelector('.team-calls')
        if (calls) calls.textContent = !bot.disabled && bot.calls > 0 ? `${bot.calls} ${t('次调用', 'calls')}` : ''
      }
      for (const row of document.querySelectorAll('[data-job-id]')) {
        const job = (data.jobs || []).find((entry) => entry.id === row.dataset.jobId)
        if (!job || !job.summary) continue
        const cell = row.querySelector('[data-job-summary-text]')
        if (cell) cell.textContent = String(job.summary).slice(0, 120)
      }
      const updated = root.querySelector('[data-team-updated]')
      if (updated) updated.textContent = new Date().toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      // Keep the last state; the next poll retries.
    }
  }
  tick()
  setInterval(tick, 5000)
})()
