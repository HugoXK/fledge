(() => {
  const root = document.documentElement
  const current = root.dataset.locale === 'en' ? 'en' : 'zh'
  const syncKey = 'hugoxk-lang-sync'

  try {
    const saved = localStorage.getItem('hugoxk-lang')
    if ((saved === 'en' || saved === 'zh') && saved !== current) {
      if (sessionStorage.getItem(syncKey) !== '1') {
        sessionStorage.setItem(syncKey, '1')
        location.replace(`/lang/${saved}?next=${encodeURIComponent(location.pathname + location.search)}`)
        return
      }
    } else {
      sessionStorage.removeItem(syncKey)
    }
  } catch {
    // Storage can be unavailable in private modes; the server-rendered locale still works.
  }


  document.querySelectorAll('[data-auto-group]').forEach((group) => {
    const toggle = group.querySelector('input[name="auto"]')
    const select = group.querySelector('select[name="interval"]')
    if (!toggle || !select) return
    const sync = () => { select.disabled = !toggle.checked }
    toggle.addEventListener('change', sync)
    sync()
  })

  document.querySelectorAll('[data-review-group]').forEach((group) => {
    const toggle = group.querySelector('input[name="review"]')
    const select = group.querySelector('select[name="reviewInterval"]')
    if (!toggle || !select) return
    const sync = () => { select.disabled = !toggle.checked || toggle.disabled }
    toggle.addEventListener('change', sync)
    sync()
  })

  document.querySelectorAll('[data-lang-btn]').forEach((el) => {
    el.addEventListener('click', () => {
      const next = el.getAttribute('data-lang-btn')
      if (next !== 'zh' && next !== 'en') return
      try {
        localStorage.setItem('hugoxk-lang', next)
        sessionStorage.removeItem(syncKey)
      } catch {
        // The link still changes the server-rendered locale through the cookie.
      }
    })
  })

  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', async () => {
      const target = document.querySelector(el.getAttribute('data-copy'))
      if (!target) return
      try {
        await navigator.clipboard.writeText(target.textContent || '')
        el.textContent = current === 'en' ? 'Copied' : '已复制'
        setTimeout(() => { el.textContent = current === 'en' ? 'Copy' : '复制' }, 1500)
      } catch {
        el.textContent = current === 'en' ? 'Copy failed' : '复制失败'
      }
    })
  })
})()
