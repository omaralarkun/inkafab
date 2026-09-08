/* =====================================================
   INKAFAB - admin.js  (versión estática, sin servidor)
   Login contra config.json ofuscado, CRUD de productos con
   Exportar/Importar, materiales/tarifas CSV, ventas en
   localStorage (ofuscadas).
   ===================================================== */

let productos = [];
const $ = id => document.getElementById(id);

/* ---------- Ofuscación (mismo algoritmo que app.js) ---------- */
const _OBF_KEY = 'INKAFAB#2026!claveDeDifusion';
function _obfXor(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length));
  return out;
}
function obfuscate(str) { return btoa(_obfXor(String(str))).split('').reverse().join(''); }
function deobfuscate(b64) {
  try { return _obfXor(atob(b64.split('').reverse().join(''))); } catch (e) { return ''; }
}

/* ---------- Vistas ---------- */
function showLogin() {
  $('loginView').style.display = 'block';
  $('panelView').style.display = 'none';
  $('adminPass').value = '';
}
function showPanel() {
  $('loginView').style.display = 'none';
  $('panelView').style.display = 'block';
}

/* ---------- Login (contra config.json ofuscado) ---------- */
async function doLogin() {
  const pass = $('adminPass').value;
  if (!pass) return;
  try {
    const r = await fetch('data/config.json');
    const cfg = r.ok ? await r.json() : {};
    const real = cfg.adminPassword ? deobfuscate(cfg.adminPassword) : 'inkafab2024';
    if (pass === real) {
      $('loginError').textContent = '';
      showPanel();
      loadAll();
    } else {
      $('loginError').textContent = 'Contraseña incorrecta.';
    }
  } catch (e) { $('loginError').textContent = 'No se pudo leer config.json.'; }
}

