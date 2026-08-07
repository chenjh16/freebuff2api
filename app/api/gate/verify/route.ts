import { NextResponse } from "next/server";
import { isSiteGateEnabled, verifySiteToken } from "../../../lib/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/gate/verify  { token: "…" }
 *
 * Answers:
 *   - `{ ok: true,  enabled: true  }` — token accepted, site unlocked
 *   - `401 { ok: false, enabled: true  }` — token rejected
 *   - `{ ok: true,  enabled: false }` — no `SITE_ACCESS_TOKEN` configured;
 *     the gate is off and the site is open to everyone
 */
export async function POST(request: Request): Promise<Response> {
  const { token } = (await request.json().catch(() => ({}))) as { token?: unknown };
  const enabled = isSiteGateEnabled();
  if (!enabled) return NextResponse.json({ ok: true, enabled: false });
  if (verifySiteToken(token)) return NextResponse.json({ ok: true, enabled: true });
  return NextResponse.json({ ok: false, enabled: true }, { status: 401 });
}
