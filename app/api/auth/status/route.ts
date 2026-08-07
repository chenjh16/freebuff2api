import { NextResponse } from "next/server";
import { pollLoginStatus, LoginError } from "../../../../src/login.ts";
import { getRuntime } from "../../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const fingerprintId = url.searchParams.get("fingerprintId") ?? "";
    const fingerprintHash = url.searchParams.get("fingerprintHash") ?? "";
    const expiresAt = Number(url.searchParams.get("expiresAt") ?? "0");
    const loginUrl = url.searchParams.get("loginUrl") ?? "";
    if (!fingerprintId || !fingerprintHash || !expiresAt) {
      return NextResponse.json({ error: "missing login params" }, { status: 400 });
    }
    const { cfg } = await getRuntime();
    try {
      const user = await pollLoginStatus(
        cfg.loginBaseURL,
        { fingerprintId, fingerprintHash, expiresAt, loginUrl, createdAt: Date.now() },
        // One HTTP request performs a bounded upstream poll; the browser
        // repeats the call until it gets the user record.
        { intervalMs: 3_000, timeoutMs: 9_000 },
      );
      return NextResponse.json({
        user: {
          id: user.id ?? "",
          name: user.name,
          email: user.email,
          authToken: user.authToken,
        },
      });
    } catch (error) {
      // Still waiting (login not finished yet) or the code expired: tell the
      // browser to keep polling / show the link again.
      if (error instanceof LoginError) return NextResponse.json({ pending: true });
      throw error;
    }
  } catch {
    return NextResponse.json({ error: "login status check failed" }, { status: 502 });
  }
}
