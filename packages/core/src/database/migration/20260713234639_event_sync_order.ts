import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713234639_event_sync_order",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_sync_order\` (
          \`ordinal\` integer PRIMARY KEY AUTOINCREMENT,
          \`event_id\` text NOT NULL,
          CONSTRAINT \`fk_event_sync_order_event_id_event_id_fk\` FOREIGN KEY (\`event_id\`) REFERENCES \`event\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_sync_order_event_id_idx\` ON \`event_sync_order\` (\`event_id\`);`)
      yield* tx.run(`INSERT INTO \`event_sync_order\` (\`event_id\`) SELECT \`id\` FROM \`event\` ORDER BY \`rowid\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
