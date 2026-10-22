
import dotenv from "dotenv";
import app from "./app.js";
import { testDatabaseConnection } from "./config/database.js";

dotenv.config();

const port = Number(process.env.PORT ?? 3000);

async function startServer(): Promise<void> {
  await testDatabaseConnection();

  app.listen(port, () => {
    console.log(`Chat backend listening on http://localhost:${port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error("Failed to start server:", error);
  process.exitCode = 1;
});
