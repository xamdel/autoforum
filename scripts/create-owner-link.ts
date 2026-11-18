import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db.ts";
import { issueSignInLink } from "../src/auth/browser.ts";
import { ensureInstallationOwner } from "../src/users.ts";

const config = loadConfig();
const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
const requestedHandle = arguments_[0] ?? "owner";
const origin = arguments_[1]
  ?? process.env.APP_ORIGIN
  ?? (config.nodeEnv === "production" ? `http://${config.host}:${config.port}` : "http://app.autoforum.localhost:5173");
const database = createDatabase(config.databaseUrl);

try {
  await database.migrate();
  const owner = await ensureInstallationOwner(database, requestedHandle);
  const link = await issueSignInLink(database, owner, owner.id);
  console.log(`${origin.replace(/\/$/, "")}/#sign-in=${encodeURIComponent(link.token)}`);
  console.log(`Link expires at ${link.expiresAt.toISOString()}`);
} catch (error) {
  if (error instanceof Error && error.name === "ZodError") {
    console.error("Owner handle must be 2-32 lowercase letters, numbers, underscores, or hyphens, beginning with a letter.");
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await database.close();
}
