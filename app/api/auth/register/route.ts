import { NextResponse } from "next/server";
import { getRuntime } from "../../../lib/proxy";
import { generateApiKey } from "../../../lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  try {
    const { authToken } = (await request.json().catch(() => ({}))) as { authToken?: unknown };
    if (typeof authToken !== "string" || authToken.length < 8 || authToken.length > 512) {
      return NextResponse.json({ error: "authToken is required" }, { status: 400 });
    }
    const { client } = await getRuntime();
    let me: { id?: string; name?: string; email?: string };
    try {
      me = await client.me(authToken);
    } catch (error) {
      return NextResponse.json(
        {
          error: `token rejected by freebuff.com: ${
            error instanceof Error ? error.message.slice(0, 300) : String(error)
          }`,
        },
        { status: 401 },
      );
    }
    if (!me.id && !me.email) {
      return NextResponse.json({ error: "could not identify the account" }, { status: 401 });
    }
    const apiKey = generateApiKey(authToken);
    return NextResponse.json({
      apiKey,
      user: { id: me.id ?? null, name: me.name ?? null, email: me.email ?? null },
    });
  } catch {
    return NextResponse.json({ error: "register failed" }, { status: 500 });
  }
}
