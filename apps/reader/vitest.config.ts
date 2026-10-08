import { packageTests } from "../../vitest.shared.ts";

// The reader's CPU budgets measure thread CPU time.
export default packageTests({ timing: ["tests/reader-cpu.test.ts"] });
