/**
 * How tool schemas are published in `tools/list`.
 *
 * tools/list is sent to the model in every conversation, so its size is paid
 * for again and again. Zod's JSON Schema is correct but verbose; `publish()`
 * wraps a zod schema so the SDK validates with zod exactly as before, while
 * the JSON Schema it advertises is trimmed of what carries no information:
 *
 * - `$schema` (MCP tool schemas default to JSON Schema 2020-12 without it);
 * - the ±2^53 bounds zod puts on every integer (`minimum/maximum` of
 *   ±9007199254740991), which say nothing a client can use;
 * - `anyOf: [X, {type: "null"}]` for a nullable X with a single type, written
 *   as `type: [X.type, "null"]` instead (with `null` added to an enum);
 * - in OUTPUT schemas only, `additionalProperties: false` and `required`:
 *   outputs are what this server returns, always with every listed field
 *   (null when empty) and nothing else — the root description says so once —
 *   so the keywords would only repeat every property name a second time.
 *
 * No `$ref`/`$defs` are introduced: several MCP clients do not resolve them.
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type * as z from 'zod';

type Json = Record<string, unknown>;
type Direction = 'input' | 'output';

const SAFE_INTEGER_BOUND = Number.MAX_SAFE_INTEGER;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{anyOf: [X, {type: 'null'}]}` → X with `null` allowed, when X is a single plain type. */
const collapseNullable = (node: Json): Json => {
  const anyOf = node.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return node;
  const [first, second] = anyOf as unknown[];
  const nullIndex = isObject(second) && second.type === 'null' && Object.keys(second).length === 1 ? 1 : -1;
  const other = nullIndex === 1 ? first : undefined;
  if (!isObject(other) || typeof other.type !== 'string') return node;
  if ('anyOf' in other || 'oneOf' in other || 'allOf' in other || 'const' in other) return node;
  const { anyOf: _dropped, ...rest } = node;
  const merged: Json = { ...other, ...rest, type: [other.type, 'null'] };
  if (Array.isArray(other.enum)) merged.enum = [...(other.enum as unknown[]), null];
  return merged;
};

const slim = (value: unknown, direction: Direction): unknown => {
  if (Array.isArray(value)) return value.map((v) => slim(v, direction));
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (
      (key === 'minimum' && child === -SAFE_INTEGER_BOUND) ||
      (key === 'maximum' && child === SAFE_INTEGER_BOUND)
    )
      continue;
    if (direction === 'output' && ((key === 'additionalProperties' && child === false) || key === 'required'))
      continue;
    // `properties` maps names to schemas: recurse into each, never treat a name as a keyword.
    out[key] =
      key === 'properties' && isObject(child)
        ? Object.fromEntries(Object.entries(child).map(([name, s]) => [name, slim(s, direction)]))
        : slim(child, direction);
  }
  return collapseNullable(out);
};

/** The JSON Schema published for `schema` in one direction (exported for tests). */
export const publishedJsonSchema = (schema: z.ZodType, direction: Direction): Json => {
  const std = schema['~standard'] as StandardSchemaWithJSON['~standard'];
  return slim(std.jsonSchema[direction]({ target: 'draft-2020-12' }), direction) as Json;
};

/** `schema`, validated by zod as-is, advertised with the trimmed JSON Schema. */
export const publish = <S extends z.ZodType>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> => {
  const std = schema['~standard'] as StandardSchemaWithJSON<z.input<S>, z.output<S>>['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: 'bugsecure-mcp',
      validate: (value, options) => std.validate(value, options),
      jsonSchema: {
        input: (options) => slim(std.jsonSchema.input(options), 'input') as Json,
        output: (options) => slim(std.jsonSchema.output(options), 'output') as Json,
      },
    },
  };
};
