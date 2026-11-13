/* global fetch */

const baseUrl = process.env.GATEWAY_URL || 'http://localhost:8080/v1';
const cmd = process.argv[2];

if (cmd === 'health') {
  try {
    const url = `${baseUrl.replace(/\/v1\/?$/, '')}/healthz`;
    const res = await fetch(url);
    if (res.status === 200) {
      console.log('healthy');
    } else {
      console.log('unreachable');
    }
  } catch {
    console.log('unreachable');
  }
  process.exit(0);
}

if (cmd === 'keys') {
  let createGatewayClient;
  try {
    ({ createGatewayClient } = await import('../sdk/client.js'));
  } catch (err) {
    console.error('error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const apiKey = process.env.GATEWAY_KEY || '';
  const client = createGatewayClient(baseUrl, apiKey);

  if (process.argv[3] === 'list') {
    try {
      const keys = await client.chat.completions.create({ model: 'test', messages: [] });
      console.log(JSON.stringify(keys));
    } catch (e) {
      console.log(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (process.argv[3] === 'add') {
    console.error('error: keys add is not implemented');
    process.exit(1);
  }

  if (process.argv[3] === 'delete') {
    console.error('error: keys delete is not implemented');
    process.exit(1);
  }

  console.log('unknown command');
  process.exit(1);
}

console.log('unknown command');
process.exit(1);
