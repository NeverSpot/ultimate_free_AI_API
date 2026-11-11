import type { CanonicalChunk } from '../core/types';
import type { ProviderError } from '../core/errors';
import { toEnvelope } from './errors';

export const SSE_DONE = 'data: [DONE]\n\n';

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Format a canonical chunk into an SSE data line.
 */
export function formatSseChunk(chunk: CanonicalChunk, requestId: string, model: string): string {
  const payload = {
    id: requestId,
    object: 'chat.completion.chunk',
    created: chunk.created,
    model,
    choices: [
      {
        index: 0,
        delta: chunk.delta,
        finish_reason: chunk.finish_reason,
      },
    ],
    ...(chunk.usage !== undefined ? { usage: chunk.usage } : {}),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Format an error into an SSE event line.
 */
export function formatSseError(err: ProviderError | unknown): string {
  const envelope = toEnvelope(err);
  return `event: error\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Write a string to a writable stream honoring backpressure.
 * Pauses if the writable buffer is full and waits for the 'drain' event.
 * Returns false if the stream was aborted or closed.
 */
export function writeWithBackpressure(
  writable: NodeJS.WritableStream,
  data: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted || (writable as { destroyed?: boolean }).destroyed) {
    return Promise.resolve(false);
  }

  const canContinue = writable.write(data);
  if (canContinue) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      writable.off('drain', onDrain);
      writable.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };

    writable.once('drain', onDrain);
    writable.once('close', onClose);
    signal?.addEventListener('abort', onAbort);
  });
}

/**
 * Parse an incoming SSE stream across potentially split TCP frames.
 * Accumulates incoming chunks until `\n\n` or `\r\n\r\n` boundary.
 */
export async function* parseSseStream(
  stream: AsyncIterable<string | Uint8Array>,
): AsyncIterable<SseEvent> {
  let buffer = '';

  for await (const raw of stream) {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    buffer += text;

    while (true) {
      const lfLf = buffer.indexOf('\n\n');
      const crlfCrlf = buffer.indexOf('\r\n\r\n');

      let boundaryIndex = -1;
      let delimiterLength = 2;

      if (lfLf !== -1 && crlfCrlf !== -1) {
        if (lfLf < crlfCrlf) {
          boundaryIndex = lfLf;
          delimiterLength = 2;
        } else {
          boundaryIndex = crlfCrlf;
          delimiterLength = 4;
        }
      } else if (lfLf !== -1) {
        boundaryIndex = lfLf;
        delimiterLength = 2;
      } else if (crlfCrlf !== -1) {
        boundaryIndex = crlfCrlf;
        delimiterLength = 4;
      }

      if (boundaryIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + delimiterLength);

      const parsed = parseRawSseEvent(rawEvent);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  }

  if (buffer.trim().length > 0) {
    const parsed = parseRawSseEvent(buffer);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

function parseRawSseEvent(block: string): SseEvent | undefined {
  const lines = block.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trimStart();
    }
  }

  if (dataLines.length === 0 && event === undefined) {
    return undefined;
  }

  return {
    event,
    id,
    data: dataLines.join('\n'),
  };
}
