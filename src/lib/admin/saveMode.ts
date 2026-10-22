import type { SaveMode, SaveTarget } from './entitySave';

// Which way an editor starts saving (Admin v2 F5a, P-5). Every editor asks here, through
// `useEntitySave(target, id, { mode: saveModeFor(target) })`. Since R12 the server decides
// from its first answer on: a release-managed route with releases on answers its row with a
// `draft` key and the editor saves pending changes; releases off, no answer carries it and
// the editor saves live, an explicit Save with version and 409, exactly as before. So R14
// switches releases on in the database and no call site (and not this function) changes;
// this is only the mode before the first answer, which matters for nothing but a new record
// (a create is an explicit Save either way).

export function saveModeFor(_target: SaveTarget): SaveMode {
  return 'live';
}
