(() => {
  const repo = document.body?.dataset?.fledgeRepo || ''
  const title = repo ? `Fledge · ${repo}` : 'Fledge'
  const setTitle = () => { if (document.title !== title) document.title = title }
  setTitle()
  new MutationObserver(setTitle).observe(document.querySelector('title') || document.documentElement, { childList: true, subtree: true })

  const hideBrand = () => {
    const exact = new Set(['DeepSeek Harness', 'DeepSeek', 'FlyBot', 'FlyBot Social'])
    for (const element of document.querySelectorAll('header *, aside *, nav *, [class*="brand" i], [class*="logo" i]')) {
      if (element.children.length !== 0) continue
      const text = (element.textContent || '').trim()
      if (!exact.has(text)) continue
      const box = element.getBoundingClientRect()
      if (box.top < 140 || box.left < 320) element.style.visibility = 'hidden'
    }
  }
  hideBrand()
  new MutationObserver(hideBrand).observe(document.body, { childList: true, subtree: true })

  const badge = document.createElement('div')
  badge.id = 'fledge-workspace-badge'
  badge.innerHTML = '<strong>Fledge</strong> · powered by FlyBot'
  document.body.append(badge)
})()
