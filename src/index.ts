import { Client } from "pg"

const client = new Client({
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "postgres",
})

async function connectToDatabase() {
    try{
        await client.connect()

        const res = await client.query("SELECT 1")

        console.log("Database connection successful:", res.rows)

        await client.end()
    }
    catch(err){
        console.error("Database connection failed:", err)
    }
}

connectToDatabase()