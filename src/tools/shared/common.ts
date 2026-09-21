/**
 * Small schema building blocks shared by every tool: identifiers, wrapped
 * third-party text, timestamps, strictly shaped codes and offset pagination.
 *
 * Output rule (enforced by src/tools/registry.test.ts): every string a tool
 * returns is EITHER third-party text fenced by `untrusted()` (`wrapped()`), OR
 * constrained to one of the NAMED shapes below (`id()`, `slug()`, `code()`),
 * an enum, or a date-time — so nothing free-form reaches the model unfenced.
 *
 * Output shapes are checked at runtime but not published as JSON Schema
 * `pattern`s: every pattern would be repeated for every field in tools/list,
 * which every conversation pays for, and a client gains nothing from them.
 */
import * as z from 'zod';

import { hasControlCharacters, isUntrustedBlock } from '../../untrusted.js';

/** A taxonomy node: a dotted snake_case path, e.g. `cross_site_scripting_xss.stored.non_privileged_user_to_anyone`. */
const NODE = String.raw`[a-z0-9_]{1,100}(?:\.[a-z0-9_]{1,100}){0,9}`;
/** A CVSS 3.1 or 4.0 vector: `CVSS:<version>` then `/METRIC:value` pairs. */
const CVSS = String.raw`CVSS:(?:3\.1|4\.0)(?:\/[A-Za-z]{1,4}:[A-Za-z]{1,8}){1,40}`;

/**
 * Every strict shape an output string may have, by name. The registry test
 * accepts only these (plus fenced text, dates and enums), so adding a shape is
 * a reviewed edit here, never an ad-hoc regex in a tool.
 */
export const PATTERNS = {
  /** BugSecure ids (UUIDs today). Deliberately permissive in shape, strict in charset. */
  id: /^[A-Za-z0-9_-]{1,64}$/,
  /** URL slugs as BugSecure generates them. Anything else is not returned (see `safeSlug`). */
  slug: /^[a-z0-9-]{1,100}$/,
  'taxonomy-node-id': new RegExp(`^${NODE}$`),
  'taxonomy-version': /^[A-Za-z0-9._@:+-]{1,100}$/,
  'cvss-version': /^(?:3\.1|4\.0)$/,
  'cvss-vector': new RegExp(`^${CVSS}$`),
  'cwe-id': /^CWE-\d{1,6}$/,
  /**
   * The adjudication's "decision vector", as the API formats it:
   * `BSC/1/VRT:<version>/N:<node>/B:<P1-5|VARIES>/S:<severity>/C<cvss version>:<vector>/SC:<score>/A:<amount>/AB:<basis>/<ISO instant>`.
   */
  'decision-vector': new RegExp(
    String.raw`^BSC\/1\/VRT:[A-Za-z0-9._+-]{1,64}\/N:${NODE}\/B:(?:P[1-5]|VARIES)\/S:(?:CRITICAL|HIGH|MEDIUM|LOW|INFORMATIVE)` +
      String.raw`\/C(?:3\.1|4\.0):${CVSS}\/SC:\d{1,2}\.\d\/A:\d{1,15}\/AB:[A-Z_]{1,32}` +
      String.raw`\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$`,
  ),
  /** An upper-case machine code returned inside JSON (a status or severity name). */
  'machine-code': /^[A-Z][A-Z0-9_]{0,31}$/,
  /** ISO 4217. */
  currency: /^[A-Z]{3}$/,
  /** Printed, human-facing payout certificate reference, e.g. "BSC-2026-0001". */
  'certificate-reference': /^BSC-\d{4}-\d{4,8}$/,
  /** type/subtype per RFC 6838 §4.2 (parameters are not returned). */
  'mime-type': /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/,
  /** A calendar month, YYYY-MM. */
  month: /^\d{4}-(?:0[1-9]|1[0-2])$/,
  /** A JWS key id. */
  'key-id': /^[A-Za-z0-9_-]{1,128}$/,
  /** RFC 7515 Appendix F detached JWS: `<protected header>..<signature>`. */
  'detached-jws': /^[A-Za-z0-9_-]{1,2048}\.\.[A-Za-z0-9_-]{1,2048}$/,
  /** Opaque base64url bytes, bounded (see verify_certificate). */
  base64url: /^[A-Za-z0-9_-]{0,200000}$/,
} as const;

export type PatternName = keyof typeof PATTERNS;

/** For input schemas and callers that need the raw expressions. */
export const ID_PATTERN = PATTERNS.id;
export const SLUG_PATTERN = PATTERNS.slug;

/**
 * How each output string is constrained, for the registry test: `untrusted` =
 * fenced third-party text, `date-time` = RFC 3339 timestamp, or a PATTERNS name.
 */
export const outputStringPolicy = z.registry<{ policy: 'untrusted' | 'date-time' | PatternName }>();

