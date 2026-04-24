const WebSocket = require('ws')
const ws = new WebSocket('ws://100.112.186.30:4242/mesh/ws')
let step = 0
ws.on('open', () => console.log('[ok] open'))
ws.on('message', (msg) => {
  console.log('[recv]', msg.toString())
  step++
  if (step === 1) {
    // server sent hello → send hello-ack (this WILL be masked by ws client)
    const ack = {type:'hello-ack', protocol:1, client:{name:'ubuntu-probe', os:'linux'}}
    console.log('[send]', JSON.stringify(ack))
    ws.send(JSON.stringify(ack))
    // Then request tabs list to trigger more traffic
    setTimeout(() => {
      console.log('[send] tabs:list')
      ws.send(JSON.stringify({type:'tabs:list'}))
    }, 500)
    setTimeout(() => ws.close(), 2000)
  }
})
ws.on('close', (code, reason) => console.log('[close]', code, reason.toString()))
ws.on('error', (err) => console.log('[error]', err.message))
