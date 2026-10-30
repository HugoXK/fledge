// Small progressive enhancement only; every action works without JavaScript.
document.querySelectorAll('[data-copy]').forEach((el) => {
  el.addEventListener('click', async () => {
    const target = document.querySelector(el.getAttribute('data-copy'))
    if (!target) return
    try {
      await navigator.clipboard.writeText(target.textContent || '')
      el.textContent = '已复制'
      setTimeout(() => { el.textContent = '复制' }, 1500)
    } catch {
      el.textContent = '复制失败'
    }
  })
})
