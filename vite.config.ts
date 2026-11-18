import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function sharedHost(): string | null {
  const configured = process.env.AUTOFORUM_SHARE_ORIGIN;
  if (!configured) return null;
  const origin = new URL(configured);
  if (origin.origin !== configured.replace(/\/$/, "")) throw new Error("AUTOFORUM_SHARE_ORIGIN must be an origin");
  return origin.hostname;
}

const tunnelHost = sharedHost();
const backendPort = Number(process.env.PORT ?? 3_000);

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: [".autoforum.localhost", ...(tunnelHost ? [tunnelHost] : [])],
    proxy: {
      "/health": `http://127.0.0.1:${backendPort}`,
      "/api": `http://127.0.0.1:${backendPort}`,
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