/**
 * An id argument: validated before any API call, documented for the model. The
 * shape is checked, not published as a `pattern` (ids come from other tools'
 * output; the regex would only repeat itself across tools/list).
 */
export const idInput = (description: string): z.ZodString =>
  z
    .string()
    .refine((v) => ID_PATTERN.test(v), 'not a BugSecure id')
    .describe(description);

/** An output string of the named shape (checked at runtime, see the file comment). */
export const code = (name: PatternName, description?: string): z.ZodString => {
  const pattern = PATTERNS[name];
  const schema = z.string().refine((v) => pattern.test(v), `not a ${name}`);
  const described = description === undefined ? schema : schema.describe(description);
  outputStringPolicy.add(described, { policy: name });
  return described;
};

/** An id in tool output. */
export const id = (description?: string): z.ZodString => code('id', description);

/** A slug in tool output; `null` when BugSecure returned one that is not a plain slug. */
export const slug = (description?: string): z.ZodNullable<z.ZodString> =>
  code('slug', description).nullable();

/** Map an API slug to the output: dropped (null) unless it is a plain slug. */
export const safeSlug = (value: string | null | undefined): string | null => {
  return typeof value === 'string' && SLUG_PATTERN.test(value) ? value : null;
};

/** `value` when it has the named shape, else null (for API values a tool can do without). */
export const ifShaped = (name: PatternName, value: string | null | undefined): string | null => {
  return typeof value === 'string' && PATTERNS[name].test(value) ? value : null;
};

/**
 * Output field for third-party text that went through `untrusted()` (checked
 * at runtime). The fence is explained once, in the server instructions and the
 * tool's output description; field descriptions only say what the text is,
 * and only when the field name does not.
 */
export const wrapped = (description?: string): z.ZodString => {
  const schema = z.string().refine(isUntrustedBlock, 'not fenced with untrusted()');
  const described = description === undefined ? schema : schema.describe(description);
  outputStringPolicy.add(described, { policy: 'untrusted' });
  return described;
};

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * An RFC 3339 timestamp. Validated at runtime with zod's ISO check, but
 * published as `format: date-time` only: zod's equivalent `pattern` would add
 * ~300 bytes to `tools/list` for every timestamp field.
 */
export const timestamp = (): z.ZodString => {
  const schema = z
    .string()
    .refine((v) => isoDateTime.safeParse(v).success, 'not an ISO 8601 date-time')
    .meta({ format: 'date-time' });
  outputStringPolicy.add(schema, { policy: 'date-time' });
  return schema;
};

/**
 * Free text a user writes (reports, comments, appeals, grades): trimmed,
 * Windows line endings normalised, bounded, and refused when it carries a
 * control character (other than tab and line feed) or a Unicode line
 * separator — such characters have no business in a report, and can hide or
 * rearrange what the user is shown for approval.
 */
export const userText = (min: number, max: number, description: string): z.ZodString =>
  z
    .string()
    .overwrite((v) => v.replace(/\r\n?/g, '\n'))
    .trim()
    .min(min)
    .max(max)
    .refine(
      (v) => !hasControlCharacters(v),
      'must not contain control characters (other than tab and new line)',
    )
    .describe(description);

/**
 * Offset pagination, identical across tools: `limit` + `offset` in,
 * `nextOffset` out (null on the last page).
 */
export const paginationInput = (
  maxLimit: number,
  defaultLimit = 20,
): { limit: z.ZodDefault<z.ZodNumber>; offset: z.ZodDefault<z.ZodNumber> } => ({
  limit: z
    .number()
    .int()
    .min(1)
    .max(maxLimit)
    .default(defaultLimit)
    .describe(`Results per page (1–${String(maxLimit)}).`),
  offset: z.number().int().min(0).max(10_000).default(0).describe('Results to skip.'),
});

export const paginationOutput = {
  offset: z.number().int(),
  limit: z.number().int(),
  nextOffset: z.number().int().nullable().describe('Next page’s `offset`; null on the last page.'),
};

/** The pagination fields of a page of `count` results fetched with `limit`/`offset`. */
export const page = (
  count: number,
  input: { limit: number; offset: number },
): { offset: number; limit: number; nextOffset: number | null } => {
  return {
    offset: input.offset,
    limit: input.limit,
    nextOffset: count >= input.limit ? input.offset + input.limit : null,
  };
};

/** One page of an in-memory list (for API fields that return everything at once). */
export const pageOf = <T>(
  items: readonly T[],
  input: { limit: number; offset: number },
): { items: T[]; offset: number; limit: number; nextOffset: number | null } => {
  const end = input.offset + input.limit;
  return {
    items: items.slice(input.offset, end),
    offset: input.offset,
    limit: input.limit,
    nextOffset: end < items.length ? end : null,
  };
};
