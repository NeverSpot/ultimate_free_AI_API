import { ImageResponse } from 'next/og';

export const alt = 'Ultimate Free AI Endpoint — your free keys, pooled into one endpoint';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#02090b',
        padding: '72px',
        color: '#e6e6e6',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '28px' }}>
        <div style={{ width: '20px', height: '20px', background: '#b87333' }} />
        <span style={{ color: '#9aa6aa' }}>Ultimate Free AI Endpoint</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            fontSize: '76px',
            lineHeight: 1.04,
            letterSpacing: '-0.03em',
            maxWidth: '980px',
          }}
        >
          <span>Your free keys, pooled into&nbsp;</span>
          <span style={{ color: '#b87333' }}>one endpoint.</span>
        </div>
        <div style={{ fontSize: '30px', color: '#9aa6aa' }}>
          OpenAI-compatible · self-hosted · capacity-aware failover
        </div>
      </div>
    </div>,
    { ...size },
  );
}
