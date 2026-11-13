import type { ChatRequest, ChatResponse } from './types';

export function createGatewayClient(baseUrl: string, apiKey: string) {
  return {
    chat: {
      completions: {
        create: async (req: ChatRequest): Promise<ChatResponse> => {
          const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(req),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as ChatResponse;
        },
      },
    },
  };
}
