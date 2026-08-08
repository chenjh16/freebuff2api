/**
 * Short-lived server-side state for the hosted device-code login flow.
 *
 * The browser only receives an opaque transaction id. The upstream account
 * token stays in this process until /api/auth/register consumes it.
 */

import { randomUUID } from "node:crypto";
import { LoginError, pollLoginStatus, type PendingLogin, type StoredUser } from "../../src/login.ts";

const TRANSACTION_TTL_MS = 10 * 60_000;

export interface LoginTransaction extends PendingLogin {
  id: string;
  user: StoredUser | null;
  pollPromise: Promise<StoredUser> | null;
}

const transactions = new Map<string, LoginTransaction>();

function prune(): void {
  const now = Date.now();
  for (const [id, tx] of transactions) {
    if (tx.createdAt + TRANSACTION_TTL_MS < now) transactions.delete(id);
  }
}

export function createLoginTransaction(pending: PendingLogin): LoginTransaction {
  prune();
  const tx: LoginTransaction = { ...pending, id: randomUUID(), user: null, pollPromise: null };
  transactions.set(tx.id, tx);
  return tx;
}

export function getLoginTransaction(id: string): LoginTransaction | null {
  prune();
  return transactions.get(id) ?? null;
}

export function takeLoginTransactionUser(id: string): StoredUser | null {
  const tx = getLoginTransaction(id);
  if (!tx?.user) return null;
  transactions.delete(id);
  return tx.user;
}

export function clearLoginTransaction(id: string): void {
  transactions.delete(id);
}

/** Poll one transaction at a time even if multiple browser tabs race. */
export async function pollLoginTransaction(id: string, loginBaseURL: string): Promise<StoredUser | null> {
  const tx = getLoginTransaction(id);
  if (!tx) return null;
  if (tx.user) return tx.user;
  if (tx.pollPromise) {
    try {
      return await tx.pollPromise;
    } catch {
      return null;
    }
  }

  const promise = pollLoginStatus(
    loginBaseURL,
    {
      fingerprintId: tx.fingerprintId,
      fingerprintHash: tx.fingerprintHash,
      expiresAt: tx.expiresAt,
      loginUrl: tx.loginUrl,
      createdAt: tx.createdAt,
    },
    { intervalMs: 3_000, timeoutMs: 9_000 },
  );
  tx.pollPromise = promise;
  try {
    const user = await promise;
    // The transaction may have been consumed while the upstream poll was in flight.
    const current = transactions.get(id);
    if (current) current.user = user;
    return user;
  } catch (error) {
    if (!(error instanceof LoginError)) throw error;
    return null;
  } finally {
    if (transactions.get(id)?.pollPromise === promise) transactions.get(id)!.pollPromise = null;
  }
}

export function loginCookie(id: string, maxAgeSeconds = 600): string {
  return `freebuff_login=${encodeURIComponent(id)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function clearLoginCookie(): string {
  return "freebuff_login=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
}

export function loginTransactionId(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = /(?:^|;)\s*freebuff_login=([^;]+)/.exec(cookie);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Kept for type-level documentation and future route-level checks. */
export type { StoredUser };
