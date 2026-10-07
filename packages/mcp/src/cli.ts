#!/usr/bin/env node
import { main } from "./index.js";

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
