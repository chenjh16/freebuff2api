import { NextResponse } from "next/server";
import { requestLoginCode, LoginError } from "../../../../src/login.ts";
import { getRuntime } from "../../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  try {
    const { fingerprintId } = (await request.json().catch(() => ({}))) as { fingerprintId?: unknown };
    if (typeof fingerprintId !== "string" || fingerprintId.length < 8 || fingerprintId.length > 128) {
      return NextResponse.json({ error: "fingerprintId is required" }, { status: 400 });
    }
    const { cfg } = await getRuntime();
    const code = await requestLoginCode(cfg.loginBaseURL, fingerprintId);
    return NextResponse.json({
      loginUrl: code.loginUrl,
      fingerprintHash: code.fingerprintHash,
      expiresAt: code.expiresAt,
    });
  } catch (error) {
    const message = error instanceof LoginError ? error.message : error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
