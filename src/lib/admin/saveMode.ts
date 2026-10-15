import type { SaveMode, SaveTarget } from './entitySave';

// Which way an editor saves (Admin v2 F5a, P-5). Every editor asks here, through
// `useEntitySave(target, id, { mode: saveModeFor(target) })`, so the day releases switch
// on (R12 fills in draft saving, R14 turns it on) this one function changes and no call
// site does. Until then every editor saves live: an explicit Save with version and 409.

export function saveModeFor(_target: SaveTarget): SaveMode {
  return 'live';
}
