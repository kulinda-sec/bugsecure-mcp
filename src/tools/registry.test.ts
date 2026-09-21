/**
 * Registry-wide guarantees, checked for every registered tool:
 *
 * - every tool is listed whatever the token's scopes, and --read-only leaves
 *   only read tools;
 * - a call without the tool's scopes never reaches the API and names the
 *   re-authorization to perform (granted + missing scopes);
 * - every string a tool can return is either fenced third-party text or
 *   strictly shaped (pattern, enum, date-time) — nothing free-form leaks out
 *   unfenced;
 * - output schemas and annotations are complete, and tools/list stays small.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { SAMPLE_ARGS } from '../../test/helpers/sample-args.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { formatScopes, SCOPES } from '../scopes.js';
import { isWriteTool } from './define-tool.js';
import { ALL_TOOLS } from './index.js';
import { outputStringPolicy, PATTERNS } from './shared/common.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const namesFor = (predicate: (t: (typeof ALL_TOOLS)[number]) => boolean) =>
  ALL_TOOLS.filter(predicate)
    .map((t) => t.name)
    .sort();

describe('tool registry', () => {
  it.each(SCOPES)('lists every tool to a session holding only %s', async (scope) => {
    harness = await connectTools({ graphql: fakeGraphQL({}), grantedScopes: [scope] });
    expect(await harness.listToolNames()).toEqual(namesFor(() => true));
  });

  it('lists only read tools in read-only mode', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}), grantedScopes: [...SCOPES], readOnly: true });
    const listed = await harness.listToolNames();
    expect(listed).toEqual(namesFor((t) => !isWriteTool(t)));
    expect(listed).not.toContain('submit_report');
  });

  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s refuses to run without its scopes, naming granted + missing scopes',
    async (name, tool) => {
      const granted = SCOPES.filter((s) => !tool.requiredScopes.includes(s)).slice(0, 1);
      const graphql = fakeGraphQL({});
      harness = await connectTools({ graphql, grantedScopes: granted });

      const result = await harness.call(name, SAMPLE_ARGS[name] ?? {});

      expect(result.isError).toBe(true);
      expect(graphql.calls).toHaveLength(0);
      expect(harness.prompts).toHaveLength(0); // never asks to approve a call it will refuse
      expect(textOf(result)).toContain(
        `login --scopes "${formatScopes([...granted, ...tool.requiredScopes])}"`,
      );
    },
  );

  it('gives every tool an output schema and complete annotations', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}) });
    for (const tool of (await harness.client.listTools()).tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.title, tool.name).toBeTruthy();
      expect(Object.keys(tool.annotations ?? {}).sort(), tool.name).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
        'title',
      ]);
    }
  });

  it('keeps tools/list compact', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}) });
    const bytes = Buffer.byteLength(JSON.stringify((await harness.client.listTools()).tools), 'utf8');
    // The budget: tools/list goes into the model's context in every conversation (and clients such as
    // Claude Code truncate or defer large tool lists), so the whole list is kept under 80 KB of UTF-8.
    // History: 78,640 characters for 26 tools before the schemas were slimmed (fence rule stated once,
    // no published output patterns, no ±2^53 integer bounds, no `required`/`additionalProperties` in
    // outputs, see json-schema.ts); ~56 KB after; ~77 KB for 33 tools once the API's newer reads and
    // the account write tools were added. Fold new reads into existing tools before adding one.
    expect(bytes).toBeLessThan(80_000);
  });

  it('declares no-argument tools as closed objects', async () => {
    harness = await connectTools({ graphql: fakeGraphQL({}) });
    for (const tool of (await harness.client.listTools()).tools) {
      if (Object.keys(tool.inputSchema.properties ?? {}).length > 0) continue;
      expect(tool.inputSchema, tool.name).toMatchObject({ additionalProperties: false });
    }
  });
});

/** Output string policies the registry accepts: fenced text, dates, and the named shapes only. */
const ALLOWED_POLICIES: ReadonlySet<string> = new Set(['untrusted', 'date-time', ...Object.keys(PATTERNS)]);

/**
 * Walk a zod output schema and collect every string that is not registered
 * with an allowed policy (fenced third-party text, a timestamp, or one of the
 * named PATTERNS). Enums and literals are not strings here. Any schema kind
 * the walker does not know fails the test: a new kind must be reviewed here.
 */
const unconstrainedStrings = (schema: z.core.$ZodType, path: string): string[] => {
  const def = schema._zod.def;
  switch (def.type) {
    case 'object':
      return Object.entries((def as z.core.$ZodObjectDef).shape).flatMap(([k, v]) =>
        unconstrainedStrings(v, `${path}.${k}`),
      );
    case 'array':
      return unconstrainedStrings((def as z.core.$ZodArrayDef).element, `${path}[]`);
    case 'nullable':
    case 'optional':
    case 'default':
      return unconstrainedStrings((def as z.core.$ZodNullableDef).innerType, path);
    case 'record': {
      const record = def as z.core.$ZodRecordDef;
      return [
        ...unconstrainedStrings(record.keyType, `${path}{key}`),
        ...unconstrainedStrings(record.valueType, `${path}{}`),
      ];
    }
    case 'union':
      return (def as z.core.$ZodUnionDef).options.flatMap((o, i) =>
        unconstrainedStrings(o, `${path}|${String(i)}`),
      );
    case 'string': {
      const policy = outputStringPolicy.get(schema)?.policy;
      return policy !== undefined && ALLOWED_POLICIES.has(policy) ? [] : [path];
    }
    case 'number':
    case 'boolean':
    case 'enum':
    case 'literal':
      return [];
    default:
      throw new Error(`${path}: output schema kind "${def.type}" is not reviewed by this walker`);
  }
};

describe('output strings', () => {
  it.each(ALL_TOOLS.map((t) => [t.name, t] as const))(
    '%s returns no free-form string outside an untrusted-content fence',
    (_name, tool) => {
      expect(unconstrainedStrings(tool.output, 'output')).toEqual([]);
    },
  );

  it('the walker flags an unconstrained string, even one with an ad-hoc regex', () => {
    expect(
      unconstrainedStrings(
        z.object({ a: z.array(z.object({ b: z.string(), c: z.string().regex(/^[!-~]+$/) })) }),
        'o',
      ),
    ).toEqual(['o.a[].b', 'o.a[].c']);
  });

  it('the walker refuses a schema kind it does not know', () => {
    expect(() => unconstrainedStrings(z.object({ a: z.date() }), 'o')).toThrow(/not reviewed/);
  });
});
