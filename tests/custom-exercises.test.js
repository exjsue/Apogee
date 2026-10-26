// Removing, editing and restoring the user's own exercises: the shared rules against the memory adapter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAdapter } from "../src/storage/memory-adapter.js";
import { customExerciseRules } from "./custom-exercise-rules.js";

for (const { name, run } of customExerciseRules) {
  test(name, async () => {
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
