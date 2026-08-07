import { NextResponse } from "next/server";
import { revokeApiKey } from "../../../lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const { apiKey } = (await request.json().catch(() => ({}))) as { apiKey?: unknown };
  if (typeof apiKey !== "string" || !apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  revokeApiKey(apiKey);
  return NextResponse.json({ ok: true });
}
