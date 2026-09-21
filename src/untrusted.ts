/**
 * Marking third-party text as data, not instructions.
 *
 * Report bodies, comments and programme descriptions are written by *other*
 * people — possibly an attacker who knows an AI assistant will read them. Every
 * such string a tool returns is wrapped:
 *
 *   <untrusted-content-3f9a0c7e12b4d5a6 source="program:123:description">
 *   …text…
 *   </untrusted-content-3f9a0c7e12b4d5a6>
 *
 * and the server instructions tell the model never to follow instructions
 * inside these blocks. Wrapping is only useful if the text cannot close the
 * block early and continue "outside" it, so:
 *
 * 1. The tag name carries a random nonce, fresh for every tool response
 *    (every block in one response shares it). Text written before the response
 *    existed cannot know it, so it cannot produce a matching closing tag.
 * 2. Anything in the text that looks like the delimiter anyway —
 *    `<untrusted-content…` / `</untrusted-content…` in any case, with any
 *    whitespace or slashes an HTML-ish parser might accept, including the
 *    fullwidth and small `<` look-alikes — has its `<` replaced by `&lt;`.
 * 3. Invisible characters (Unicode `Default_Ignorable_Code_Point`: zero-width
 *    space/joiners, word joiner, soft hyphen, variation selectors, the "tag"
 *    block used for ASCII smuggling, …) are removed, so they can neither hide
 *    instructions from a human reviewer nor split a delimiter to dodge rule 2.
 *    (Emoji ZWJ sequences degrade to their component emoji; that is the price.)
 * 4. Bidirectional controls (Trojan Source) are made visible as `\u{…}`
 *    escapes rather than silently reordering the text.
 * 5. The `source` label is restricted to a conservative character set so it
 *    cannot break out of its attribute.
 *
 * This is defence in depth, not a guarantee: a model can still be persuaded by
 * data. Write tools therefore also require the user's explicit approval (see
 * tools/approval.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export const UNTRUSTED_TAG = 'untrusted-content';

/** 64-bit nonce, lowercase hex. */
const NONCE_BYTES = 8;
const NONCE_PATTERN = `[0-9a-f]{${String(NONCE_BYTES * 2)}}`;
const SOURCE_PATTERN = '[A-Za-z0-9:._/#@-]';
const MAX_SOURCE_LENGTH = 120;

// `<` (or a look-alike: U+FE64 small, U+FF1C fullwidth) + optional whitespace/slashes + tag name, any case.
const DELIMITER = /[<\uFE64\uFF1C](?=[\s/]*untrusted-content)/giu;
// Bidirectional controls: ALM, LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
// Every other invisible code point (includes the U+E0000 tag block and variation selectors).
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const SOURCE_UNSAFE = new RegExp(`[^${SOURCE_PATTERN.slice(1, -1)}]`, 'g');

/** Printable escape for one code point, e.g. `\u{202E}`. */
export const visibleEscape = (char: string): string => {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
};

/** Neutralise text so it can sit safely inside an untrusted-content block. */
export const escapeUntrusted = (text: string): string => {
  // Order matters: invisible characters go first, so they cannot split a delimiter.
  return text.replace(BIDI_CONTROLS, visibleEscape).replace(INVISIBLE, '').replace(DELIMITER, '&lt;');
};

/** Sanitise a `source` label (e.g. `report:abc123:body`). */
export const sanitizeSource = (source: string): string => {
  const cleaned = source.replace(SOURCE_UNSAFE, '_').slice(0, MAX_SOURCE_LENGTH);
  return cleaned === '' ? 'unknown' : cleaned;
};

/** A fresh delimiter nonce. */
export const newNonce = (): string => {
  return randomBytes(NONCE_BYTES).toString('hex');
};

const responseNonce = new AsyncLocalStorage<string>();

/**
 * Run `fn` with one delimiter nonce shared by every `untrusted()` call made
 * while it runs (the tool framework wraps each tool call in this, so a nonce
 * is per response). Outside such a scope every call draws a fresh nonce.
 */
export const withResponseNonce = <T>(fn: () => T, nonce: string = newNonce()): T => {
  return responseNonce.run(nonce, fn);
};

/** The tag name for `nonce`, e.g. `untrusted-content-3f9a0c7e12b4d5a6`. */
export const untrustedTagName = (nonce: string): string => {
  return `${UNTRUSTED_TAG}-${nonce}`;
};

/**
 * Wrap third-party text. `null`/`undefined` pass through unchanged so optional
 * fields stay optional.
 */
export function untrusted(source: string, text: string): string;
export function untrusted(source: string, text: string | null): string | null;
export function untrusted(source: string, text: string | undefined): string | undefined;
export function untrusted(source: string, text: string | null | undefined): string | null | undefined;
export function untrusted(source: string, text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined) return text;
  const tag = untrustedTagName(responseNonce.getStore() ?? newNonce());
  return `<${tag} source="${sanitizeSource(source)}">\n${escapeUntrusted(text)}\n</${tag}>`;
}

/** Wrap an arbitrary JSON value (e.g. an org-authored scope list) as untrusted text. */
export const untrustedJson = (source: string, value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return untrusted(source, JSON.stringify(value, null, 2));
};

const BLOCK = new RegExp(
  `^<${UNTRUSTED_TAG}-(${NONCE_PATTERN}) source="${SOURCE_PATTERN}{1,${String(MAX_SOURCE_LENGTH)}}">\\n[\\s\\S]*\\n</${UNTRUSTED_TAG}-\\1>$`,
  'u',
);
const ANY_DELIMITER = new RegExp(`</?${UNTRUSTED_TAG}`, 'giu');

/** `true` when `value` is exactly one block produced by `untrusted()`. */
export const isUntrustedBlock = (value: string): boolean => {
  // Exactly one opening and one closing delimiter: the ones `untrusted()` wrote.
  return BLOCK.test(value) && (value.match(ANY_DELIMITER) ?? []).length === 2;
};

// C0 controls except tab and line feed (so CR, backspace, ESC…), DEL, the C1
// block (NEL U+0085 included) and the Unicode line/paragraph separators: none
// has a visible glyph, and each can move the cursor, erase what was shown or
// start a new line a renderer does not count as one.
// eslint-disable-next-line no-control-regex
const REVIEW_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
// `<` that could open an HTML comment or tag in a client that renders the
// prompt as Markdown/HTML (`<!-- hidden -->`, `<details>`, `</x>`, `<?x`).
const MARKUP_OPENER = /<(?=[!/?A-Za-z])/g;

/**
 * Show text to a HUMAN reviewer (approval prompts) exactly as it will be sent,
 * but with every character that could hide or fake something made visible:
 * invisible and direction-changing characters and control characters become
 * `\u{…}` escapes, and a `<` that could open markup becomes `\<` (which a
 * Markdown renderer displays as `<`, and a plain-text one as `\<`).
 */
export const revealForReview = (text: string): string => {
  return text
    .replace(BIDI_CONTROLS, visibleEscape)
    .replace(INVISIBLE, visibleEscape)
    .replace(REVIEW_CONTROLS, visibleEscape)
    .replace(MARKUP_OPENER, '\\<');
};

/**
 * `true` when `text` contains a C0/C1 control character other than tab and
 * line feed (carriage returns are normalised away before this is checked),
 * or a Unicode line/paragraph separator. Used to refuse such input outright.
 */
export const hasControlCharacters = (text: string): boolean => {
  REVIEW_CONTROLS.lastIndex = 0;
  return REVIEW_CONTROLS.test(text);
};
