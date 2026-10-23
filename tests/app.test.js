import test from "node:test";
import assert from "node:assert/strict";
import { domainRules } from "./domain-rules.js";
import { storeExtraRules } from "./store-extra-rules.js";
import { loggerRules } from "./logger-rules.js";
import { sessionRules } from "./session-rules.js";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";

// The shared rules, against the memory adapter.
for (const { name, run } of [...domainRules, ...storeExtraRules, ...loggerRules, ...sessionRules]) {
  test(`app rules: ${name}`, async () => {
    const adapters = [];
    const createAdapter = () => {
      const adapter = createMemoryAdapter();
      adapters.push(adapter);
      return adapter;
    };
    try {
      await run({ assert, createAdapter });
    } finally {
      for (const adapter of adapters) adapter.close();
    }
  });
}
