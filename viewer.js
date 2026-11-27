// =====================================================================
//  첨부파일 뷰어: 엑셀(서식 그대로) · PDF 첫 페이지 썸네일
// =====================================================================
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

const MAX_ROWS = 500, MAX_COLS = 60;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let exceljsP = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!exceljsP) exceljsP = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = EXCELJS_URL;
    s.onload = () => res(window.ExcelJS); s.onerror = () => rej(new Error('엑셀 뷰어를 불러오지 못했습니다'));
    document.head.appendChild(s);
  });
  return exceljsP;
}

// ---------- 색상 (테마색 + 명도 보정) ----------
const INDEXED = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF','000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080','9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF','00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696','003366','339966','003300','333300','993300','993366','333399','333333'];
function themePalette(wb) {
  const xml = wb?.model?.themes?.theme1 || '';
  const get = (tag) => {
    const m = xml.match(new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`));
    if (!m) return null;
    const v = m[1].match(/(?:srgbClr val|lastClr)="([0-9A-Fa-f]{6})"/);
    return v ? v[1] : null;
  };
  // Excel 테마 인덱스 순서: lt1, dk1, lt2, dk2, accent1~6, hlink, folHlink
  return [get('lt1') || 'FFFFFF', get('dk1') || '000000', get('lt2') || 'E7E6E6', get('dk2') || '44546A',
          get('accent1') || '4472C4', get('accent2') || 'ED7D31', get('accent3') || 'A5A5A5', get('accent4') || 'FFC000',
          get('accent5') || '5B9BD5', get('accent6') || '70AD47', get('hlink') || '0563C1', get('folHlink') || '954F72'];
}
function applyTint(hex, tint) {
  if (!tint) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min; s = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  if (s === 0) r = g = b = l; else { const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function color(c, pal) {
  if (!c) return null;
  if (c.argb) return '#' + c.argb.slice(-6);
  if (c.theme !== undefined) return '#' + applyTint(pal[c.theme] || '000000', c.tint);
  if (c.indexed !== undefined) return c.indexed === 64 ? null : '#' + (INDEXED[c.indexed] || '000000');
  return null;
}

// ---------- 셀 서식 → CSS ----------
const BORDER = { thin: '1px solid', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed', dashDot: '1px dashed', dashDotDot: '1px dashed',
  mediumDashed: '2px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed', medium: '2px solid', thick: '3px solid', double: '3px double' };
function fontCss(f, pal, base = true) {
  if (!f) return '';
  let css = '';
  if (f.name && base) css += `font-family:'${f.name.replace(/'/g, '')}','Malgun Gothic',sans-serif;`;
  if (f.size) css += `font-size:${(f.size * 4 / 3).toFixed(1)}px;`;
  if (f.bold) css += 'font-weight:700;';
  if (f.italic) css += 'font-style:italic;';
  if (f.underline || f.strike) css += `text-decoration:${f.underline ? 'underline' : ''} ${f.strike ? 'line-through' : ''};`;
  const c = color(f.color, pal); if (c) css += `color:${c};`;
  return css;
}
function cellCss(cell, pal, merged) {
  const st = cell.style || {}; let css = fontCss(st.font, pal);
  const fill = st.fill;
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const c = color(fill.fgColor, pal) || color(fill.bgColor, pal); if (c) css += `background:${c};`;
  } else if (fill?.type === 'gradient' && fill.stops?.length) {
    const c = color(fill.stops[0].color, pal); if (c) css += `background:${c};`;
  }
  const a = st.alignment || {};
  const isNum = typeof cell.value === 'number' || cell.value instanceof Date || (cell.value && typeof cell.value === 'object' && typeof cell.value.result === 'number');
  const h = a.horizontal && a.horizontal !== 'general' ? a.horizontal : (isNum ? 'right' : 'left');
  css += `text-align:${h === 'centerContinuous' || h === 'distributed' ? 'center' : h === 'fill' || h === 'justify' ? 'left' : h};`;
  css += `vertical-align:${a.vertical === 'middle' || a.vertical === 'center' ? 'middle' : a.vertical === 'top' ? 'top' : 'bottom'};`;
  css += a.wrapText ? 'white-space:pre-wrap;word-break:break-all;' : 'white-space:pre;';
  if (a.indent) css += `padding-left:${3 + a.indent * 9}px;`;
  const b = merged || st.border || {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const s = b[side]; if (s?.style && BORDER[s.style]) css += `border-${side}:${BORDER[s.style]} ${color(s.color, pal) || '#000'};`;
  }
  return css;
}
function cellHtml(cell, pal) {
  const v = cell.value;
  if (v && typeof v === 'object' && Array.isArray(v.richText)) {
    return v.richText.map((r) => `<span style="${fontCss(r.font, pal, false)}">${esc(r.text)}</span>`).join('');
  }
  let t = '';
  try { t = cell.text; } catch { t = v == null ? '' : String(v); }
  if (v && typeof v === 'object' && v.hyperlink) return `<a href="${esc(v.hyperlink)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  return esc(t);
}

// ---------- 시트 → HTML (화면에 보이는 모양 그대로) ----------
function sheetHtml(ws, pal) {
  let maxR = Math.min(ws.rowCount || 0, MAX_ROWS), maxC = Math.min(ws.columnCount || 0, MAX_COLS);
  // 인쇄 영역이 있으면 그 범위를 기준으로
  const pa = ws.pageSetup?.printArea?.split(',')[0]?.replace(/\$/g, '');
  let r0 = 1, c0 = 1;
  if (pa && /^[A-Z]+\d+:[A-Z]+\d+$/.test(pa)) {
    const [s, e] = pa.split(':'); const tl = ws.getCell(s), br = ws.getCell(e);
    r0 = tl.row; c0 = tl.col; maxR = Math.min(br.row, r0 + MAX_ROWS - 1); maxC = Math.min(br.col, c0 + MAX_COLS - 1);
  }
  if (!maxR || !maxC) return { html: '<p class="xv-empty">빈 시트입니다.</p>', truncated: false };
  const truncated = (ws.rowCount || 0) > maxR && !pa;

  // 병합 셀
  const span = new Map(), covered = new Set();
  for (const m of ws.model.merges || []) {
    const [s, e] = m.split(':'); const a = ws.getCell(s), b = ws.getCell(e);
    span.set(`${a.row}:${a.col}`, { rs: b.row - a.row + 1, cs: b.col - a.col + 1, br: b });
    for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) if (r !== a.row || c !== a.col) covered.add(`${r}:${c}`);
  }
  const grid = ws.views?.[0]?.showGridLines !== false;
  const defH = ws.properties?.defaultRowHeight || 15;
  const cols = [];
  for (let c = c0; c <= maxC; c++) {
    const col = ws.getColumn(c); if (col.hidden) { cols.push(null); continue; }
    const w = col.width ?? ws.properties?.defaultColWidth ?? 8.43;
    cols.push(Math.max(2, Math.round(w * 7 + 5)));
  }
  let html = `<table class="xv ${grid ? 'grid' : ''}" style="width:${cols.reduce((s, w) => s + (w || 0), 0)}px"><colgroup>${cols.map((w) => w ? `<col style="width:${w}px">` : '').join('')}</colgroup><tbody>`;
  for (let r = r0; r <= maxR; r++) {
    const row = ws.getRow(r); if (row.hidden) continue;
    const h = Math.round((row.height || defH) * 4 / 3);
    html += `<tr style="height:${h}px">`;
    for (let c = c0; c <= maxC; c++) {
      if (!cols[c - c0]) continue;
      const key = `${r}:${c}`; if (covered.has(key)) continue;
      const cell = ws.getCell(r, c); let sp = span.get(key);
      // 엑셀처럼 긴 글자가 오른쪽 빈칸으로 넘쳐 보이게: 뒤쪽 빈칸(값·배경·테두리 없음)을 합쳐서 표시
      if (!sp && cell.value != null && cell.value !== '' && !cell.style?.alignment?.wrapText
          && typeof cell.value !== 'number' && !['center', 'right', 'centerContinuous'].includes(cell.style?.alignment?.horizontal)) {
        let k = c + 1;
        const blank = (cc) => {
          if (covered.has(`${r}:${cc}`) || span.has(`${r}:${cc}`) || !cols[cc - c0]) return false;
          const x = ws.getCell(r, cc), s2 = x.style || {};
          const hasFill = s2.fill?.type === 'pattern' && s2.fill.pattern && s2.fill.pattern !== 'none';
          const hasBorder = s2.border && Object.values(s2.border).some((b) => b?.style);
          return (x.value == null || x.value === '') && !hasFill && !hasBorder;
        };
        while (k <= maxC && blank(k)) k++;
        if (k > c + 1) { sp = { rs: 1, cs: k - c, br: ws.getCell(r, k - 1) }; for (let cc = c + 1; cc < k; cc++) covered.add(`${r}:${cc}`); }
      }
      // 병합 셀 테두리: 오른쪽/아래는 병합 끝 셀의 테두리 사용
      let mb = null;
      if (sp) { const tb = cell.style?.border || {}, bb = sp.br.style?.border || {}; mb = { top: tb.top, left: tb.left, right: bb.right || tb.right, bottom: bb.bottom || tb.bottom }; }
      html += `<td${sp ? ` rowspan="${Math.min(sp.rs, maxR - r + 1)}" colspan="${Math.min(sp.cs, maxC - c + 1)}"` : ''} style="${cellCss(cell, pal, mb)}">${cellHtml(cell, pal)}</td>`;
    }
    html += '</tr>';
  }
  return { html: html + '</tbody></table>', truncated };
}

// 엑셀 파일(ArrayBuffer) → 시트 목록 [{name, html, truncated}]
export async function renderWorkbook(buf, fileName) {
  if (/\.xlsx$|\.xlsm$/i.test(fileName)) {
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
      const pal = themePalette(wb);
      return wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden')
        .map((ws) => ({ name: ws.name, ...sheetHtml(ws, pal) }));
    } catch (e) { console.warn('ExcelJS 실패, 단순 보기로 전환', e); }
  }
  // .xls / .csv 또는 실패 시: 값만 표로
  const XLSX = await import(SHEETJS_URL);
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((n) => {
    const ws = wb.Sheets[n]; let truncated = false;
    if (ws['!ref']) { const r = XLSX.utils.decode_range(ws['!ref']); if (r.e.r >= MAX_ROWS) { truncated = true; r.e.r = MAX_ROWS - 1; ws['!ref'] = XLSX.utils.encode_range(r); } }
    return { name: n, truncated, html: ws['!ref'] ? XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }).replace('<table', '<table class="xv grid simple"') : '<p class="xv-empty">빈 시트입니다.</p>' };
  });
}

// PDF 첫 페이지 → canvas
let pdfjs = null;
export async function renderPdfThumb(url, canvas, width = 360) {
  if (!pdfjs) { pdfjs = await import(PDFJS_URL); pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; }
  const doc = await pdfjs.getDocument(url).promise;
  const page = await doc.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / v1.width });
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return doc.numPages;
}

// 날인 가이드: PDF(바이트)를 열고 특정 쪽을 캔버스에 그린다
export async function loadPdfBytes(bytes) {
  if (!pdfjs) { pdfjs = await import(PDFJS_URL); pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; }
  return pdfjs.getDocument({ data: bytes }).promise;
}
export async function renderPdfPage(doc, n, canvas, width = 360) {
  const page = await doc.getPage(n);
  const v0 = page.getViewport({ scale: 1 });
  const scale = (width * (window.devicePixelRatio || 1)) / v0.width;
  const vp = page.getViewport({ scale });
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.width = width + 'px'; canvas.style.height = Math.round(width * v0.height / v0.width) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return { w: v0.width, h: v0.height };
}
