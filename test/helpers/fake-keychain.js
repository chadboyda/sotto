// In-memory stand-in for apikey.js createKeychain(): the unit tests never
// touch the real macOS Keychain through the daemon harness.
export function createFakeKeychain({ available = true, key = null, failSet = false } = {}) {
  return {
    available,
    key,
    sets: 0,
    removes: 0,
    get() { return available ? this.key : null; },
    set(k) {
      this.sets++;
      if (!available) return { ok: false, message: "unavailable" };
      if (failSet) return { ok: false, message: "The Keychain refused the key." };
      this.key = k;
      return { ok: true };
    },
    remove() {
      this.removes++;
      const had = this.key !== null;
      this.key = null;
      return { ok: true, removed: had };
    },
  };
}
