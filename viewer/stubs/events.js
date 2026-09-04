/* A browser stand-in for node's `events`.
 *
 * RECOVERED, not written: transcribed from `web/viewer.js` on 2026-09-02, where it
 * survived the 2026-09-01 tree deletion in minified form. The bundle even names this
 * file, in the sibling `url` stub's error message.
 *
 * `@kitware/vtk.js` pulls in `xmlbuilder2`, whose `XMLBuilderCBImpl` extends
 * `EventEmitter`. Nothing in the viewer emits an event through it, so this needs to be
 * exactly the surface `xmlbuilder2` touches and no more -- and the surface it touches
 * is these six methods. Do not "complete" it with `off`, `prependListener` or
 * `setMaxListeners`: adding exports changes the bundle's export table, which is one of
 * the fingerprints `check-bundle.mjs` compares against the shipped artifact.
 *
 * `emit` returns false when there are no listeners, and iterates a COPY of the list so
 * a listener that removes itself cannot corrupt the iteration.
 */
export class EventEmitter {
  constructor() {
    this._l = new Map();
  }

  on(e, n) {
    (this._l.get(e) || this._l.set(e, []).get(e)).push(n);
    return this;
  }

  once(e, n) {
    const r = (...i) => {
      this.removeListener(e, r);
      n(...i);
    };
    return this.on(e, r);
  }

  removeListener(e, n) {
    const r = this._l.get(e);
    if (r) this._l.set(e, r.filter((i) => i !== n));
    return this;
  }

  removeAllListeners(e) {
    if (e == null) this._l.clear();
    else this._l.delete(e);
    return this;
  }

  emit(e, ...n) {
    const r = this._l.get(e);
    if (!r || !r.length) return false;
    r.slice().forEach((i) => i(...n));
    return true;
  }

  listenerCount(e) {
    return (this._l.get(e) || []).length;
  }
}

export default { EventEmitter };
