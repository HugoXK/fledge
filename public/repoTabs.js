// #234: /repos/:id is one long page of sixteen cards. The six sections are
// regrouped on the client so a reader without a script still gets the whole
// page, and every deep link opens the section that holds it: the six section
// anchors plus the inner anchors that predate the tabs (#inbox, #chief, #role,
// #board, #repo-settings, #connection, #jobs).
(() => {
  const page = document.querySelector('.repo-page')
  const nav = document.getElementById('repo-tabs')
  if (page === null || nav === null) return
  const links = Array.from(nav.querySelectorAll('a[href^="#"]'))
  const sections = Array.from(page.querySelectorAll('.repo-section'))
  if (sections.length === 0) return

  // Every id inside a section belongs to that section, so an old link such as
  // #board opens Work instead of landing on a hidden card.
  const owner = new Map()
  for (const section of sections) {
    owner.set(section.id, section.id)
    for (const node of section.querySelectorAll('[id]')) owner.set(node.id, section.id)
  }

  const activate = (requested) => {
    const id = owner.get(requested) ?? 'overview'
    for (const section of sections) section.classList.toggle('is-active', section.id === id)
    for (const link of links) {
      if (link.getAttribute('href') === '#' + id) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    page.classList.add('is-tabbed')
  }

  const requested = () => {
    try {
      return decodeURIComponent(window.location.hash.slice(1))
    } catch {
      return window.location.hash.slice(1)
    }
  }

  activate(requested())
  window.addEventListener('hashchange', () => {
    const id = requested()
    activate(id)
    const target = document.getElementById(id)
    if (target !== null) target.scrollIntoView({ block: 'start' })
  })
})()
