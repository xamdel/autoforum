export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = environment.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }

  const port = Number(environment.PORT ?? 3_000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${environment.PORT}`);
  }
  const databaseUrl = environment.DATABASE_URL ?? "postgres://localhost:5432/autoforum";
  const protocol = new URL(databaseUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a Postgres URL");
  }

  return {
    nodeEnv,
    host: environment.HOST || "127.0.0.1",
    port,
    databaseUrl,
  };
}
