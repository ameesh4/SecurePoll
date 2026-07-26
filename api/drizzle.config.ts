import * as dotenv from "dotenv";

dotenv.config();

export default {
  schema: "./src/db/schema/index.ts", // Barrel that re-exports every table
  out: "./src/db/migrations", // Path to store generated migrations
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL, // Connection string for the database
  },
};
