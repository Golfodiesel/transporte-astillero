/* Transporte de Personal · Astillero — prototipo PWA (chofer + supervisor) */
(function () {
  var C = window.CATALOGO, CFG = window.APP_CONFIG, $app = document.getElementById("app");
  var state = { view: null, viaje: null, prefs: null, watchId: null, lastPos: null, supervisorOk: false, periodo: "7", remoto: null };

  /* ---------- utilidades ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtHora(ts) { if (!ts) return "—"; var d = new Date(ts); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function fmtFecha(ts) { if (!ts) return "—"; var d = new Date(ts); return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" }); }
  function fmtNum(n, d) { return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("es-MX", { maximumFractionDigits: d == null ? 1 : d, minimumFractionDigits: 0 }); }
  function fmtMXN(n) { return (n == null || isNaN(n)) ? "—" : "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; }
  function minutosDesde(ts) { return Math.round((Date.now() - ts) / 60000); }
  function toast(msg, err) {
    var t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function haversineKm(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function getPos() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
      }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
    });
  }
  function metaMinutos(turno) {
    var h = (turno === "entrada" ? CFG.HORA_META_ENTRADA : CFG.HORA_META_SALIDA).split(":");
    return parseInt(h[0], 10) * 60 + parseInt(h[1], 10);
  }
  // Retraso en minutos del viaje respecto a la hora meta (negativo = adelantado)
  function retrasoMin(v) {
    var ts = v.turno === "entrada" ? v.llegada_ts : v.salida_ts;
    if (!ts) return null;
    var d = new Date(ts); return d.getHours() * 60 + d.getMinutes() - metaMinutos(v.turno);
  }
  function kmViaje(v) {
    if (v.odo_ini != null && v.odo_fin != null && v.odo_fin > v.odo_ini) return v.odo_fin - v.odo_ini;
    return v.km_gps || 0;
  }
  function guardarPrefs(p) { state.prefs = p; return DB.put("config", { id: "prefs", v: p }); }
  function dispositivo() { return (navigator.userAgent || "").slice(0, 80); }

  /* ---------- fotos ---------- */
  function leerFoto(file) {
    return new Promise(function (resolve) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1024, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url); resolve(cv.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }
  function fotoInput(id, label, fotoId) {
    return '<div class="photo" id="ph-' + id + '">' + (fotoId ? '<img alt="foto">' : esc(label)) +
      '<input type="file" accept="image/*" capture="environment" aria-label="' + esc(label) + '" data-foto="' + id + '"></div>';
  }
  function cargarPreview(id, fotoId) {
    if (!fotoId) return;
    DB.get("fotos", fotoId).then(function (f) { var el = document.querySelector("#ph-" + id + " img"); if (f && el) el.src = f.dataUrl; });
  }

  /* ---------- GPS en ruta ---------- */
  function iniciarSeguimiento() {
    if (!navigator.geolocation || state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(function (p) {
      var pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (pos.acc > 60) return;
      if (state.lastPos && state.viaje) {
        var d = haversineKm(state.lastPos, pos);
        if (d > 0.015 && d < 3) { state.viaje.km_gps = Math.round(((state.viaje.km_gps || 0) + d) * 100) / 100; DB.put("viajes", state.viaje); var el = document.getElementById("kmgps"); if (el) el.textContent = fmtNum(state.viaje.km_gps); }
      }
      state.lastPos = pos;
    }, function () {}, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  function detenerSeguimiento() { if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; } state.lastPos = null; }

  /* ---------- navegación ---------- */
  function nav(v) { location.hash = "#" + v; }
  function render() {
    var h = (location.hash || "#inicio").slice(1);
    if (!/^[a-z-]+$/.test(h)) h = "inicio";
    if (state.viaje && (h === "inicio")) h = "viaje";
    if (!state.viaje && (h === "viaje" || h === "llegada")) h = "inicio";
    state.view = h;
    var views = { inicio: vInicio, viaje: vViaje, llegada: vLlegada, combustible: vCombustible, historial: vHistorial, supervisor: vSupervisor };
    (views[h] || vInicio)();
  }
  function navBar(cur) {
    var items = [["viaje", "Viaje"], ["combustible", "Combustible"], ["historial", "Historial"], ["supervisor", "Supervisor"]];
    return '<div class="tabs">' + items.map(function (i) {
      var k = i[0] === "viaje" && !state.viaje ? "inicio" : i[0];
      return '<button class="btn' + ((cur === i[0] || (i[0] === "viaje" && cur === "inicio")) ? " sel" : "") + '" data-nav="' + k + '">' + i[1] + '</button>';
    }).join("") + "</div>";
  }
  function hdr(sub, titulo, extra, badge) {
    return '<div class="hdr"><div class="row"><div class="sub">' + esc(sub) + '</div>' + (badge || "") + '</div><h1>' + esc(titulo) + '</h1><div class="sub">' + (extra || "") + '</div></div>';
  }
  function opts(list, sel, key, lab) {
    return list.map(function (o) { var v = key ? o[key] : o, l = lab ? o[lab] : o; return '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + '>' + esc(l) + '</option>'; }).join("");
  }

  /* ---------- VISTA: inicio de viaje ---------- */
  function vInicio() {
    var p = state.prefs || {};
    var turno = p.turno || (new Date().getHours() < 12 ? "entrada" : "salida");
    $app.innerHTML = hdr("Chofer: " + (p.chofer_nombre || "sin asignar"), "Iniciar viaje", fmtFecha(Date.now()) + " · " + fmtHora(Date.now()) + ' · <span id="gpsst">buscando GPS…</span>') +
      '<div class="main">' + navBar("inicio") +
      '<div><label for="chofer">Chofer</label><select id="chofer">' + opts(C.choferes, p.chofer_id, "id", "nombre") + '</select></div>' +
      '<div><label for="unidad">Unidad</label><select id="unidad">' + opts(C.unidades, p.unidad_id, "id", "nombre") + '</select></div>' +
      '<div><label for="ruta">Ruta</label><select id="ruta">' + opts(C.rutas, p.ruta_id, "id", "nombre") + '</select></div>' +
      '<div><span class="lbl">Turno</span><div class="grp"><button class="btn' + (turno === "entrada" ? " sel" : "") + '" data-turno="entrada">Entrada</button><button class="btn' + (turno === "salida" ? " sel" : "") + '" data-turno="salida">Salida</button></div></div>' +
      '<div><label for="odo">Odómetro inicial (km)</label><input id="odo" class="big" inputmode="numeric" placeholder="148320"></div>' +
      '<div><span class="lbl">Foto del odómetro (opcional)</span>' + fotoInput("odoini", "Tomar foto", null) + '</div>' +
      '<div class="card"><h3>Se registra automáticamente</h3><div class="muted">Hora de salida · Ubicación GPS · Km recorridos por GPS</div></div>' +
      '</div><div class="foot"><button class="btn pri xl" id="btnIniciar">Iniciar viaje</button></div>';
    var sel = turno, fotoId = null;
    getPos().then(function (pos) { var el = document.getElementById("gpsst"); if (el) el.textContent = pos ? "GPS activo (±" + Math.round(pos.acc) + " m)" : "GPS no disponible"; });
    $app.querySelectorAll("[data-turno]").forEach(function (b) { b.onclick = function () { sel = b.dataset.turno; $app.querySelectorAll("[data-turno]").forEach(function (x) { x.classList.toggle("sel", x === b); }); }; });
    $app.querySelector('[data-foto="odoini"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-odoini"); ph.innerHTML = '<img src="' + du + '" alt="odómetro">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("btnIniciar").onclick = function () {
      var ch = C.choferes.filter(function (c) { return c.id === document.getElementById("chofer").value; })[0];
      var un = C.unidades.filter(function (u) { return u.id === document.getElementById("unidad").value; })[0];
      var ru = C.rutas.filter(function (r) { return r.id === document.getElementById("ruta").value; })[0];
      var odo = num(document.getElementById("odo").value);
      this.disabled = true; this.textContent = "Registrando…";
      getPos().then(function (pos) {
        var v = {
          id: DB.uid(), chofer_id: ch.id, chofer: ch.nombre, unidad_id: un.id, capacidad: un.capacidad, ruta_id: ru.id, ruta: ru.nombre, turno: sel,
          salida_ts: Date.now(), salida_lat: pos ? pos.lat : null, salida_lng: pos ? pos.lng : null, odo_ini: odo, foto_odo_ini: fotoId,
          paradas: ru.paradas.map(function (n) { return { nombre: n, ts: null, pax: 0, lat: null, lng: null }; }),
          pax_total: 0, km_gps: 0, km_odo: null, incidencias: [], estado: "en_ruta", synced: false, dispositivo: dispositivo()
        };
        return guardarPrefs({ chofer_id: ch.id, chofer_nombre: ch.nombre, unidad_id: un.id, ruta_id: ru.id, turno: sel }).then(function () { return DB.put("viajes", v); }).then(function () { state.viaje = v; iniciarSeguimiento(); nav("viaje"); });
      });
    };
    $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
  }

  /* ---------- VISTA: viaje en curso ---------- */
  function vViaje() {
    var v = state.viaje, idx = v.paradas.findIndex(function (p) { return p.ts == null; });
    var html = hdr(v.unidad_id + " · " + v.ruta_id + " " + (v.turno === "entrada" ? "Entrada" : "Salida"),
      "Salió " + fmtHora(v.salida_ts) + " · " + minutosDesde(v.salida_ts) + " min en ruta",
      v.turno === "entrada" ? "Llegada programada al astillero: " + CFG.HORA_META_ENTRADA : "Salida programada del astillero: " + CFG.HORA_META_SALIDA,
      '<span class="badge">EN RUTA</span>') +
      '<div class="main"><div class="kpis"><div class="kpi"><div class="l">Pasajeros</div><div class="v">' + v.pax_total + ' <span class="s">/ ' + v.capacidad + '</span></div></div><div class="kpi"><div class="l">Km (GPS)</div><div class="v" id="kmgps">' + fmtNum(v.km_gps) + '</div></div></div>' +
      '<span class="lbl">Paradas</span>';
    v.paradas.forEach(function (p, i) {
      if (i === idx) {
        html += '<div class="card act"><div class="stop"><div class="dot act"></div><div class="t"><b>' + (i + 1) + '. ' + esc(p.nombre) + '</b><span>Ahora · ' + fmtHora(Date.now()) + '</span></div></div>' +
          '<div class="counter"><button class="btn sq" id="menos" aria-label="Quitar pasajero">−</button><div class="n" id="cnt">0</div><button class="btn sq pri" id="mas" aria-label="Agregar pasajero">+</button></div>' +
          '<button class="btn sel" style="width:100%" id="confirmar">Confirmar parada</button></div>';
      } else {
        html += '<div class="card"><div class="stop"><div class="dot' + (p.ts ? " ok" : "") + '"></div><div class="t"><b>' + (i + 1) + '. ' + esc(p.nombre) + '</b><span>' + (p.ts ? fmtHora(p.ts) + " · " + p.pax + " pax" : "Pendiente") + '</span></div>' + (p.ts ? '<button class="link" data-edit="' + i + '">Editar</button>' : "") + '</div></div>';
      }
    });
    if (v.incidencias.length) html += '<div class="card warn"><h3>Incidencias</h3>' + v.incidencias.map(function (x) { return '<div class="small">' + fmtHora(x.ts) + " · " + esc(x.texto) + '</div>'; }).join("") + '</div>';
    html += '<div id="inc" style="display:none"><label for="inctxt">Describe la incidencia</label><textarea id="inctxt" placeholder="Ej. tráfico en puente, falla mecánica, pasajero sin credencial"></textarea><div class="grp" style="margin-top:8px"><button class="btn" id="incCancel">Cancelar</button><button class="btn pri" id="incSave">Guardar</button></div></div>';
    html += '</div><div class="foot"><button class="btn" style="flex:1" id="btnInc">Incidencia</button><button class="btn ok" style="flex:2;font-size:17px;font-weight:700" id="btnLlegar">' + (v.turno === "entrada" ? "Llegué al astillero" : "Llegué al destino") + '</button></div>';
    $app.innerHTML = html;
    var n = 0;
    if (idx >= 0) {
      document.getElementById("mas").onclick = function () { n++; document.getElementById("cnt").textContent = n; };
      document.getElementById("menos").onclick = function () { n = Math.max(0, n - 1); document.getElementById("cnt").textContent = n; };
      document.getElementById("confirmar").onclick = function () {
        var p = v.paradas[idx]; p.ts = Date.now(); p.pax = n; p.lat = state.lastPos ? state.lastPos.lat : null; p.lng = state.lastPos ? state.lastPos.lng : null;
        v.pax_total = v.paradas.reduce(function (s, x) { return s + (x.pax || 0); }, 0);
        if (v.pax_total > v.capacidad) toast("Atención: pasajeros superan la capacidad (" + v.capacidad + ")", true);
        DB.put("viajes", v).then(render);
      };
    }
    $app.querySelectorAll("[data-edit]").forEach(function (b) {
      b.onclick = function () { var i = +b.dataset.edit, p = v.paradas[i], nv = window.prompt("Pasajeros en " + p.nombre, p.pax); if (nv == null) return; p.pax = Math.max(0, parseInt(nv, 10) || 0); v.pax_total = v.paradas.reduce(function (s, x) { return s + (x.pax || 0); }, 0); DB.put("viajes", v).then(render); };
    });
    document.getElementById("btnInc").onclick = function () { document.getElementById("inc").style.display = "block"; document.getElementById("inctxt").focus(); };
    document.getElementById("incCancel").onclick = function () { document.getElementById("inc").style.display = "none"; };
    document.getElementById("incSave").onclick = function () { var t = document.getElementById("inctxt").value.trim(); if (!t) return; v.incidencias.push({ ts: Date.now(), texto: t }); DB.put("viajes", v).then(render); };
    document.getElementById("btnLlegar").onclick = function () { nav("llegada"); };
    iniciarSeguimiento();
  }

  /* ---------- VISTA: llegada ---------- */
  function vLlegada() {
    var v = state.viaje, pend = v.paradas.filter(function (p) { return !p.ts; }).length;
    $app.innerHTML = hdr(v.unidad_id + " · " + v.ruta_id, "Cerrar viaje", "Salida " + fmtHora(v.salida_ts) + " · " + v.pax_total + " pasajeros · " + fmtNum(v.km_gps) + " km GPS") +
      '<div class="main">' + (pend ? '<div class="card warn"><h3>' + pend + ' parada(s) sin confirmar</h3><div class="small">Se cerrarán con 0 pasajeros. Regresa si falta registrar.</div></div>' : "") +
      '<div><label for="odofin">Odómetro final (km)</label><input id="odofin" class="big" inputmode="numeric" placeholder="' + (v.odo_ini ? v.odo_ini + 25 : "148345") + '"></div>' +
      '<div><span class="lbl">Foto del odómetro (opcional)</span>' + fotoInput("odofin", "Tomar foto", null) + '</div>' +
      '<div class="card"><h3>Se registra automáticamente</h3><div class="muted">Hora de llegada · Ubicación GPS</div></div></div>' +
      '<div class="foot"><button class="btn" style="flex:1" id="volver">Volver</button><button class="btn ok" style="flex:2;font-size:17px;font-weight:700" id="cerrar">Confirmar llegada</button></div>';
    var fotoId = null;
    $app.querySelector('[data-foto="odofin"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-odofin"); ph.innerHTML = '<img src="' + du + '" alt="odómetro">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("volver").onclick = function () { nav("viaje"); };
    document.getElementById("cerrar").onclick = function () {
      var odo = num(document.getElementById("odofin").value);
      if (odo != null && v.odo_ini != null && odo < v.odo_ini) { toast("El odómetro final no puede ser menor al inicial", true); return; }
      this.disabled = true; this.textContent = "Guardando…";
      getPos().then(function (pos) {
        v.llegada_ts = Date.now(); v.llegada_lat = pos ? pos.lat : null; v.llegada_lng = pos ? pos.lng : null; v.odo_fin = odo; v.foto_odo_fin = fotoId;
        v.km_odo = (odo != null && v.odo_ini != null) ? odo - v.odo_ini : null; v.estado = "cerrado";
        return DB.put("viajes", v);
      }).then(function () {
        detenerSeguimiento(); state.viaje = null;
        var r = retrasoMin(v); toast("Viaje cerrado · " + (r == null ? "" : (r <= CFG.TOLERANCIA_MIN ? "a tiempo" : "+" + r + " min")));
        SYNC.push().then(function (res) { if (res.ok && res.enviados) toast("Sincronizado: " + res.enviados + " registro(s)"); });
        nav("historial");
      });
    };
  }

  /* ---------- VISTA: combustible ---------- */
  function vCombustible() {
    var p = state.prefs || {};
    $app.innerHTML = hdr((p.unidad_id || "Unidad") + " · " + (p.chofer_nombre || "Chofer"), "Carga de combustible", fmtFecha(Date.now()) + " · " + fmtHora(Date.now())) +
      '<div class="main">' + navBar("combustible") +
      '<div class="grp"><div style="flex:1"><label for="litros">Litros</label><input id="litros" class="big" inputmode="decimal" placeholder="62.4"></div><div style="flex:1"><label for="importe">Importe (MXN)</label><input id="importe" class="big" inputmode="decimal" placeholder="1622.40"></div></div>' +
      '<div><label for="unidadc">Unidad</label><select id="unidadc">' + opts(C.unidades, p.unidad_id, "id", "nombre") + '</select></div>' +
      '<div><label for="estacion">Estación</label><select id="estacion">' + opts(C.estaciones) + '</select></div>' +
      '<div><label for="odoc">Odómetro (km)</label><input id="odoc" class="big" inputmode="numeric" placeholder="148410"></div>' +
      '<div><span class="lbl">Foto del ticket</span>' + fotoInput("ticket", "Tomar foto", null) + '</div>' +
      '<div class="card" id="rend" style="display:none"></div>' +
      '</div><div class="foot"><button class="btn pri xl" id="guardar">Guardar carga</button></div>';
    var fotoId = null;
    $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
    $app.querySelector('[data-foto="ticket"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-ticket"); ph.innerHTML = '<img src="' + du + '" alt="ticket">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("guardar").onclick = function () {
      var litros = num(document.getElementById("litros").value), importe = num(document.getElementById("importe").value), odo = num(document.getElementById("odoc").value);
      if (!litros || !importe) { toast("Captura litros e importe", true); return; }
      var un = document.getElementById("unidadc").value, btn = this; btn.disabled = true;
      getPos().then(function (pos) {
        var c = { id: DB.uid(), chofer_id: p.chofer_id || null, chofer: p.chofer_nombre || null, unidad_id: un, ts: Date.now(), litros: litros, importe: importe, estacion: document.getElementById("estacion").value, odo: odo, foto_ticket: fotoId, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, synced: false };
        return DB.put("cargas", c);
      }).then(function () { return DB.all("cargas"); }).then(function (cs) {
        var mismas = cs.filter(function (c) { return c.unidad_id === un && c.odo != null; }).sort(function (a, b) { return a.ts - b.ts; });
        if (mismas.length >= 2) { var a = mismas[mismas.length - 2], b = mismas[mismas.length - 1]; var km = b.odo - a.odo; if (km > 0) toast("Rendimiento desde última carga: " + fmtNum(km / b.litros, 2) + " km/L"); else toast("Carga guardada"); }
        else toast("Carga guardada");
        SYNC.push();
        nav("historial");
      });
    };
  }

  /* ---------- VISTA: historial del chofer ---------- */
  function vHistorial() {
    Promise.all([DB.all("viajes"), DB.all("cargas")]).then(function (r) {
      var viajes = r[0].sort(function (a, b) { return b.salida_ts - a.salida_ts; }), cargas = r[1].sort(function (a, b) { return b.ts - a.ts; });
      var pend = viajes.filter(function (v) { return v.estado === "cerrado" && !v.synced; }).length + cargas.filter(function (c) { return !c.synced; }).length;
      var modo = SYNC.enabled() ? (pend ? '<span class="badge amb">' + pend + ' sin enviar</span>' : '<span class="badge">Sincronizado</span>') : '<span class="badge gris">Modo local</span>';
      var html = hdr("Historial", "Mis registros", viajes.length + " viajes · " + cargas.length + " cargas", modo) + '<div class="main">' + navBar("historial") +
        '<div class="grp">' + (SYNC.enabled() ? '<button class="btn pri" id="sync">Enviar ahora</button>' : "") + '<button class="btn" id="compartir">Compartir datos (JSON)</button></div>';
      viajes.slice(0, 30).forEach(function (v) {
        var r = retrasoMin(v), pill = v.estado !== "cerrado" ? '<span class="pill run">En ruta</span>' : (r == null ? "" : (r <= CFG.TOLERANCIA_MIN ? '<span class="pill ok">A tiempo</span>' : '<span class="pill late">+' + r + ' min</span>'));
        html += '<div class="card"><div class="stop"><div class="t"><b>' + fmtFecha(v.salida_ts) + " · " + esc(v.ruta_id) + " " + esc(v.turno) + " · " + esc(v.unidad_id) + '</b><span>' + fmtHora(v.salida_ts) + " → " + fmtHora(v.llegada_ts) + " · " + v.pax_total + " pax · " + fmtNum(kmViaje(v)) + " km" + (v.synced ? " · enviado" : "") + '</span></div>' + pill + '</div></div>';
      });
      if (cargas.length) { html += '<span class="lbl">Cargas</span>'; cargas.slice(0, 10).forEach(function (c) { html += '<div class="card"><div class="stop"><div class="t"><b>' + fmtFecha(c.ts) + " " + fmtHora(c.ts) + " · " + esc(c.unidad_id) + '</b><span>' + fmtNum(c.litros, 1) + " L · " + fmtMXN(c.importe) + " · " + esc(c.estacion) + '</span></div></div></div>'; }); }
      html += "</div>";
      $app.innerHTML = html;
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      var s = document.getElementById("sync"); if (s) s.onclick = function () { s.disabled = true; SYNC.push().then(function (res) { toast(res.ok ? "Enviados: " + res.enviados : "Error: " + res.error, !res.ok); render(); }); };
      document.getElementById("compartir").onclick = function () {
        var data = JSON.stringify({ exportado: new Date().toISOString(), viajes: viajes, cargas: cargas });
        var blob = new Blob([data], { type: "application/json" }), name = "transporte_" + new Date().toISOString().slice(0, 10) + ".json";
        var file = new File([blob], name, { type: "application/json" });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: "Datos de transporte" }).catch(function () {}); }
        else { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
      };
    });
  }

  /* ---------- VISTA: supervisor ---------- */
  function vSupervisor() {
    if (!state.supervisorOk) {
      $app.innerHTML = hdr("Acceso", "Supervisor", "Captura el PIN") + '<div class="main">' + navBar("supervisor") + '<div><label for="pin">PIN</label><input id="pin" class="big" type="password" inputmode="numeric"></div><button class="btn pri xl" id="entrar">Entrar</button></div>';
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      document.getElementById("entrar").onclick = function () { if (document.getElementById("pin").value === CFG.PIN_SUPERVISOR) { state.supervisorOk = true; render(); } else toast("PIN incorrecto", true); };
      return;
    }
    Promise.all([DB.all("viajes"), DB.all("cargas"), state.remoto ? Promise.resolve(state.remoto) : SYNC.pull()]).then(function (r) {
      var viajes = r[0], cargas = r[1], remoto = r[2];
      if (remoto) { state.remoto = remoto; var ids = {}; viajes.forEach(function (v) { ids[v.id] = 1; }); remoto.viajes.forEach(function (v) { if (!ids[v.id]) viajes.push(v); }); var cid = {}; cargas.forEach(function (c) { cid[c.id] = 1; }); remoto.cargas.forEach(function (c) { if (!cid[c.id]) cargas.push(c); }); }
      var dias = state.periodo === "todo" ? 36500 : parseInt(state.periodo, 10), desde = Date.now() - dias * 86400000;
      if (state.periodo === "hoy") { var d0 = new Date(); d0.setHours(0, 0, 0, 0); desde = d0.getTime(); }
      var V = viajes.filter(function (v) { return v.estado === "cerrado" && v.salida_ts >= desde; }).sort(function (a, b) { return b.salida_ts - a.salida_ts; });
      var K = cargas.filter(function (c) { return c.ts >= desde; });
      var n = V.length, aTiempo = V.filter(function (v) { var r = retrasoMin(v); return r != null && r <= CFG.TOLERANCIA_MIN; }).length;
      var pax = V.reduce(function (s, v) { return s + (v.pax_total || 0); }, 0), cap = V.reduce(function (s, v) { return s + (v.capacidad || 0); }, 0);
      var km = V.reduce(function (s, v) { return s + kmViaje(v); }, 0), litros = K.reduce(function (s, c) { return s + (c.litros || 0); }, 0), gasto = K.reduce(function (s, c) { return s + (c.importe || 0); }, 0);
      var unidades = {}; V.forEach(function (v) { unidades[v.unidad_id] = 1; });
      var porRuta = {}; V.forEach(function (v) { var o = porRuta[v.ruta_id] || (porRuta[v.ruta_id] = { pax: 0, cap: 0, n: 0, tarde: 0 }); o.pax += v.pax_total || 0; o.cap += v.capacidad || 0; o.n++; var r = retrasoMin(v); if (r != null && r > CFG.TOLERANCIA_MIN) o.tarde++; });
      function kpi(l, v, s, cls) { return '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s ' + (cls || "") + '">' + s + '</div></div>'; }
      var html = hdr("Transporte de personal · Astillero", "Dashboard", (remoto ? "Datos de todos los choferes (Supabase)" : "Datos de este dispositivo" + (SYNC.enabled() ? " · sin conexión al servidor" : " · modo local")), '<span class="badge gris">Supervisor</span>') +
        '<div class="main">' + navBar("supervisor") +
        '<div class="tabs">' + [["hoy", "Hoy"], ["7", "7 días"], ["30", "30 días"], ["todo", "Todo"]].map(function (p) { return '<button class="btn' + (state.periodo === p[0] ? " sel" : "") + '" data-per="' + p[0] + '">' + p[1] + '</button>'; }).join("") + '</div>' +
        '<div class="kpis">' +
        kpi("Puntualidad", n ? Math.round(100 * aTiempo / n) + "%" : "—", n ? (n - aTiempo) + " viaje(s) tarde de " + n : "sin viajes", n && aTiempo / n >= 0.95 ? "ok" : (n ? "bad" : "")) +
        kpi("Ocupación", cap ? Math.round(100 * pax / cap) + "%" : "—", fmtNum(pax, 0) + " pasajeros / " + n + " viajes") +
        kpi("Km recorridos", fmtNum(km, 0), Object.keys(unidades).length + " unidad(es)") +
        kpi("Rendimiento", litros ? fmtNum(km / litros, 2) + ' <span class="s">km/L</span>' : "—", fmtNum(litros, 0) + " L cargados", "") +
        kpi("Costo / pasajero", pax && gasto ? fmtMXN(gasto / pax) : "—", "Combustible " + fmtMXN(gasto)) + '</div>' +
        '<div class="two"><div class="card"><h3>Ocupación por ruta</h3>' + (Object.keys(porRuta).length ? Object.keys(porRuta).map(function (r) { var o = porRuta[r], pct = o.cap ? Math.round(100 * o.pax / o.cap) : 0; return '<div class="rowb"><span>' + esc(r) + ' (' + o.n + ')</span><div class="bar"><div class="' + (pct < 60 ? 'amb' : '') + '" style="width:' + pct + '%"></div></div><b>' + pct + '%</b></div>'; }).join("") : '<div class="muted">Sin datos en el periodo</div>') + '</div>' +
        '<div class="card"><h3>Retrasos por ruta</h3>' + (Object.keys(porRuta).length ? Object.keys(porRuta).map(function (r) { var o = porRuta[r], pct = o.n ? Math.round(100 * o.tarde / o.n) : 0; return '<div class="rowb"><span>' + esc(r) + '</span><div class="bar"><div class="amb" style="width:' + pct + '%"></div></div><b>' + o.tarde + '</b></div>'; }).join("") : '<div class="muted">Sin datos en el periodo</div>') + '</div></div>' +
        '<div class="card"><div class="row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Viajes</h3><div class="grp"><button class="link" id="csvV">Exportar CSV</button></div></div><div class="scroll"><table><thead><tr><th>Fecha</th><th>Unidad</th><th>Chofer</th><th>Ruta / turno</th><th>Salida</th><th>Llegada</th><th>Pax</th><th>Km</th><th>Estado</th></tr></thead><tbody>' +
        (V.length ? V.slice(0, 200).map(function (v) { var r = retrasoMin(v); return '<tr><td>' + fmtFecha(v.salida_ts) + '</td><td><b>' + esc(v.unidad_id) + '</b></td><td>' + esc(v.chofer) + '</td><td>' + esc(v.ruta_id) + " · " + esc(v.turno) + '</td><td>' + fmtHora(v.salida_ts) + '</td><td>' + fmtHora(v.llegada_ts) + '</td><td>' + v.pax_total + "/" + v.capacidad + '</td><td>' + fmtNum(kmViaje(v)) + '</td><td>' + (r == null ? "—" : (r <= CFG.TOLERANCIA_MIN ? '<span class="pill ok">A tiempo</span>' : '<span class="pill late">+' + r + ' min</span>')) + (v.incidencias && v.incidencias.length ? ' <span class="pill late">' + v.incidencias.length + ' inc.</span>' : "") + '</td></tr>'; }).join("") : '<tr><td colspan="9" class="muted">Sin viajes cerrados en el periodo</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Cargas de combustible</h3><button class="link" id="csvC">Exportar CSV</button></div><div class="scroll"><table><thead><tr><th>Fecha</th><th>Unidad</th><th>Chofer</th><th>Litros</th><th>Importe</th><th>$/L</th><th>Odómetro</th><th>Estación</th></tr></thead><tbody>' +
        (K.length ? K.sort(function (a, b) { return b.ts - a.ts; }).map(function (c) { return '<tr><td>' + fmtFecha(c.ts) + " " + fmtHora(c.ts) + '</td><td><b>' + esc(c.unidad_id) + '</b></td><td>' + esc(c.chofer) + '</td><td>' + fmtNum(c.litros, 1) + '</td><td>' + fmtMXN(c.importe) + '</td><td>' + fmtMXN(c.importe / c.litros) + '</td><td>' + fmtNum(c.odo, 0) + '</td><td>' + esc(c.estacion) + '</td></tr>'; }).join("") : '<tr><td colspan="8" class="muted">Sin cargas en el periodo</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><h3>Importar datos de otro celular (JSON)</h3><div class="small" style="margin-bottom:8px">Útil en modo local: el chofer comparte su archivo y aquí se consolida.</div><input type="file" accept="application/json,.json" id="imp" style="height:auto;padding:10px"></div>' +
        '<button class="link" id="salir">Cerrar sesión de supervisor</button></div>';
      $app.innerHTML = html;
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      $app.querySelectorAll("[data-per]").forEach(function (b) { b.onclick = function () { state.periodo = b.dataset.per; render(); }; });
      document.getElementById("salir").onclick = function () { state.supervisorOk = false; nav("inicio"); };
      document.getElementById("csvV").onclick = function () { descargarCSV("viajes", ["id", "fecha", "unidad", "chofer", "ruta", "turno", "salida", "llegada", "retraso_min", "pasajeros", "capacidad", "km", "km_gps", "odo_ini", "odo_fin", "paradas", "incidencias", "salida_lat", "salida_lng", "llegada_lat", "llegada_lng"], V.map(function (v) { return [v.id, new Date(v.salida_ts).toISOString().slice(0, 10), v.unidad_id, v.chofer, v.ruta_id, v.turno, fmtHora(v.salida_ts), fmtHora(v.llegada_ts), retrasoMin(v), v.pax_total, v.capacidad, kmViaje(v), v.km_gps, v.odo_ini, v.odo_fin, (v.paradas || []).map(function (p) { return p.nombre + ":" + p.pax; }).join(" | "), (v.incidencias || []).map(function (i) { return i.texto; }).join(" | "), v.salida_lat, v.salida_lng, v.llegada_lat, v.llegada_lng]; })); };
      document.getElementById("csvC").onclick = function () { descargarCSV("cargas", ["id", "fecha", "hora", "unidad", "chofer", "litros", "importe", "estacion", "odometro", "lat", "lng"], K.map(function (c) { return [c.id, new Date(c.ts).toISOString().slice(0, 10), fmtHora(c.ts), c.unidad_id, c.chofer, c.litros, c.importe, c.estacion, c.odo, c.lat, c.lng]; })); };
      document.getElementById("imp").onchange = function (e) {
        var f = e.target.files[0]; if (!f) return; var rd = new FileReader();
        rd.onload = function () { try { var d = JSON.parse(rd.result), n = 0; var ops = []; (d.viajes || []).forEach(function (v) { if (v && v.id) { ops.push(DB.put("viajes", v)); n++; } }); (d.cargas || []).forEach(function (c) { if (c && c.id) { ops.push(DB.put("cargas", c)); n++; } }); Promise.all(ops).then(function () { toast("Importados " + n + " registros"); render(); }); } catch (err) { toast("Archivo no válido", true); } };
        rd.readAsText(f);
      };
    });
  }
  function descargarCSV(nombre, cols, filas) {
    var q = function (x) { x = x == null ? "" : String(x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var csv = "﻿" + cols.join(",") + "\n" + filas.map(function (r) { return r.map(q).join(","); }).join("\n");
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = nombre + "_" + new Date().toISOString().slice(0, 10) + ".csv"; a.click();
  }

  /* ---------- arranque ---------- */
  function init() {
    Promise.all([DB.get("config", "prefs"), DB.all("viajes")]).then(function (r) {
      state.prefs = r[0] ? r[0].v : null;
      state.viaje = r[1].filter(function (v) { return v.estado === "en_ruta"; }).sort(function (a, b) { return b.salida_ts - a.salida_ts; })[0] || null;
      if (state.viaje) iniciarSeguimiento();
      window.addEventListener("hashchange", render);
      window.addEventListener("online", function () { SYNC.push(); });
      render();
    }).catch(function (e) { $app.innerHTML = '<div class="main"><div class="card warn"><h3>No se pudo abrir el almacenamiento local</h3><div class="small">' + esc(e && e.message) + '</div></div></div>'; });
  }
  window.APP = { render: render, state: state };
  init();
})();
