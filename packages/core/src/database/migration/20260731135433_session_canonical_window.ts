import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731135433_session_canonical_window",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_canonical_window\` (
          \`session_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`route_id\` text NOT NULL,
          \`variant\` text DEFAULT '' NOT NULL,
          \`source_seq\` integer NOT NULL,
          \`items\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_canonical_window_pk\` PRIMARY KEY(\`session_id\`, \`provider_id\`, \`model_id\`, \`route_id\`, \`variant\`),
          CONSTRAINT \`fk_session_canonical_window_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_canonical_window_session_idx\` ON \`session_canonical_window\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
