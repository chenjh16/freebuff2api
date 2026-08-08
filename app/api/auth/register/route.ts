import { NextResponse } from "next/server";
import { getRuntime } from "../../../lib/proxy";
import { generateApiKey } from "../../../lib/account";
import {
  clearLoginCookie,
  clearLoginTransaction,
  loginTransactionId,
  takeLoginTransactionUser,
} from "../../../lib/login-transaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  try {
    const { transactionId } = (await request.json().catch(() => ({}))) as { transactionId?: unknown };
    const cookieId = loginTransactionId(request);
    if (typeof transactionId !== "string" || transactionId.length < 20 || transactionId !== cookieId) {
      return NextResponse.json({ error: "login transaction is invalid" }, { status: 400 });
    }
    const user = takeLoginTransactionUser(transactionId);
    if (!user?.authToken) {
      return NextResponse.json({ error: "login is still pending or expired" }, { status: 409 });
    }
    const { client } = await getRuntime();
    let me: { id?: string; name?: string; email?: string };
    try {
      me = await client.me(user.authToken);
    } catch (error) {
      clearLoginTransaction(transactionId);
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
      clearLoginTransaction(transactionId);
      return NextResponse.json({ error: "could not identify the account" }, { status: 401 });
    }
    const apiKey = generateApiKey(user.authToken);
    const response = NextResponse.json({
      apiKey,
      user: { id: me.id ?? null, name: me.name ?? null, email: me.email ?? null },
    });
    response.headers.set("Set-Cookie", clearLoginCookie());
    return response;
  } catch {
    return NextResponse.json({ error: "register failed" }, { status: 500 });
  }
}
