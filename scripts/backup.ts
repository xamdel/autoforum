import { pathToFileURL } from "node:url";

import { createBackup, restoreBackup } from "../src/backup.ts";
import { loadConfig } from "../src/config.ts";

function usage(): never {
  throw new Error("Usage: backup.ts <create|restore> <directory>");
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const [operation, directory, ...extra] = args;
  if ((operation !== "create" && operation !== "restore") || !directory || extra.length) usage();

  const config = loadConfig();
  if (operation === "create") {
    const backup = await createBackup(config.databaseUrl, directory);
    console.log(`Backup created at ${backup.path}`);
    console.log(`${backup.manifest.projects.length} project(s); Autoforum sandboxes are stopped.`);
    return;
  }

  const backup = await restoreBackup(config.databaseUrl, directory);
  console.log(`Backup restored from ${backup.path}`);
  console.log(`${backup.manifest.projects.length} project(s); Autoforum sandboxes remain stopped.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
