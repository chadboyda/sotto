// Fake WebSocket class for sideband tests. Records sends, lets tests push
// server events and closes. Mirrors the browser/undici EventTarget API subset
// the daemon uses (addEventListener, send, close, readyState).

export function createFakeWSClass() {
  class FakeWS {
    static instances = [];
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.sent = [];
      this.readyState = 0;
      this.listeners = {};
      this.closedByClient = false;
      FakeWS.instances.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
    // --- test controls ---
    open() { this.readyState = 1; this.emit("open", {}); }
    receive(obj) { this.emit("message", { data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
    serverClose(code = 1006) { this.readyState = 3; this.emit("close", { code }); }
    sentOfType(type) { return this.sent.filter((e) => e.type === type); }
    // --- client API ---
    send(s) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(s)); }
    close() {
      if (this.readyState === 3) return;
      this.closedByClient = true;
      this.readyState = 3;
      this.emit("close", { code: 1005 });
    }
  }
  FakeWS.last = () => FakeWS.instances[FakeWS.instances.length - 1];
  return FakeWS;
}
