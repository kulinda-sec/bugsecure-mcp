import { describe, expect, it } from 'vitest';

import { openBrowser } from './browser.js';

describe('openBrowser', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'ms-settings:'])(
    'refuses to open %s',
    async (url) => {
      expect(await openBrowser(url)).toBe(false);
    },
  );
});