/* ---------- Productos ---------- */
async function loadProductos() {
  try {
    const r = await fetch('data/productos.json');
    const data = r.ok ? await r.json() : [];
    productos = Array.isArray(data) ? data : [];
  } catch (e) { productos = []; }
  renderProductos();
}
function renderProductos() {
  const tbody = $('productosTbody');
  if (!tbody) return;
  tbody.innerHTML = productos.length ? productos.map(p => `
    <tr>
      <td>${p.id}</td>
      <td>${p.name} ${p.image ? '<img src="' + p.image + '" class="mini-thumb">' : ''}</td>
      <td>${p.type}</td>
      <td>${p.material}</td>
      <td>S/. ${Number(p.price).toFixed(2)}</td>
      <td>${p.stock ?? 0}</td>
      <td>${Number(p.peso || 0).toFixed(2)}</td>
      <td>
        <button class="mini-btn" data-edit="${p.id}">Editar</button>
        <button class="mini-btn danger" data-del="${p.id}">Eliminar</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Sin productos.</td></tr>';

  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => showProductoForm(productos.find(x => x.id === Number(b.dataset.edit)))));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (confirm('¿Eliminar este producto?')) {
      productos = productos.filter(x => x.id !== Number(b.dataset.del));
      renderProductos();
    }
  }));
}
function newProductoForm() { showProductoForm({}); }

function showProductoForm(p) {
  const f = $('productoForm');
  f.style.display = 'block';
  f.innerHTML = `
    <h3>${p.id ? 'Editar producto #' + p.id : 'Nuevo producto'}</h3>
    <div class="form-grid">
      <div class="form-group"><label>Nombre</label><input id="pf-name" value="${p.name || ''}"></div>
      <div class="form-group"><label>Tipo</label><input id="pf-type" value="${p.type || 'decorativo'}"></div>
      <div class="form-group"><label>Categoría</label><input id="pf-category" value="${p.category || ''}"></div>
      <div class="form-group"><label>Descripción</label><input id="pf-desc" value="${p.desc || ''}"></div>
      <div class="form-group"><label>Material (id)</label><input id="pf-material" value="${p.material || 'pla'}"></div>
      <div class="form-group"><label>Precio (S/)</label><input type="number" id="pf-price" step="0.01" value="${p.price || 0}"></div>
      <div class="form-group"><label>Precio anterior</label><input type="number" id="pf-old" step="0.01" value="${p.oldPrice || ''}"></div>
      <div class="form-group"><label>Stock</label><input type="number" id="pf-stock" value="${p.stock ?? 0}"></div>
      <div class="form-group"><label>Peso (kg)</label><input type="number" id="pf-peso" step="0.001" value="${p.peso || 0}"></div>
      <div class="form-group"><label>Resolución (mm)</label><input type="number" id="pf-res" step="0.001" value="${p.resolucion || 0.2}"></div>
      <div class="form-group"><label>Ruta imagen</label><input id="pf-image" value="${p.image || 'assets/img/ejemplos/placeholder.svg'}"></div>
      <div class="form-group"><label>Características (separadas por |)</label><input id="pf-features" value="${(p.features || []).join(' | ')}"></div>
    </div>
    <div class="admin-toolbar">
      <button class="btn btn-primary" id="pf-save">Guardar producto</button>
      <button class="btn btn-secondary" id="pf-cancel">Cancelar</button>
    </div>`;

  $('pf-save').addEventListener('click', () => saveProductoForm(p.id));
  $('pf-cancel').addEventListener('click', () => { f.style.display = 'none'; });
}
function saveProductoForm(id) {
  const val = n => ($(n) || {}).value || '';
  const num = n => Number(val(n)) || 0;
  const obj = {
    name: val('pf-name'), type: val('pf-type'), category: val('pf-category'),
    desc: val('pf-desc'), material: val('pf-material') || 'pla',
    price: num('pf-price'), oldPrice: Number($('pf-old').value) || undefined,
    stock: num('pf-stock'), peso: num('pf-peso'), resolucion: num('pf-res') || 0.2,
    image: val('pf-image'),
    features: val('pf-features').split('|').map(s => s.trim()).filter(Boolean)
  };
  if (id) {
    const i = productos.findIndex(x => x.id === Number(id));
    if (i !== -1) productos[i] = { ...productos[i], ...obj };
  } else {
    obj.id = productos.length ? Math.max(...productos.map(x => x.id)) + 1 : 1;
    productos.push(obj);
  }
  renderProductos();
  $('productoForm').style.display = 'none';
}

/* Exportar & importar catálogo (estático: el admin sube el archivo al hosting) */
function exportProductos() {
  if (!productos.length) return alert('Sin productos para exportar.');
  download(JSON.stringify(productos, null, 2), 'productos.json', 'application/json');
}
function importProductos() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = () => {
    if (!inp.files[0]) return;
    inp.files[0].text().then(txt => {
      try {
        const arr = JSON.parse(txt);
        productos = Array.isArray(arr) ? arr : [];
        renderProductos();
        alert('Catálogo importado (' + productos.length + ' productos). Recuerda subirlo también al hosting para publicarlo.');
      } catch (e) { alert('JSON inválido'); }
    });
  };
  inp.click();
}

/* ---------- Ventas (localStorage ofuscado) ---------- */
function readVentas() {
  try {
    const arr = JSON.parse(localStorage.getItem('inkafab_ventas') || '[]');
    return arr.map(of => {
      try { return JSON.parse(deobfuscate(of)); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}
function writeVentas(lista) {
  localStorage.setItem('inkafab_ventas', JSON.stringify(lista.map(v => obfuscate(JSON.stringify(v)))));
}
const ESTADOS = ['pendiente', 'pagado', 'enviado', 'entregado'];
function loadVentas() { renderVentas(readVentas()); }
function renderVentas(ventas) {
  const tbody = $('ventasTable').querySelector('tbody');
  if (!tbody) return;
  tbody.innerHTML = ventas.length ? ventas.map(v => `
    <tr>
      <td><b>${v.orden}</b></td>
      <td>${v.fecha}</td>
      <td>${v.cliente}</td>
      <td>${v.whatsapp}</td>
      <td>${v.pago}</td>
      <td>${v.metodo_envio} · S/ ${Number(v.envio).toFixed(2)}</td>
      <td>S/ ${Number(v.total).toFixed(2)}</td>
      <td class="estado-col">
        <select class="estado-select" data-orden="${v.orden}">
          ${ESTADOS.map(s => `<option value="${s}" ${s === v.estado ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Sin ventas registradas (este dispositivo).</td></tr>';

  document.querySelectorAll('.estado-select').forEach(sel => sel.addEventListener('change', () => {
    const lista = readVentas();
    const v = lista.find(x => x.orden === sel.dataset.orden);
    if (v) { v.estado = sel.value; writeVentas(lista); loadVentas(); }
  }));
}
function exportVentas(kind) {
  const ventas = readVentas();
  if (!ventas.length) return alert('Sin ventas para exportar (este dispositivo).');
  let out;
  if (kind === 'json') out = JSON.stringify(ventas, null, 2);
  else {
    const cab = ['orden','fecha','cliente','whatsapp','pago','metodo_envio','direccion','items','peso_kg','subtotal','envio','total','estado'];
    out = cab.join(';') + '\n' + ventas.map(v => cab.map(c => ((v[c] ?? '').toString().replace(/;/g, ',')).replace(/\r?\n/g, ' ')).join(';')).join('\n');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain;charset=utf-8' }));
  a.download = 'ventas_' + Date.now() + '.' + kind;
  a.click();
}

/* ---------- Materiales (JSON) y Envíos (CSV) ---------- */
async function loadDatosConfig() {
  try {
    const m = await (await fetch('data/materiales.json')).text();
    const e = await (await fetch('data/envio.csv')).text();
    $('materialesJson').value = m;
    $('envioCsv').value = e;
  } catch (err) {}
}
function exportMateriales() {
  const txt = $('materialesJson').value;
  try { JSON.parse(txt); } catch (e) { return alert('El JSON de materiales no es válido. Revísalo antes de exportar.'); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'application/json;charset=utf-8' }));
  a.download = 'materiales.json';
  a.click();
}
function importMateriales() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = () => {
    if (!inp.files[0]) return;
    inp.files[0].text().then(txt => {
      try {
        const arr = JSON.parse(txt);
        if (!Array.isArray(arr)) throw new Error('Debe ser un array');
        $('materialesJson').value = JSON.stringify(arr, null, 2);
        alert('Materiales cargados en el editor. Usa "Exportar materiales.json" y sube el archivo al hosting para publicar.');
      } catch (e) { alert('JSON inválido'); }
    });
  };
  inp.click();
}
function exportEnvio() {
  const txt = $('envioCsv').value;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' }));
  a.download = 'envio.csv';
  a.click();
}

/* ---------- Init ---------- */
function loadAll() {
  loadProductos();
  loadVentas();
  loadDatosConfig();
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: type || 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
}

function init() {
  $('btnLogin').addEventListener('click', doLogin);
  $('adminPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('btnLogout').addEventListener('click', showLogin);
  $('btnNewProduct').addEventListener('click', newProductoForm);
  $('btnSaveProductos').addEventListener('click', () => {
    if (confirm('Guardar el catálogo descarga productos.json. Después súbelo al hosting para publicar los cambios.')) exportProductos();
  });
  $('btnImportProductos').addEventListener('click', importProductos);
  $('btnRefreshVentas').addEventListener('click', () => loadVentas());
  $('btnExportCSV').addEventListener('click', () => exportVentas('csv'));
  $('btnExportJSON').addEventListener('click', () => exportVentas('json'));
  $('btnSaveMateriales').addEventListener('click', exportMateriales);
  $('btnImportMateriales').addEventListener('click', importMateriales);
  $('btnSaveEnvio').addEventListener('click', exportEnvio);

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    const panel = $('tab-' + btn.dataset.tab);
    if (panel) panel.style.display = 'block';
  }));

  showLogin();
}
document.addEventListener('DOMContentLoaded', init);