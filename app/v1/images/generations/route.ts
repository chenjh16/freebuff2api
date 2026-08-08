import { apiRoute, corsPreflight } from "../../../lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Anonymous image generation can take a while for flux-class models.
export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return apiRoute(request);
}

export function OPTIONS(): Response {
  return corsPreflight();
}
