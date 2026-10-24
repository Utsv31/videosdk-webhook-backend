const http = require('node:http');

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const id = req.url.split('?')[0].split('/').pop();
  if (req.method !== 'GET' || !req.url.startsWith('/api/v1/businesses/policy-test/leads/')) {
    res.writeHead(501).end(JSON.stringify({ error: 'Outside retry policy fixture contract' }));
    return;
  }
  res.end(JSON.stringify({
    success: true,
    data: { leadId: id, assignedTo: 'owner@example.com', tags: id.endsWith('3') ? ['Identity confirmed'] : [] },
  }));
}).listen(process.env.PORT);
