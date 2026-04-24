const WebSocket = require('ws')
const TESTS = [
  { name: 'version_mismatch (protocol=99)', ack: {type:'hello-ack', protocol:99, client:{name:'t'}} },
  { name: 'bad json after ack', after: '{invalid json}' },
  { name: 'subscribe non-existent tab', ack: {type:'hello-ack', protocol:1, client:{name:'t'}}, after: JSON.stringify({type:'tab:subscribe', tabId:'bogus'}) },
  { name: 'resize on non-existent tab', ack: {type:'hello-ack', protocol:1, client:{name:'t'}}, after: JSON.stringify({type:'resize', tabId:'bogus', cols:80, rows:24}) },
  { name: 'unknown message type', ack: {type:'hello-ack', protocol:1, client:{name:'t'}}, after: JSON.stringify({type:'nonsense-command', data:'hi'}) },
  { name: 'oversized message (300KB)', ack: {type:'hello-ack', protocol:1, client:{name:'t'}}, after: JSON.stringify({type:'input', tabId:'x', data:'A'.repeat(300*1024)}) },
  { name: 'rapid 200 msg burst', ack: {type:'hello-ack', protocol:1, client:{name:'t'}}, burst: 200 },
]

async function run(t) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://100.112.186.30:4242/mesh/ws')
    const log = []
    let closed = false
    const timer = setTimeout(() => { ws.close(); }, 3000)
    ws.on('open', () => log.push('open'))
    ws.on('message', (m) => {
      log.push(`recv:${m.toString().slice(0,80)}`)
      if (log.filter(l=>l.startsWith('recv:')).length === 1 && t.ack) {
        ws.send(JSON.stringify(t.ack))
        if (t.after) setTimeout(() => ws.send(t.after), 200)
        if (t.burst) {
          for (let i = 0; i < t.burst; i++) ws.send(JSON.stringify({type:'tabs:list',i}))
        }
      }
    })
    ws.on('close', (code, reason) => { closed = true; clearTimeout(timer); log.push(`close:${code} ${reason.toString()||''}`); resolve({name:t.name, log}) })
    ws.on('error', (err) => { log.push(`error:${err.message}`); if (!closed) resolve({name:t.name, log}) })
  })
}

;(async () => {
  for (const t of TESTS) {
    const r = await run(t)
    console.log('===', r.name)
    r.log.forEach(l => console.log('  ', l))
    await new Promise(r=>setTimeout(r,500))
  }
  console.log('\n=== container alive? ===')
})()
