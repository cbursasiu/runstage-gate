#!/usr/bin/env node
// v1 runs the TypeScript sources directly through tsx. A compiled build comes later.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
