/**
 * Restrict a post-login `?next=` redirect target to an internal path.
 *
 * `next` comes from a URL query parameter — attacker-controlled via a crafted
 * link, not just user-typed. Passed unsanitized to `router.push`, this is the
 * classic open-redirect / script-injection surface (`javascript:...`,
 * scheme-relative `//evil.com`, or the backslash variants some URL parsers
 * treat as an equivalent path separator) that the installed Next.js docs
 * warn against for untrusted router URLs.
 */
export function safeRedirect(next: string | undefined | null, fallback = "/dashboard"): string {
  if (!next) return fallback;

  // Reject control characters up front — they can smuggle a scheme past a
  // naive parser (e.g. a stripped tab turning "/<tab>/evil.com" into
  // "//evil.com"). Written as a code-point check rather than a regex escape
  // range to sidestep escape-sequence handling entirely.
  for (const ch of next) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return fallback;
  }

  // Must start with exactly one '/': not '//' or '/\' (scheme-relative — the
  // browser resolves either as a different origin), and not a scheme like
  // "javascript:" or "https:", which never starts with '/' at all.
  if (!/^\/(?!\/|\\)/.test(next)) return fallback;

  return next;
}
