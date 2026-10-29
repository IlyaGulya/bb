import type { ProductAnalyticsLocalActions } from "@bb/server-contract";
import type { ProductAnalyticsAck, ProductAnalyticsBatch, ProductAnalyticsReport, ProductAnalyticsReportQuery } from "@bb/server-contract";
import type { CreateSdkAreaArgs } from "./common.js";
export type { ProductAnalyticsAck, ProductAnalyticsBatch, ProductAnalyticsEvent, ProductAnalyticsFeature, ProductAnalyticsMode, ProductAnalyticsReport, ProductAnalyticsReportQuery, ProductAnalyticsRow, ProductAnalyticsScope, ProductAnalyticsSurface, ProductAnalyticsActor } from "@bb/server-contract";

export interface ExperimentalProductAnalyticsArea {
  declareLocalActions(input: ProductAnalyticsLocalActions): Promise<{ ok: boolean }>;
  record(batch: ProductAnalyticsBatch): Promise<ProductAnalyticsAck>;
  report(query: ProductAnalyticsReportQuery): Promise<ProductAnalyticsReport>;
}
export function createProductAnalyticsArea({ transport }: CreateSdkAreaArgs): ExperimentalProductAnalyticsArea {
  const api = transport.api.v1.system["product-analytics"];
  return {
    declareLocalActions(input) { return transport.readJson(api["local-actions"].$post({ json: input })); },
    record(batch) { return transport.readJson(api.events.$post({ json: batch })); },
    report(query) { return transport.readJson(api.report.$get({ query })); },
  };
}
