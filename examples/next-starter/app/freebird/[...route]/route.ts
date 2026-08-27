import { createFreeBirdRouteHandlers } from "@freebirdai/server/next";
import { db, llm, registry } from "@/lib/freebird.server";

const handlers = createFreeBirdRouteHandlers({
  db,
  llm,
  registry,
  getAuthContext: () => ({ userId: "demo-user" }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
