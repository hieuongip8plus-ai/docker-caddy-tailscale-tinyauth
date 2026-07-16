// .work/verify/mock-rtdb.mjs
// Mock Firebase RTDB in-memory — cùng interface với firebase-admin/database mà
// orchestrator dùng: db.ref(path).{get,set,update,transaction,push,limitToLast,
// onDisconnect().update()}. Dùng để KIỂM CHỨNG THỰC THI election/handoff cục bộ
// khi KHÔNG có Firebase creds.
//
// KHÔNG phải firebase thật — chỉ mô phỏng đủ API mà code orchestrator gọi.
// Report sẽ ghi rõ đây là mock.

let COUNTER = 0;
function pushId() {
  // ID tăng dần theo thời gian (giống push key firebase, sort được).
  COUNTER += 1;
  return `-Mock${String(Date.now()).slice(-6)}${String(COUNTER).padStart(4, "0")}`;
}

function getByPath(root, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}
function setByPath(root, path, value) {
  const parts = path.split("/").filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export const ServerValue = { TIMESTAMP: "__SERVER_TIMESTAMP__" };

function resolveTimestamps(obj) {
  if (obj === ServerValue.TIMESTAMP || obj === "__SERVER_TIMESTAMP__") return Date.now();
  if (Array.isArray(obj)) return obj.map(resolveTimestamps);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveTimestamps(v);
    return out;
  }
  return obj;
}

export function makeMockDb() {
  const store = {};
  const disconnects = []; // { path, value } áp dụng khi "goOffline"

  function ref(path) {
    return {
      path,
      async get() {
        const val = clone(getByPath(store, path));
        return { val: () => (val === undefined ? null : val), key: path.split("/").pop() };
      },
      async set(value) {
        setByPath(store, path, resolveTimestamps(clone(value)));
      },
      async update(patch) {
        const cur = getByPath(store, path) || {};
        const merged = { ...cur, ...resolveTimestamps(clone(patch)) };
        setByPath(store, path, merged);
      },
      async transaction(updater) {
        const current = clone(getByPath(store, path));
        const next = updater(current === undefined ? null : current);
        if (next === undefined) {
          // abort
          return { committed: false, snapshot: { val: () => (current === undefined ? null : current) } };
        }
        const resolved = resolveTimestamps(next);
        setByPath(store, path, resolved);
        return { committed: true, snapshot: { val: () => resolved } };
      },
      push(value) {
        const id = pushId();
        const childPath = `${path}/${id}`;
        if (value !== undefined) setByPath(store, childPath, resolveTimestamps(clone(value)));
        return { key: id, async set(v) { setByPath(store, childPath, resolveTimestamps(clone(v))); } };
      },
      limitToLast(n) {
        return {
          async get() {
            const val = clone(getByPath(store, path)) || {};
            const keys = Object.keys(val).sort();
            const kept = keys.slice(-n);
            const out = {};
            for (const k of kept) out[k] = val[k];
            return { val: () => out };
          },
        };
      },
      onDisconnect() {
        return {
          async update(patch) {
            disconnects.push({ path, patch: clone(patch) });
          },
        };
      },
    };
  }

  return {
    ref,
    _store: store,
    // Mô phỏng node "chết đột ngột": áp dụng onDisconnect đã đăng ký.
    _triggerDisconnects() {
      for (const d of disconnects) {
        const cur = getByPath(store, d.path) || {};
        setByPath(store, d.path, { ...cur, ...resolveTimestamps(d.patch) });
      }
    },
    _dump() {
      return clone(store);
    },
  };
}
