// Almacenamiento local (IndexedDB) con API de promesas.
// Stores: viajes, cargas, fotos, config
window.DB = (function () {
  var NAME = "transporte_astillero", VERSION = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        ["viajes", "cargas", "fotos", "config"].forEach(function (s) {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        try { out = fn(s); } catch (err) { reject(err); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function reqToPromise(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var s = d.transaction(store, mode).objectStore(store), r = fn(s);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  return {
    put: function (store, obj) { return tx(store, "readwrite", function (s) { s.put(obj); }).then(function () { return obj; }); },
    get: function (store, id) { return reqToPromise(store, "readonly", function (s) { return s.get(id); }); },
    all: function (store) { return reqToPromise(store, "readonly", function (s) { return s.getAll(); }); },
    del: function (store, id) { return tx(store, "readwrite", function (s) { s.delete(id); }); },
    clear: function (store) { return tx(store, "readwrite", function (s) { s.clear(); }); },
    uid: function () { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  };
})();
