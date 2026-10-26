const http = require('node:http');
const crypto = require('node:crypto');

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const failure = req.url.match(/^\/fail-(400|500|no-id)(\/v2\/sip\/call)$/);
  const path = failure ? failure[2] : req.url;
  if (req.method !== 'POST' || path !== '/v2/sip/call') {
    res.writeHead(501).end(JSON.stringify({ error: 'Outside dispatch fixture contract' }));
    return;
  }
  if (!req.body?.sipCallFrom || !req.body?.sipCallTo || !req.body?.routingRuleId) {
    res.writeHead(400).end(JSON.stringify({ error: 'Missing SIP dispatch fields' }));
    return;
  }
  if (failure && failure[1] !== 'no-id') {
    res.writeHead(Number(failure[1])).end(JSON.stringify({ error: 'Simulation dispatch error' }));
    return;
  }
  res.end(JSON.stringify({
    message: 'Call initiated successfully',
    data: { ...(failure ? {} : { id: crypto.randomUUID() }), roomId: 'simulation-room', status: 'initiated' },
  }));
}).listen(process.env.PORT);
