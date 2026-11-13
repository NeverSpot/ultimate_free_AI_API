/* global fetch */
import { createGatewayClient } from '../sdk/dist/client.js';

const baseUrl = process.env.GATEWAY_URL || 'http://localhost:8080/v1';
const apiKey = process.env.GATEWAY_KEY || '';
const cmd = process.argv[2];

async function main() {
  if (cmd === 'health') {
    try {
      const res = await fetch(`${baseUrl.replace(/\/v1$/, '')}/healthz`);
      console.log(res.status === 200 ? 'healthy' : 'unhealthy');
      process.exit(res.status === 200 ? 0 : 1);
    } catch {
      console.log('unreachable');
      process.exit(1);
    }
  }

  const client = createGatewayClient(baseUrl, apiKey);

  if (cmd === 'keys' && process.argv[3] === 'list') {
    try {
      const keys = await client.chat.completions.create({ model: 'test', messages: [] });
      console.log(JSON.stringify(keys));
    } catch (e) {
      console.log(`error: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'keys' && process.argv[3] === 'add') {
    console.error('error: keys add is not implemented');
    process.exit(1);
  }

  if (cmd === 'keys' && process.argv[3] === 'delete') {
    console.error('error: keys delete is not implemented');
    process.exit(1);
  }

  console.log('unknown command');
  process.exit(1);
}

main();
