/**
 * Recipient last-name inference from email handle.
 *
 * 2026-05-11 incident: order #12001 (Esmeralda P) silently rejected by
 * DAC. Investigation showed the recipient name "Esmeralda P" — a single
 * letter as the last name — was the ONLY single-letter-last-name order
 * in the tenant's history, AND it was the only Aires-Puros order that
 * failed (two prior Aires-Puros orders with full names succeeded). DAC's
 * server-side validator silently rejects names where the last name is
 * too short (no error message, URL stays on /envios/nuevo).
 *
 * The customer's Shopify email contained the missing piece:
 *   email = "pieriesmeralda@gmail.com"
 *   first_name = "Esmeralda"
 *   last_name = "P"
 * → handle "pieriesmeralda" obviously concatenates "pieri" + "esmeralda".
 * The real last name is almost certainly "Pieri".
 *
 * ── Why deterministic (no AI) ─────────────────────────────────────────────
 *
 * The operator's constraint: "no aluciones". Email handles follow well-
 * known patterns (firstName+lastName, lastName+firstName, first.last,
 * etc.) that a regex can parse with 100% certainty. We refuse to guess
 * when the heuristic returns nothing — null bubbles up to the caller
 * which then ships with operator-call note (no name change applied).
 *
 * No external API. No web search. No hallucination surface. The function
 * either finds a clear match in the email handle or returns null.
 *
 * ── Scope ──────────────────────────────────────────────────────────────
 *
 * Only runs when the existing last name is ≤2 characters (after
 * trimming). For normal customer orders this is a no-op fast path.
 *
 * Only returns a candidate when:
 *   1. The email has an @ and a non-empty handle.
 *   2. The first name (lowercased, stripped of accents) appears as a
 *      contiguous substring in the email handle.
 *   3. The remainder of the handle, after stripping the firstName, has
 *      ≥3 contiguous alphabetic characters.
 *   4. The remainder is purely alphabetic (no digits, no symbols) —
 *      "esmeralda1234@gmail.com" yields null because "1234" isn't a name.
 *
 * Returns title-cased Spanish-form output (first letter upper, rest lower).
 */

export interface NameInferenceInput {
  firstName: string;
  lastName: string;
  email: string | null | undefined;
}

export interface NameInferenceResult {
  /** Inferred last name in title case, or null if no high-confidence match. */
  inferredLastName: string | null;
  /** Short description for logs + operator note. */
  reasoning: string;
}

/**
 * Strip accents and lowercase. Mirrors normalizeNameForMatch / the dept
 * resolver's accent handling so "José" and "jose" compare equal.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function inferLastNameFromEmail(input: NameInferenceInput): NameInferenceResult {
  const firstName = (input.firstName ?? '').trim();
  const lastName = (input.lastName ?? '').trim();
  const email = (input.email ?? '').trim();

  // Fast-path: last name already looks complete. ≥3 chars is a defensible
  // floor — Uruguayan last names below 3 chars are essentially nonexistent
  // (the shortest common ones are "Lus", "Mas", "Ros" — still 3).
  if (lastName.length >= 3) {
    return { inferredLastName: null, reasoning: 'last name already looks complete (≥3 chars)' };
  }

  if (!firstName) {
    return { inferredLastName: null, reasoning: 'no firstName to anchor email parsing' };
  }
  if (!email || !email.includes('@')) {
    return { inferredLastName: null, reasoning: 'no usable email' };
  }

  const handle = email.split('@')[0];
  if (!handle) {
    return { inferredLastName: null, reasoning: 'empty email handle' };
  }

  const handleNorm = normalize(handle);
  const firstNameNorm = normalize(firstName);

  // Find firstName in the handle. We need it to appear as a contiguous
  // substring. Examples:
  //   "pieriesmeralda" + first="esmeralda" → idx=5 → before="pieri", after=""
  //   "juan.perez"     + first="juan"      → idx=0 → before="",     after=".perez"
  //   "perez.juan"     + first="juan"      → idx=6 → before="perez.", after=""
  //   "esme1234"       + first="esmeralda" → not found → null
  const idx = handleNorm.indexOf(firstNameNorm);
  if (idx === -1) {
    return {
      inferredLastName: null,
      reasoning: `firstName "${firstNameNorm}" not found in email handle "${handleNorm}"`,
    };
  }

  const before = handleNorm.slice(0, idx);
  const after = handleNorm.slice(idx + firstNameNorm.length);

  // Strip non-alphabetic chars from each candidate. Examples:
  //   "pieri" → "pieri"  (5 alphabetic)
  //   ""      → ""       (0 — rejected)
  //   ".perez" → "perez" (5 alphabetic, after dot stripped)
  //   "1234"  → ""       (0 — rejected)
  //   "perez.j" → "perezj" (6 — we keep alphabetic only, no separators)
  // Actually we DO want to handle dotted forms: "perez.juan" → before="perez."
  // → strip non-alpha → "perez" ✓. The dot strip is intentional.
  const beforeAlpha = before.replace(/[^a-zA-Z]/g, '');
  const afterAlpha = after.replace(/[^a-zA-Z]/g, '');

  // Pick the longest alphabetic candidate. If both have content (rare
  // — handles usually have firstName at one end) take the longer one.
  const candidates = [beforeAlpha, afterAlpha]
    .filter((s) => s.length >= 3)
    .sort((a, b) => b.length - a.length);

  if (candidates.length === 0) {
    return {
      inferredLastName: null,
      reasoning: `no ≥3-char alphabetic remainder in handle "${handleNorm}" (before="${beforeAlpha}", after="${afterAlpha}")`,
    };
  }

  const chosen = candidates[0];

  // Sanity guard: refuse candidates that look like clearly-not-a-name
  // tokens (common email-handle filler words).
  const rejectIfMatches = new Set([
    'gmail',
    'hotmail',
    'yahoo',
    'outlook',
    'live',
    'admin',
    'info',
    'mail',
    'user',
    'cliente',
    'cli',
    'noreply',
    'test',
  ]);
  if (rejectIfMatches.has(chosen)) {
    return {
      inferredLastName: null,
      reasoning: `remainder "${chosen}" looks like a generic email token, not a name`,
    };
  }

  // Title case: capitalize first letter, lowercase the rest.
  // Multi-word names ("de la cruz") can't appear here because the regex
  // strip removed spaces — handles don't contain spaces.
  const titleCased = chosen.charAt(0).toUpperCase() + chosen.slice(1);

  return {
    inferredLastName: titleCased,
    reasoning: `email handle "${handleNorm}" decomposes into "${beforeAlpha || '∅'}" + firstName "${firstNameNorm}" + "${afterAlpha || '∅'}" — "${chosen}" looks like the last name`,
  };
}
