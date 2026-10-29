import { z } from "zod";

export const productAnalyticsModeSchema = z.enum(["production", "preview", "smoke", "test"]);
export type ProductAnalyticsMode = z.infer<typeof productAnalyticsModeSchema>;
