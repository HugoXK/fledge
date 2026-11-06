(() => {
  const root = document.documentElement
  const current = root.dataset.locale === 'en' ? 'en' : 'zh'
  const syncKey = 'hugoxk-lang-sync'

  try {
    const saved = localStorage.getItem('hugoxk-lang')
    if ((saved === 'en' || saved === 'zh') && saved !== current) {
      if (sessionStorage.getItem(syncKey) !== '1') {
        sessionStorage.setItem(syncKey, '1')
        location.replace(`/lang/${saved}?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`)
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

  document.querySelectorAll('form').forEach((form) => {
    const role = form.querySelector('select[name="repoRole"]')
    if (!role) return
    const autoMerge = form.querySelector('input[name="autoMerge"]')
    const review = form.querySelector('input[name="review"]')
    const reviewInterval = form.querySelector('select[name="reviewInterval"]')
    const sync = () => {
      const maintainer = role.value === 'maintainer'
      if (autoMerge) {
        autoMerge.disabled = !maintainer
        if (!maintainer) autoMerge.checked = false
      }
      if (review) {
        const allowed = maintainer && review.dataset.roleCanReview === '1'
        review.disabled = !allowed
        if (!allowed) review.checked = false
        if (reviewInterval) reviewInterval.disabled = !allowed || !review.checked
      }
    }
    role.addEventListener('change', sync)
    if (review) review.addEventListener('change', sync)
    sync()
  })

  document.querySelectorAll('[data-lang-btn]').forEach((el) => {
    el.addEventListener('click', (event) => {
      const next = el.getAttribute('data-lang-btn')
      if (next !== 'zh' && next !== 'en') return
      event.preventDefault()
      try {
        localStorage.setItem('hugoxk-lang', next)
        sessionStorage.removeItem(syncKey)
      } catch {
        // The link still changes the server-rendered locale through the cookie.
      }
      location.href = `/lang/${next}?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`
    })
  })

  document.querySelectorAll('[data-reload]').forEach((button) => {
    button.addEventListener('click', () => location.reload())
  })

  const markBusy = (button) => {
    if (!(button instanceof HTMLButtonElement) || button.dataset.busy === '1') return
    button.dataset.busy = '1'
    button.dataset.idleLabel = button.textContent || ''
    button.classList.add('is-busy')
    button.setAttribute('aria-busy', 'true')
    // A disabled submit button would drop its name from the request, so keep it
    // in the form and block the second click through aria-disabled + pointer-events.
    button.setAttribute('aria-disabled', 'true')
    const pending = button.dataset.pendingLabel ?? button.getAttribute('data-pending-label')
    if (pending) button.textContent = pending
  }

  const clearBusy = () => {
    document.querySelectorAll('[data-busy="1"]').forEach((button) => {
      button.dataset.busy = '0'
      button.classList.remove('is-busy')
      button.removeAttribute('aria-busy')
      button.removeAttribute('aria-disabled')
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel
    })
  }
  window.addEventListener('pageshow', clearBusy)

  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const message = form.dataset.confirm
    if (message && !window.confirm(message)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    markBusy(event.submitter)
  }, true)

  document.querySelectorAll('[data-goal-template]').forEach((select) => {
    select.addEventListener('change', () => {
      const target = document.getElementById(select.getAttribute('data-goal-target') || '')
      const option = select.selectedOptions[0]
      if (target && option) target.value = option.getAttribute('data-text') || ''
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
