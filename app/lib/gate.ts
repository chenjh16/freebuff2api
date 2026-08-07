/**
 * Site access gate for the hosted web app.
 *
 * When `SITE_ACCESS_TOKEN` is set in the environment, the web console is
 * locked: a visitor must present one of the configured tokens (typed into
 * the gate screen, or passed as `?token=…` in the URL) before the page
 * unlocks. Without the variable the gate is disabled and the site stays
 * open — matching the pre-gate behavior.
 *
 * Token comparison uses SHA-256 + `timingSafeEqual`, so configured values
 * never leak through timing or length.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Env var holding the site access token(s), comma-separated. */
export const SITE_ACCESS_TOKEN_ENV = "SITE_ACCESS_TOKEN";

/** Parse + dedupe the configured site access tokens. */
export function siteGateTokens(env: Record<string, string | undefined>): string[] {
  const raw = env[SITE_ACCESS_TOKEN_ENV];
  if (!raw || !raw.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\n\r]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  ];
}

/** True when at least one site access token is configured (gate enabled). */
export function isSiteGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return siteGateTokens(env).length > 0;
}

/** Constant-time check: does `token` match one of the configured tokens? */
export function verifySiteToken(
  token: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const tokens = siteGateTokens(env);
  if (tokens.length === 0) return false;
  const probe = createHash("sha256").update(token).digest();
  return tokens.some((configured) => {
    const expected = createHash("sha256").update(configured).digest();
    return probe.length === expected.length && timingSafeEqual(probe, expected);
  });
}
