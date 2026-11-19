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
      // #1012: the text alone is not evidence of the node's role. A repository or
      // a saved workspace can be called FlyBot, and its link is content the user
      // named: a mark is hidden because of where it sits (a brand or logo
      // container) or because it is plain text, while a control keeps its label.
      const inMark = element.closest('[class*="brand" i], [class*="logo" i]') !== null
      if (!inMark && element.closest('a, button, [role="button"]') !== null) continue
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
