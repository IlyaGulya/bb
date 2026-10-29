import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { publicApiRoutes, typedRoutes, type PublicApiSchema } from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  acceptCaptureChunk, captureArtifact, createPrivateCapture, downloadCaptureArtifact,
  getPrivateCapture, listCaptureArtifacts, listPrivateCaptures, stageCaptureManifest,
  stopPrivateCapture, syncPrivateCapture,
  previewCaptureArtifact,
  linkPrivateCapture,
} from "../services/private-captures.js";

async function captureBoundary<T>(run: () => T | Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "capture_storage_unavailable", "Private capture storage is unavailable.");
  }
}
export function registerPrivateCaptureRoutes(app: Hono, deps: AppDeps): void {
  const limit = bodyLimit({ maxSize: 512 * 1024, onError: () => { throw new ApiError(413, "capture_source_limit", "Private capture request exceeds its bounded transport limit."); } });
  app.use("/private-captures", limit);
  app.use("/private-captures/*", limit);
  const { get, post } = typedRoutes<PublicApiSchema>(app, { onValidationError: () => new ApiError(400, "capture_invalid", "Invalid private capture request.") });
  const routes = publicApiRoutes.privateCaptures;
  app.use("/private-captures", async (context, next) => { context.header("cache-control", "private, no-store"); await next(); });
  app.use("/private-captures/*", async (context, next) => { context.header("cache-control", "private, no-store"); await next(); });
  post(routes.create, (context, input) => captureBoundary(() => context.json(createPrivateCapture(deps, input), 201)));
  get(routes.list, (context, query) => captureBoundary(() => context.json(listPrivateCaptures(deps, query))));
  get(routes.get, (context, query) => captureBoundary(() => context.json(getPrivateCapture(deps, context.req.param("captureId"), query))));
  post(routes.stop, (context, scope) => captureBoundary(() => context.json({ ...stopPrivateCapture(deps, context.req.param("captureId"), scope), outcome: "accepted" as const })));
  post(routes.sync, (context, scope) => captureBoundary(async () => context.json(await syncPrivateCapture(deps, context.req.param("captureId"), scope))));
  post(routes.link, (context, input) => captureBoundary(() => context.json(linkPrivateCapture(deps, context.req.param("captureId"), input))));
  post(routes.stageManifest, (context, input) => captureBoundary(() => {
    if (input.manifest.captureId !== context.req.param("captureId")) throw new ApiError(409, "capture_identity_conflict", "Capture identity does not match the request.");
    return context.json(stageCaptureManifest(deps, input, input.manifest));
  }));
  post(routes.putChunk, (context, input) => captureBoundary(async () => {
    if (input.chunk.captureId !== context.req.param("captureId")) throw new ApiError(409, "capture_identity_conflict", "Capture identity does not match the request.");
    return context.json(await acceptCaptureChunk(deps, input, input.chunk));
  }));
  get(routes.artifacts, (context, query) => captureBoundary(() => context.json(listCaptureArtifacts(deps, context.req.param("captureId"), query))));
  get(routes.artifact, (context, query) => captureBoundary(() => context.json(captureArtifact(deps, context.req.param("captureId"), context.req.param("artifactId"), query))));
  get(routes.preview, (context, query) => captureBoundary(async () => context.json(await previewCaptureArtifact(deps, context.req.param("captureId"), context.req.param("artifactId"), query))));
  get(routes.download, (context, query) => captureBoundary(() => downloadCaptureArtifact(deps, context.req.param("captureId"), context.req.param("artifactId"), query)));
}
