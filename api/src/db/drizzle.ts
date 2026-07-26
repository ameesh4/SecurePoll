import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import dotenv from "dotenv";
import config from "../../drizzle.config";
import { relations } from "./relations";
dotenv.config();

const pool = new Pool({
  connectionString: config.dbCredentials.url,
});

export const db = drizzle({ client: pool, relations });
// const result = await db.execute('select 1');
pool
  .query("SELECT 1")
  .then(() => console.log("Connected to the database"))
  .catch((err) =>
    console.error("Failed to connect to the database:", err.message),
  );

export const schemaPath = config.schema;
export default db;
