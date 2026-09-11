import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { closePool } from "./db/client.js";

async function main() {
  const app = buildApp();

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    console.log(`🚀 SupportSense Backend running at ${address}`);
    console.log(`   Health check: ${address}/health`);
    console.log(`   Auth routes:  ${address}/api/auth`);
  } catch (err) {
    app.log.error(err);
    await closePool();
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      console.log(`\nReceived ${signal}, closing server gracefully...`);
      try {
        await app.close();
        await closePool();
        console.log("Server and database connections closed.");
        process.exit(0);
      } catch (err) {
        console.error("Error during graceful shutdown:", err);
        process.exit(1);
      }
    });
  }
}

main();
