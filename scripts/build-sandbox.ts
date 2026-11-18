import { buildSandboxImage, SANDBOX_IMAGE } from "../src/sandbox/lifecycle.ts";

console.log(`Building ${SANDBOX_IMAGE}`);
await buildSandboxImage((line) => console.log(line));
console.log(`Built ${SANDBOX_IMAGE}`);
