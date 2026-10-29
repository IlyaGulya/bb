// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTarget } from "./skills/tasks/scripts/capture-demo.mjs";

const id = "__bbDemo_observation_regression";
const fakeSecret = "FAKE_NONSECRET_PROTECTED_SENTINEL_BBDEV42";

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("TextEncoder", TextEncoder);
  window[id] = {
    safeSelectors: [],
    observationKey: await webcrypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
});

afterEach(() => {
  delete window[id];
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function input(type = "text", autocomplete = "off") {
  const element = document.createElement("input");
  element.id = "target";
  element.type = type;
  element.autocomplete = autocomplete;
  element.value = fakeSecret;
  document.body.append(element);
  window[id].safeSelectors.push("#target");
  return element;
}

describe("digest-only observation privacy", () => {
  it.each([
    ["password", "off"],
    ["hidden", "off"],
    ["text", "current-password"],
    ["text", "section-owned new-password"],
    ["text", "one-time-code"],
    ["text", "cc-number"],
    ["text", "cc-csc"],
  ])("refuses protected %s / %s fields even when explicitly selected", async (type, autocomplete) => {
    input(type, autocomplete);
    let failure;
    try {
      await observeTarget("#target", id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(fakeSecret);
  });

  it("preserves safe change detection without returning values, text, or a reusable cross-capture digest", async () => {
    const element = input();
    const first = await observeTarget("#target", id);
    const unchanged = await observeTarget("#target", id);
    element.value = "FAKE_NONSECRET_CHANGED_LABEL_BBDEV42";
    const changed = await observeTarget("#target", id);
    expect(first.state.digest).toBe(unchanged.state.digest);
    expect(changed.state.digest).not.toBe(first.state.digest);
    expect(Object.keys(changed.state).sort()).toEqual(["digest", "present", "visible"]);
    expect(JSON.stringify([first, unchanged, changed])).not.toContain(fakeSecret);
    expect(JSON.stringify(changed)).not.toContain(element.value);
    window[id].observationKey = await webcrypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const nextCapture = await observeTarget("#target", id);
    expect(nextCapture.state.digest).not.toBe(changed.state.digest);
  });

  it("refuses unapproved targets rather than inspecting arbitrary DOM content", async () => {
    input();
    window[id].safeSelectors = [];
    await expect(observeTarget("#target", id)).rejects.toThrow();
  });

  it("refuses container text instead of collecting descendant content", async () => {
    const container = document.createElement("div");
    container.id = "container";
    const child = document.createElement("span");
    child.textContent = fakeSecret;
    container.append(child);
    document.body.append(container);
    window[id].safeSelectors.push("#container");
    await expect(observeTarget("#container", id)).rejects.toThrow();
  });
});
