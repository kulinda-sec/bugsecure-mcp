import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { publish, publishedJsonSchema } from './json-schema.js';

const schema = z.object({
  count: z.number().int(),
  maybe: z.string().nullable(),
  status: z.enum(['A', 'B']).nullable(),
  nested: z.object({ at: z.string().meta({ format: 'date-time' }) }).nullable(),
  either: z.union([z.string(), z.number()]).nullable(),
  limit: z.number().int().min(1).max(50),
});

describe('published JSON Schema', () => {
  it('drops what carries no information, keeping every constraint that does', () => {
    const output = publishedJsonSchema(schema, 'output');
    expect(output).not.toHaveProperty('$schema');
    expect(output).not.toHaveProperty('required');
    expect(output).not.toHaveProperty('additionalProperties');
    expect(output.properties).toEqual({
      count: { type: 'integer' },
      maybe: { type: ['string', 'null'] },
      status: { type: ['string', 'null'], enum: ['A', 'B', null] },
      nested: { type: ['object', 'null'], properties: { at: { type: 'string', format: 'date-time' } } },
      either: { type: ['string', 'number', 'null'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    });
  });

  it('keeps `required` and closed objects in input schemas', () => {
    const input = publishedJsonSchema(z.object({ a: z.string(), b: z.number().optional() }), 'input');
    expect(input).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
    expect(publishedJsonSchema(z.strictObject({}), 'input')).toMatchObject({ additionalProperties: false });
  });

  it('never treats a property NAMED like a keyword as one', () => {
    const output = publishedJsonSchema(z.object({ required: z.string(), $schema: z.string() }), 'output');
    // Names are kept whatever they are; only keywords are dropped.
    expect(Object.keys(output.properties as object)).toEqual(['required', '$schema']);
  });

  it('validates exactly as zod does', async () => {
    const published = publish(z.object({ n: z.number().int().default(3) }));
    expect(await published['~standard'].validate({})).toEqual({ value: { n: 3 } });
    const bad = await published['~standard'].validate({ n: 1.5 });
    expect(bad.issues?.length).toBeGreaterThan(0);
    expect(published['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toMatchObject({
      properties: { n: { type: 'integer', default: 3 } },
    });
    expect(published['~standard'].jsonSchema.output({ target: 'draft-2020-12' })).not.toHaveProperty(
      'required',
    );
  });
});
