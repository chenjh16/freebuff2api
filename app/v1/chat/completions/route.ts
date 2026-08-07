import { apiRoute, corsPreflight } from "../../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Long-lived SSE streams must never be cut short by the Next.js server.
export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return apiRoute(request);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
