const WebSocket = require('ws')
const ws = new WebSocket('ws://100.112.186.30:4242/mesh/ws')
ws.on('message', (m) => {
  const msg = JSON.parse(m.toString())
  console.log(JSON.stringify(msg))
  if (msg.type === 'hello') {
    ws.send(JSON.stringify({type:'hello-ack', protocol:1, client:{name:'probe'}}))
    setTimeout(() => ws.send(JSON.stringify({type:'tabs:list'})), 300)
    setTimeout(() => ws.close(), 1500)
  }
})
ws.on('error', (e) => console.log('error', e.message))
ws.on('close', () => process.exit(0))
