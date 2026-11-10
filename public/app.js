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

  // The sticky header is content-driven: the locale, the wrapping and the
  // reader's default font size all change its height, so the offset typed into
  // app.css is only the no-JS fallback. Let the rendered header win, and observe
  // the element itself: a web font swapping in or a longer nav label can change
  // its height with no resize event at all. Browsers without ResizeObserver keep
  // the resize trigger.
  const header = document.querySelector('.top')
  if (header) {
    const syncHeaderOffset = () => {
      root.style.setProperty('--header-h', `${Math.ceil(header.offsetHeight)}px`)
    }
    syncHeaderOffset()
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(syncHeaderOffset).observe(header)
    } else {
      window.addEventListener('resize', syncHeaderOffset)
    }
  }

  // Below 640px the header is one fixed row and the navigation opens from this
  // toggle (#133). The panel is absolutely positioned, so .top keeps the height
  // the observer above publishes while the menu is open — the sticky offset and
  // the workspace frame must not move when a reader opens the menu.
  const navToggle = document.querySelector('[data-nav-toggle]')
  const navPanel = document.getElementById('main-nav')
  if (header && navToggle && navPanel) {
    const setNavOpen = (open) => {
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (open) header.setAttribute('data-nav-open', 'true')
      else header.removeAttribute('data-nav-open')
    }
    navToggle.addEventListener('click', () => {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true')
    })
    navPanel.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) setNavOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || navToggle.getAttribute('aria-expanded') !== 'true') return
      setNavOpen(false)
      navToggle.focus()
    })
    if (typeof window.matchMedia === 'function') {
      window.matchMedia('(max-width: 640px)').addEventListener('change', () => setNavOpen(false))
    }
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

  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const message = form.dataset.confirm
    if (message && !window.confirm(message)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
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
