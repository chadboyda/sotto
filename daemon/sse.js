// Server-sent events hub for the voice page (SPEC §6.12).
export class SseHub {
  constructor({ clock, pingMs = 15000, onChange } = {}) {
    this.clock = clock;
    this.clients = new Set();
    this.onChange = onChange;
    this.ping = clock.setInterval(() => this.write(": ping\n\n"), pingMs);
  }

  get count() { return this.clients.size; }

  /** Attach an HTTP response; `first` is sent immediately (the status message). */
  add(req, res, first) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    this.clients.add(res);
    if (first) res.write(`data: ${JSON.stringify(first)}\n\n`);
    const drop = () => {
      if (this.clients.delete(res)) this.onChange?.();
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
    this.onChange?.();
  }

  write(chunk) {
    for (const res of this.clients) {
      try { res.write(chunk); } catch { this.clients.delete(res); }
    }
  }

  broadcast(msg) {
    this.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  close() {
    this.clock.clearInterval(this.ping);
    for (const res of this.clients) try { res.end(); } catch { /* ignore */ }
    this.clients.clear();
  }
}
