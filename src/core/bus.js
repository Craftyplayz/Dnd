// Tiny synchronous event bus. Event names and payloads are listed in docs/CONTRACT.md section 6.
export function createBus() {
  const map = new Map();
  return {
    on(event, fn) {
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => map.get(event).delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(map.get(event) || [])]) {
        try { fn(payload); } catch (e) { console.error(`bus handler for ${event} failed`, e); }
      }
    },
  };
}
