import { isAbsolute } from "node:path";
import { z } from "zod";
import { modelGatewaySchema } from "@bb/domain";
import { ApiError } from "../errors.js";

export function gatewayLogDirectory(baseUrl: string, definition: string | undefined): string | undefined {
  if (!definition) return undefined;
  try {
    const directories = z.record(modelGatewaySchema.shape.baseUrl, z.string().refine(isAbsolute)).parse(JSON.parse(definition));
    const roots = new Map<string, string>();
    for (const [endpoint, directory] of Object.entries(directories)) {
      const normalized = endpoint.replace(/\/+$/, "");
      if (roots.has(normalized)) throw new Error();
      roots.set(normalized, directory);
    }
    return roots.get(baseUrl.replace(/\/+$/, ""));
  } catch {
    throw new ApiError(503, "gateway_logs_unavailable", "CPA log-directory mapping is invalid.");
  }
}
