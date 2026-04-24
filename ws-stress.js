const WebSocket = require('ws')
const ws = new WebSocket('ws://100.112.186.30:4242/mesh/ws')
let acked = false
ws.on('message', (msg) => {
  const m = JSON.parse(msg.toString())
  if (m.type === 'hello' && !acked) {
    acked = true
    ws.send(JSON.stringify({type:'hello-ack', protocol:1, client:{name:'stress', os:'linux'}}))
    // Fire 50 tabs:list in rapid succession to exercise masking many times
    let sent = 0
    const t = setInterval(() => {
      if (sent >= 50 || ws.readyState !== 1) { clearInterval(t); return }
      ws.send(JSON.stringify({type:'tabs:list', reqId: sent++}))
    }, 5)
  }
  if (m.type === 'tabs:list') process.stdout.write('.')
})
ws.on('close', (code) => console.log('\n[close]', code))
ws.on('error', (err) => console.log('[error]', err.message))
setTimeout(() => { ws.close(); process.exit(0) }, 3000)
