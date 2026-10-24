const http = require('node:http');

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' || req.url !== '/v2/sip/call') {
    res.writeHead(501).end(JSON.stringify({ error: 'Outside dispatch fixture contract' }));
    return;
  }
  if (!req.body?.sipCallFrom || !req.body?.sipCallTo || !req.body?.routingRuleId) {
    res.writeHead(400).end(JSON.stringify({ error: 'Missing SIP dispatch fields' }));
    return;
  }
  res.end(JSON.stringify({ message: 'Call initiated successfully', data: { id: 'simulation-call', roomId: 'simulation-room', status: 'initiated' } }));
}).listen(process.env.PORT);
