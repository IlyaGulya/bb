import { describe, expect, it } from "vitest";
import {
  getMacosTrafficLightClusterWidth,
  getMacosWindowChromeMetrics,
} from "../src/index.js";

describe("getMacosWindowChromeMetrics", () => {
  it.each([
    { major: 14, trafficLightGap: 6, windowCornerRadius: 12 },
    { major: 15, trafficLightGap: 6, windowCornerRadius: 12 },
    { major: 26, trafficLightGap: 9, windowCornerRadius: 16 },
  ])(
    "matches the window AppKit draws on macOS $major",
    ({ major, trafficLightGap, windowCornerRadius }) => {
      expect(getMacosWindowChromeMetrics(major)).toEqual({
        trafficLightGap,
        windowCornerRadius,
      });
    },
  );

  it("measures the cluster from the reported gap", () => {
    expect(getMacosTrafficLightClusterWidth(6)).toBe(54);
    expect(getMacosTrafficLightClusterWidth(9)).toBe(60);
  });
});
