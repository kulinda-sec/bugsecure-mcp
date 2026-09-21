import { readFileSync } from 'node:fs';

import * as z from 'zod';

const PackageJson = z.object({ name: z.string(), version: z.string() });

// src/version.ts and dist/version.js both sit one level below the package root.
const pkg = PackageJson.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;

/** Sent as `User-Agent` on every outbound request, so the API can tell MCP traffic apart. */
export const USER_AGENT = `bugsecure-mcp/${VERSION} (+https://github.com/kulinda-sec/bugsecure-mcp)`;
