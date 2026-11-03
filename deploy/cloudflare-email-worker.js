export default {
  async email(message, env) {
    const text = typeof message.text === 'function'
      ? await message.text()
      : await new Response(message.raw).text()
    const response = await fetch('https://fledge.hugoxk.online/api/inbound/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fledge-email-secret': env.FLEDGE_EMAIL_SECRET,
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.headers.get('subject') || '',
        text,
      }),
    })
    if (!response.ok) {
      message.setReject('Fledge could not accept this reply')
    }
  },
}
