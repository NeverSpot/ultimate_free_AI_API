const NAME = 'jwt';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function attributes(nodeEnv: string): string {
  const secure = nodeEnv === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure}`;
}

/**
 * The single source of truth for the session cookie's name and attributes.
 * `Secure` is added only in production; `nodeEnv` is injected, never read from
 * `process.env` here.
 */
export const sessionCookie = {
  name: NAME,
  serialize: (token: string, nodeEnv: string): string => `${NAME}=${token}; ${attributes(nodeEnv)}`,
  clear: (nodeEnv: string): string =>
    `${NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${
      nodeEnv === 'production' ? '; Secure' : ''
    }`,
};
