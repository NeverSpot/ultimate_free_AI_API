import * as fs from 'node:fs';
import * as path from 'node:path';

async function main(): Promise<void> {
  const port = Number(process.env.MOCK_PORT || process.env.PORT || 9000);
  const pidFile = path.resolve(__dirname, '.mock-upstream.pid');

  // Try admin shutdown endpoint first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    await fetch(`http://127.0.0.1:${port}/__admin/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timeout);
  } catch {
    // Ignore error
  }

  // Check PID file as fallback
  try {
    if (fs.existsSync(pidFile)) {
      const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // Process already dead
        }
      }
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Ignore errors
  }

  console.log('Mock upstream stopped.');
  process.exit(0);
}

void main();
