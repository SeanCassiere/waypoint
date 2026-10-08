import { packageTests } from "../../vitest.shared.ts";

// Diff limits (which start worker threads of their own) and large-fixture guards measure time.
export default packageTests({
  timing: ["tests/compare-limits.test.ts", "tests/scale-guards.test.ts"],
});
