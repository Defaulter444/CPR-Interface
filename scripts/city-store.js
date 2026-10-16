import { applyCityOperation, emptyCity, validateCity } from './city-model.js';

/** Serialized writes through native Foundry settings. No client-provided author/socket commands. */
export function createCityStore({ read, write, baseIds, authorize, newId }) {
  let pending = Promise.resolve();
  return {
    read: () => validateCity(read() ?? emptyCity(), baseIds),
    execute(op, payload, expectedRevision) {
      // Clone now: a caller cannot change the queued command after authorization.
      const snapshot = structuredClone(payload);
      const task = pending.then(async () => {
        authorize();
        const current = validateCity(read() ?? emptyCity(), baseIds);
        const next = applyCityOperation(current, op, snapshot, { isGM: true, baseIds, expectedRevision, newId: newId() });
        await write(next);
        return next;
      });
      pending = task.catch(() => {});
      return task;
    },
    flush: () => pending
  };
}
