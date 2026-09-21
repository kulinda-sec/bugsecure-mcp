import { execFile } from 'node:child_process';

/**
 * Open `url` in the user's default browser. Only http(s) URLs are accepted and
 * the URL is passed as a single argv entry (no shell), so it cannot inject
 * commands. Resolves `false` instead of throwing: the caller always prints the
 * URL too, so a headless machine can copy it.
 */
export const openBrowser = (url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve(false);

  const [command, args]: [string, string[]] =
    platform === 'darwin'
      ? ['open', [parsed.href]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', parsed.href]]
        : ['xdg-open', [parsed.href]];

  return new Promise((resolve) => {
    try {
      const child = execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => {
        resolve(error === null);
      });
      child.unref();
    } catch {
      resolve(false);
    }
  });
};
