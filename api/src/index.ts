import { createServer } from "http";
import { app } from "./app";
import { env } from "./config/env";

const server = createServer(app);

const startServer = async () => {
  server.listen(env.PORT, "0.0.0.0", () => {
    console.log(`[Server] Listening on port ${env.PORT} (${env.NODE_ENV})`);
  });
};

startServer().catch((error) => {
  console.error("[Server] Failed to start server:", error);
  process.exit(1);
});
