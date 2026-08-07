import { NextResponse } from "next/server";
import { getRuntime } from "../../../lib/proxy";
import {
  loginTransactionId,
  pollLoginTransaction,
} from "../../../lib/login-transaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  try {
    const id = loginTransactionId(request);
    if (!id) return NextResponse.json({ error: "login transaction is missing" }, { status: 400 });
    const { cfg } = await getRuntime();
    const user = await pollLoginTransaction(id, cfg.loginBaseURL);
    if (!user) return NextResponse.json({ pending: true });
    return NextResponse.json({ transactionId: id, pending: false });
  } catch {
    return NextResponse.json({ error: "login status check failed" }, { status: 502 });
  }
}
