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
 *    whitespace or slashes an HTML-ish parser might accept before the name —
 *    has its `<` replaced by `&lt;`. So does anything that Unicode
 *    compatibility normalisation (NFKC) turns into that: the fullwidth and
 *    small forms of `<`, `/` and `-`, fullwidth or mathematical letters, in any
 *    mix; and anything that becomes that once control characters (C0, DEL, C1)
 *    are dropped, wherever they sit, between `<` and the name or inside it. A
 *    reader that normalises the text or discards controls sees no delimiter
 *    either. Characters that merely resemble the delimiter's without being
 *    equivalent to them (letters of other scripts, other dashes) are not
 *    covered: the nonce is what stops those.
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

// `<` + optional whitespace or slashes + tag name, any case. Matched against
// folded text (`fold`), which is where the look-alikes of each character are
// covered and control characters are dropped.
const DELIMITER = /<(?=[\s/]*untrusted-content)/giu;
// Anything but printable ASCII: text holding none of it is its own fold.
const NEEDS_FOLD = /[^\u0020-\u007E]/u;
const NOT_ASCII = /[^\p{ASCII}]/u;
// C0 controls, DEL and the C1 block. Some readers discard them (tokenizer
// normalisers do), and NEL and the like are not in `\s`.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;
// Bidirectional controls: ALM, LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
// Every other invisible code point (includes the U+E0000 tag block and variation selectors).
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const SOURCE_UNSAFE = new RegExp(`[^${SOURCE_PATTERN.slice(1, -1)}]`, 'g');

/** Printable escape for one code point, e.g. `\u{202E}`. */
export const visibleEscape = (char: string): string => {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
};

/**
 * `text` with every code point replaced by its NFKC image and every control
 * character dropped, and for each UTF-16 unit of the result the index in
 * `text` of the code point it comes from. Folding one code point at a time
 * keeps that mapping exact; it differs from normalising the whole string only
 * where combining marks compose, which never produces an ASCII character.
 */
const fold = (text: string): { folded: string; origin: number[] } => {
  let folded = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const image = CONTROL.test(char) ? '' : NOT_ASCII.test(char) ? char.normalize('NFKC') : char;
    folded += image;
    while (origin.length < folded.length) origin.push(index);
    index += char.length;
  }
  return { folded, origin };
};

