(() => {
  let lastStatus = null
  const tick = async () => {
    try {
      const response = await fetch('/api/application', { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const data = await response.json()
      if (lastStatus !== null && data.status !== lastStatus) {
        location.reload()
        return
      }
      lastStatus = data.status
      document.querySelectorAll('[data-queue-position]').forEach((el) => {
        if (typeof data.position === 'number') {
          el.textContent = `#${data.position}`
        }
      })
    } catch {
      // The next poll retries; the page still shows the server-rendered state.
    }
  }
  tick()
  setInterval(tick, 10000)
})()
