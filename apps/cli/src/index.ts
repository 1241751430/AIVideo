#!/usr/bin/env node
import { main } from "./cli.js";

void main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
