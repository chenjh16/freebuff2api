import { apiRoute, corsPreflight } from "../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET(request: Request): Promise<Response> {
  return apiRoute(request);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
