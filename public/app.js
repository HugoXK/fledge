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

  // Below 961px the header is one fixed row and the navigation opens from this
  // toggle (#133's phone band, #233's tablet band). The panel is absolutely
  // positioned, so .top keeps the height the observer above publishes while the
  // menu is open — the sticky offset and the workspace frame must not move when
  // a reader opens the menu.
  const navToggle = document.querySelector('[data-nav-toggle]')
  const navPanel = document.getElementById('main-nav')
  if (header && navToggle && navPanel) {
    const navLinks = () => Array.from(navPanel.querySelectorAll?.('a') ?? [])
    const setNavOpen = (open) => {
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (open) header.setAttribute('data-nav-open', 'true')
      else header.removeAttribute('data-nav-open')
      if (document.body?.style) document.body.style.overflow = open ? 'hidden' : ''
      if (open) {
        const first = navLinks()[0]
        if (first !== undefined) first.focus?.()
      }
    }
    navToggle.addEventListener('click', () => {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true')
    })
    navPanel.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a') !== null) setNavOpen(false)
    })
    document.addEventListener('keydown', (event) => {
      if (navToggle.getAttribute('aria-expanded') !== 'true') return
      if (event.key === 'Escape') {
        setNavOpen(false)
        navToggle.focus()
        return
      }
      if (event.key !== 'Tab') return
      const links = navLinks()
      if (links.length === 0) return
      const first = links[0]
      const last = links[links.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault?.()
        last.focus?.()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault?.()
        first.focus?.()
      }
    })
    if (typeof window.matchMedia === 'function') {
      // Guarded like the ResizeObserver above: an engine can have matchMedia and
      // only the legacy addListener (Safari <= 13.1), and an unguarded throw here
      // would abort every widget wired after this line.
      // The band must be the one public/app.css collapses in (#233 widened it
      // from the phone's 640px to the tablet's 960px): leaving it hands the
      // navigation back to the wide header, so a panel left open would sit over
      // a header that no longer has a toggle to close it.
      const compact = window.matchMedia('(max-width: 960px)')
      const closeOnWide = () => setNavOpen(false)
      if (typeof compact.addEventListener === 'function') compact.addEventListener('change', closeOnWide)
      else if (typeof compact.addListener === 'function') compact.addListener(closeOnWide)
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

  const confirmDialog = document.getElementById('confirm-dialog')
  const confirmMessage = confirmDialog?.querySelector?.('[data-confirm-message]')
  let pendingForm = null
  const submitConfirmed = (form) => {
    form.dataset.confirmed = '1'
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.submit?.()
  }

  document.addEventListener('submit', (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const message = form.dataset.confirm
    if (!message || form.dataset.confirmed === '1') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!confirmDialog || typeof confirmDialog.showModal !== 'function') {
      if (window.confirm(message)) submitConfirmed(form)
      return
    }
    pendingForm = form
    if (confirmMessage) confirmMessage.textContent = message
    confirmDialog.showModal()
  }, true)
  if (confirmDialog) {
    confirmDialog.addEventListener('close', () => {
      const form = pendingForm
      pendingForm = null
      if (confirmDialog.returnValue === 'confirm' && form !== null) submitConfirmed(form)
    })
  }

  document.querySelectorAll('table.table-priority').forEach((table) => {
    if (table.querySelector('[data-priority="low"]') === null) return
    const scroll = table.closest('.table-scroll')
    if (!scroll) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'table-more btn btn-ghost btn-small'
    button.setAttribute('aria-expanded', 'false')
    const label = () => {
      const showing = table.getAttribute('data-show-low') === 'true'
      if (current === 'en') return showing ? 'Fewer columns' : 'Show all columns'
      return showing ? '收起全部列' : '显示全部列'
    }
    button.textContent = label()
    table.setAttribute('data-table-ready', 'true')
    button.addEventListener('click', () => {
      const show = table.getAttribute('data-show-low') !== 'true'
      table.setAttribute('data-show-low', show ? 'true' : 'false')
      button.setAttribute('aria-expanded', show ? 'true' : 'false')
      button.textContent = label()
    })
    scroll.before(button)
  })

  const infoTips = Array.from(document.querySelectorAll('.info-tip'))
  const closeInfoTips = (except) => {
    for (const tip of infoTips) {
      if (tip !== except) tip.setAttribute('aria-expanded', 'false')
    }
  }
  for (const tip of infoTips) {
    tip.addEventListener('click', (event) => {
      event.preventDefault()
      const open = tip.getAttribute('aria-expanded') !== 'true'
      closeInfoTips(tip)
      tip.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
  }
  document.addEventListener('click', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.info-tip') !== null) return
    closeInfoTips()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInfoTips()
  })
  // The stylesheet's hover/focus reveal is the no-JavaScript fallback: without
  // it the hint's text is unreachable. Only once these handlers exist may the
  // explicit `aria-expanded` state take over, so a second tap and Escape really
  // close the hint instead of leaving the CSS reveal in charge (WCAG 1.4.13 d).
  // Set here, not at the top of the file, so a throw in an earlier block leaves
  // the fallback in place rather than making every tip unopenable.
  root.dataset.js = '1'

  document.querySelectorAll('[data-goal-template]').forEach((select) => {
    select.addEventListener('change', () => {
      const target = document.getElementById(select.getAttribute('data-goal-target') || '')
      const option = select.selectedOptions[0]
      if (target && option) target.value = option.getAttribute('data-text') || ''
    })
  })

  const sectionNav = document.querySelector('.section-nav')
  if (sectionNav) {
    // The rule that decides the marker lives in section-nav.js, which the page
    // loads before this script; it publishes itself as window.SectionNav so the
    // dependency is named in both files rather than implied by load order.
    const sectionNavRule = window.SectionNav
    const links = Array.from(sectionNav.querySelectorAll('a'))
    const sections = links
      .map((link) => {
        const id = (link.getAttribute('href') || '').replace(/^#/, '')
        return { link, target: id === '' ? null : document.getElementById(id) }
      })
      .filter((entry) => entry.target !== null)
    const setActive = (id) => {
      for (const entry of sections) entry.link.setAttribute('aria-current', entry.target.id === id ? 'true' : 'false')
    }
    if (sections.length > 0 && sectionNavRule !== undefined) {
      // One rule for the scroll position and for the tap, so the marker cannot
      // disagree with the chip the user just pressed. The band is the bottom of
      // the sticky bar, which is where scroll-margin-top parks an anchored
      // section, so the tapped chip keeps the marker; the last section stays
      // current at the document end even though it never crosses that line.
      // During the smooth scroll the marker follows the viewport through the
      // sections in between, which is this rule working, not a second state.
      const pick = () => {
        // scroll-margin-top is what parks a tapped section and the only place
        // the bar's height is written; read it back so the band cannot disagree
        // with the jump. Every nav target shares the rule.
        const anchorOffset = parseFloat(getComputedStyle(sections[0].target).scrollMarginTop) || 0
        const id = sectionNavRule.currentSection({
          tops: sections.map((entry) => ({ id: entry.target.id, top: entry.target.getBoundingClientRect().top })),
          bandTop: sectionNavRule.scrollBandTop(window.innerHeight, anchorOffset),
          scrollY: window.scrollY,
          scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          viewportHeight: window.innerHeight,
        })
        if (id !== null) setActive(id)
      }
      for (const entry of sections) entry.link.addEventListener('click', () => setActive(entry.target.id))
      window.addEventListener('scroll', pick, { passive: true })
      pick()
    }
  }

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
