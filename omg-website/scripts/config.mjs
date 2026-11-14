// Reading and writing the D1 database id in wrangler.toml. Pure functions, so
// the setup script and the pre-deploy check share one tested definition.

/** The id wrangler.toml ships with, before `npm run setup` fills in the real one. */
export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

const ID_LINE = /^(\s*database_id\s*=\s*)"([^"]*)"/m;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRealId = (id) => typeof id === 'string' && UUID.test(id) && id !== PLACEHOLDER_ID;

/** The database_id in `toml`, or null when there is none. */
export function readDatabaseId(toml) {
  const match = ID_LINE.exec(toml);
  return match ? match[2] : null;
}

/** `toml` with its database_id set to `id`. Refuses anything but a real id. */
export function setDatabaseId(toml, id) {
  if (!isRealId(id)) throw new Error(`Not a D1 database id: ${id}`);
  if (!ID_LINE.test(toml)) throw new Error('wrangler.toml has no database_id line');
  return toml.replace(ID_LINE, `$1"${id}"`);
}
