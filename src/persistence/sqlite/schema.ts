/**
 * Schema SQL — deriva do modelo `BumpTop.proto` original.
 * Roda dentro do Worker de persistência. Compartilhado p/ testes e migrações.
 *
 * Cada migração tem um número (schema_ver). Migrações aplicadas em ordem.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE scene (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        schema_ver    INTEGER NOT NULL,
        camera_json   TEXT NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE objects (
        id            TEXT PRIMARY KEY,
        kind          INTEGER NOT NULL,
        type_flags    INTEGER NOT NULL,
        parent_id     TEXT REFERENCES objects(id),
        px REAL, py REAL, pz REAL,
        qx REAL, qy REAL, qz REAL, qw REAL,
        vx REAL, vy REAL, vz REAL,
        scale         REAL DEFAULT 1.0,
        pinned_wall   INTEGER,
        frozen        INTEGER DEFAULT 0,
        label         TEXT,
        meta_json     TEXT
      );
      CREATE INDEX idx_objects_parent ON objects(parent_id);
      CREATE INDEX idx_objects_kind   ON objects(kind);

      CREATE TABLE piles (
        object_id  TEXT PRIMARY KEY REFERENCES objects(id),
        layout     INTEGER NOT NULL,
        pile_type  INTEGER NOT NULL,
        page       INTEGER DEFAULT 0
      );

      CREATE TABLE pile_children (
        pile_id    TEXT NOT NULL REFERENCES piles(object_id),
        child_id   TEXT NOT NULL REFERENCES objects(id),
        ord        INTEGER NOT NULL,
        saved_pose_json TEXT,
        PRIMARY KEY (pile_id, child_id)
      );

      CREATE TABLE fs_entries (
        object_id  TEXT PRIMARY KEY REFERENCES objects(id),
        mode       INTEGER NOT NULL,
        path       TEXT,
        name       TEXT NOT NULL,
        is_dir     INTEGER NOT NULL,
        size       INTEGER, mtime INTEGER,
        launch_count INTEGER DEFAULT 0,
        thumb      BLOB, thumb_mime TEXT
      );
      CREATE INDEX idx_fs_path ON fs_entries(path);

      CREATE TABLE settings    (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE theme_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
