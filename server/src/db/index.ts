import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

import { mkdirSync, existsSync } from 'fs'

const DB_PATH = './data/rabbit.db'

if (!existsSync('./data')) {
  mkdirSync('./data', { recursive: true })
}

const sqlite = new Database(DB_PATH)
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')

export const db = drizzle(sqlite, { schema })

migrate(db, { migrationsFolder: './drizzle' })
