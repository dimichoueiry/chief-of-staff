/* Session lifetime and command delivery, shared by the native bridge and tests. */
(function () {
  function create({ post, onStart, onStop, onResult, onError }) {
    let generation = 0;
    let session = null;
    let enabled = false;
    let sequence = 0;
    let pending = 0;
    let queue = Promise.resolve();
    const close = (id) => post("/api/live/stop", { session: id }).catch(() => {});
    return {
      get active() { return enabled; },
      get session() { return session; },
      async start() {
        if (enabled) return;
        enabled = true;
        const token = ++generation;
        try {
          const r = await post("/api/live/start", {});
          if (!enabled || token !== generation) { if (r.session) await close(r.session); return; }
          if (!r.session) throw new Error(r.error || "Couldn't start Live mode.");
          session = r.session;
          sequence = 0;
          pending = 0;
          queue = Promise.resolve();
          onStart(session);
        } catch (error) {
          if (token !== generation) return;
          this.stop();
          onError(error.message);
        }
      },
      stop() {
        const id = session;
        enabled = false;
        session = null;
        generation++;
        onStop();
        if (id) void close(id);
      },
      phrase(text, id, number) {
        if (!enabled || id !== session || number <= sequence) return Promise.resolve();
        sequence = number;
        if (pending >= 4) { onError("Please slow down and repeat that command."); return Promise.resolve(); }
        pending++;
        const token = generation;
        const task = queue.then(async () => {
          if (token !== generation) return;
          try {
            const result = await post("/api/live/command", { session: id, sequence: number, text });
            if (token === generation) onResult(text, result);
          } catch {
            if (token === generation) { this.stop(); onError("Connection lost. Turn Live on to try again."); }
          } finally {
            if (token === generation) pending--;
          }
        });
        queue = task;
        return task;
      },
    };
  }
  window.cosLive = { create };
})();