/** Replace the `<` of every delimiter, in any normalisation-equivalent spelling, by `&lt;`. */
const neutraliseDelimiters = (text: string): string => {
  if (!NEEDS_FOLD.test(text)) return text.replace(DELIMITER, '&lt;');
  const { folded, origin } = fold(text);
  let out = '';
  let copied = 0;
  for (const match of folded.matchAll(DELIMITER)) {
    // The code point of `text` that folds to this `<` (itself, U+FE64 or U+FF1C).
    const at = origin[match.index];
    if (at === undefined || at < copied) continue;
    const length = (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
    out += `${text.slice(copied, at)}${text
      .slice(at, at + length)
      .normalize('NFKC')
      .replace('<', '&lt;')}`;
    copied = at + length;
  }
  return out + text.slice(copied);
};

/** Neutralise text so it can sit safely inside an untrusted-content block. */
export const escapeUntrusted = (text: string): string => {
  // Order matters: invisible characters go first, so they cannot split a delimiter.
  return neutraliseDelimiters(text.replace(BIDI_CONTROLS, visibleEscape).replace(INVISIBLE, ''));
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

/** `true` when `value` is exactly one block produced by `untrusted()`. */
export const isUntrustedBlock = (value: string): boolean => {
  // Exactly one opening and one closing delimiter: the ones `untrusted()` wrote.
  // Counted the way `escapeUntrusted` looks for them, so a look-alike that
  // slipped into the text fails the check.
  return BLOCK.test(value) && (fold(value).folded.match(DELIMITER) ?? []).length === 2;
};

// C0 controls except tab and line feed (so CR, backspace, ESC…), DEL, the C1
// block (NEL U+0085 included) and the Unicode line/paragraph separators: none
// has a visible glyph, and each can move the cursor, erase what was shown or
// start a new line a renderer does not count as one.
// eslint-disable-next-line no-control-regex
const REVIEW_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
/**
 * `true` when `text` contains a C0/C1 control character other than tab and
 * line feed (carriage returns are normalised away before this is checked),
 * or a Unicode line/paragraph separator. Used to refuse such input outright:
 * such characters have no business in a report, and could hide or rearrange
 * what the user is shown for approval.
 */
export const hasControlCharacters = (text: string): boolean => {
  REVIEW_CONTROLS.lastIndex = 0;
  return REVIEW_CONTROLS.test(text);
};

// Everything `escapeUntrusted` removes or escapes on the way out: the
// bidirectional controls and every `Default_Ignorable_Code_Point`. Built from
// the same two expressions, so the two directions cannot drift apart.
const CONCEALED = new RegExp(`${BIDI_CONTROLS.source}|${INVISIBLE.source}`, 'u');
const BIDI_CONTROL = new RegExp(BIDI_CONTROLS.source, 'u');
const ZERO_WIDTH_NON_JOINER = '\u200C';
const ZERO_WIDTH_JOINER = '\u200D';
const TEXT_PRESENTATION = '\uFE0E';
const EMOJI_PRESENTATION = '\uFE0F';
const KEYCAP = '\u20E3';
const KEYCAP_BASE = /^[0-9#*]$/;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
// Scripts whose orthography uses the zero-width joiner or non-joiner, where
// the character changes how its neighbours are drawn (so it is not hidden):
// the Arabic family (Persian, Urdu, Kurdish…), the joining scripts of West
// Africa, and the Indic and South-East Asian scripts that use it in clusters.
const JOINER_SCRIPTS = [
  'Arabic',
  'Syriac',
  'Mandaic',
  'Nko',
  'Adlam',
  'Hanifi_Rohingya',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Khmer',
  'Myanmar',
];
const JOINER_SCRIPT = new RegExp(`[${JOINER_SCRIPTS.map((script) => `\\p{scx=${script}}`).join('')}]`, 'u');

/** A character `hiddenCharacter` refuses, and which of the two kinds it is. */
export interface HiddenCharacter {
  kind: 'direction-changing' | 'invisible';
  /** Printable escape of the code point, e.g. `\u{202E}`. */
  escape: string;
}

/**
 * The first character of `text` that hides or reorders content, or `null`.
 * Used to refuse input a person approves before it is sent: what they read
 * must be what is written. (Control characters are `hasControlCharacters`.)
 *
 * Refused, wherever they sit:
 * - every bidirectional control (U+061C, U+200E, U+200F, U+202A–U+202E,
 *   U+2066–U+2069): they change the order text is displayed in (Trojan
 *   Source). Right-to-left text needs none of them: the bidirectional
 *   algorithm orders Arabic or N'Ko letters by itself;
 * - every other `Default_Ignorable_Code_Point`, which renders as nothing: the
 *   zero-width space, word joiner, BOM, soft hyphen, combining grapheme
 *   joiner, Hangul and Khmer fillers, Mongolian vowel separator and free
 *   variation selectors, invisible operators, deprecated format characters,
 *   variation selectors 1–14 and 17–256, and the whole tag block
 *   (U+E0000–U+E007F), which spells invisible ASCII. Tags are refused even in
 *   a well-formed emoji tag sequence, so the subdivision flags (England,
 *   Scotland, Wales) are refused: an exception would keep open a channel that
 *   carries letters and digits, for three flags.
 *
 * Accepted, only where legitimate text needs them and never in a run (each
 * must directly follow a visible character, so a sequence of them cannot
 * encode hidden data, as zero-width or variation-selector steganography does):
 * - the zero-width joiner and non-joiner (U+200D, U+200C) directly after a
 *   letter or mark of a script that uses them (`JOINER_SCRIPTS`), where they
 *   visibly change the shaping (Persian compounds, Indic conjuncts);
 * - the zero-width joiner inside an emoji sequence: after a pictograph, a skin
 *   tone modifier or the emoji presentation selector, and before a pictograph
 *   (family, profession and flag sequences);
 * - the presentation selectors (U+FE0E, U+FE0F) directly after a pictograph,
 *   and U+FE0F between a keycap base (`0`–`9`, `#`, `*`) and U+20E3.
 * Anywhere else (a joiner between Latin letters, a selector after a letter)
 * they are invisible and refused.
 */
export const hiddenCharacter = (text: string): HiddenCharacter | null => {
  if (!CONCEALED.test(text)) return null;
  const chars = Array.from(text);
  for (const [index, char] of chars.entries()) {
    if (!CONCEALED.test(char)) continue;
    if (BIDI_CONTROL.test(char)) return { kind: 'direction-changing', escape: visibleEscape(char) };
    const previous = chars[index - 1] ?? '';
    const next = chars[index + 1] ?? '';
    const joiner = char === ZERO_WIDTH_JOINER || char === ZERO_WIDTH_NON_JOINER;
    if (joiner && LETTER_OR_MARK.test(previous) && JOINER_SCRIPT.test(previous)) continue;
    if (
      char === ZERO_WIDTH_JOINER &&
      // A selector reached here was accepted: it follows a pictograph.
      (PICTOGRAPH.test(previous) || EMOJI_MODIFIER.test(previous) || previous === EMOJI_PRESENTATION) &&
      PICTOGRAPH.test(next)
    ) {
      continue;
    }
    const selector = char === EMOJI_PRESENTATION || char === TEXT_PRESENTATION;
    if (selector && PICTOGRAPH.test(previous)) continue;
    if (char === EMOJI_PRESENTATION && KEYCAP_BASE.test(previous) && next === KEYCAP) continue;
    return { kind: 'invisible', escape: visibleEscape(char) };
  }
  return null;
};
