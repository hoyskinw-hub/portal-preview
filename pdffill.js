// 출력용 PDF 양식(templates/*.pdf) 위에 입력값을 그려 완성 PDF를 만든다. 워드 없이 브라우저에서 바로 처리.
// lib: { PDFDocument, rgb, fontkit } / layout: make_pdf_templates.py 가 만든 위치표(JSON)

function fitText(font, text, size, maxW, min = 5.5) {
  let s = size;
  while (s > min && font.widthOfTextAtSize(text, s) > maxW) s -= 0.25;
  return s;
}
function wrap(font, text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (font.widthOfTextAtSize(line + ch, size) > maxW && line) { out.push(line); line = ch.trim() ? ch : ''; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

// 인쇄용 묶음: 계약서는 부수만큼 이어서 넣고(보관용 표시), 나머지는 1부. 인쇄는 항상 1부·단면.
export const COPY_LABELS = ['본사 보관용', '대리점 보관용', '연대보증인 보관용'];
export function copiesOf(k, data) {
  return ({ c_main: data.is_corp ? 3 : 2, c_fee: 2, c_ddc: 2, c_lease: 2 })[k] || 1;
}
// plan: 출력할 원본 쪽 순서 [{ src, vals, doc, copy, label }]
//  opt.bundle: 부수 반영 / opt.only: 특정 서류 키만
export function pagePlan(layout, data, opt = {}) {
  const docs = [...(layout.docs || [])].sort((a, b) => a.from - b.from);
  const staff = data.staff?.length ? data.staff : [{ name: '' }];
  const plan = [];
  for (const d of docs) {
    if (d.k === 'f_seal' && !data.use_seal) continue;
    if (d.k === 'f_guar' && !data.is_corp) continue;
    if (opt.only && !opt.only.includes(d.k)) continue;
    const range = Array.from({ length: d.to - d.from + 1 }, (_, i) => d.from + i);
    if (d.k === 'f_secp') { for (const st of staff) for (const p of range) plan.push({ src: p, vals: st, doc: d.k, copy: 0, label: '' }); continue; }
    const n = opt.bundle ? copiesOf(d.k, data) : 1;
    for (let c = 0; c < n; c++) for (const p of range) plan.push({ src: p, vals: {}, doc: d.k, copy: c, label: n > 1 ? COPY_LABELS[c] : '' });
  }
  if (!docs.length) for (let i = 0; i < layout.pages.length; i++) plan.push({ src: i, vals: {}, doc: '', copy: 0, label: '' });
  return plan;
}

export async function buildPdf(lib, tplBytes, layout, fontBytes, data, title = '', opt = {}) {
  const { PDFDocument, rgb, fontkit } = lib;
  const tpl = await PDFDocument.load(tplBytes);
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(fontBytes, { subset: false })   // 부분 내장은 한글이 빠지는 문제가 있어 전체 내장;
  const black = rgb(0, 0, 0);
  const byPage = {};
  for (const f of layout.fields) (byPage[f.p] ||= []).push(f);
  const plan = pagePlan(layout, data, opt);
  const pages = await out.copyPages(tpl, plan.map((x) => x.src));   // 한 번에 복사해야 글꼴·이미지가 중복되지 않음
  for (let i = 0; i < plan.length; i++) {
    const { src, vals, label } = plan[i], pg = pages[i];
    out.addPage(pg);
    if (label) {   // 계약서 보관용 표시 (오른쪽 위 여백)
      const { width, height } = pg.getSize(), sz = 8.5, tw = font.widthOfTextAtSize(label, sz);
      pg.drawRectangle({ x: width - tw - 34, y: height - 30, width: tw + 12, height: 15, borderColor: rgb(0.35, 0.35, 0.35), borderWidth: 0.6 });
      pg.drawText(label, { x: width - tw - 28, y: height - 25.5, size: sz, font, color: rgb(0.2, 0.2, 0.2) });
    }
    for (const f of byPage[src] || []) {
      const v = vals[f.k] ?? data[f.k];
      if (v == null || v === '') continue;
      if (f.box) { if (v === '■') pg.drawText('■', { x: f.x, y: f.y, size: f.s, font, color: black }); continue; }
      const text = String(v).replace(/\r/g, '');
      const base = Math.min(f.s, 13);
      const maxW = Math.max(f.w || 100, 10);
      const fits = (sz) => font.widthOfTextAtSize(text, sz) <= maxW;
      // 여러 줄: 줄바꿈이 있는 값, 또는 칸에 값만 있고 한 줄에 넣으면 글자가 너무 작아지는 경우
      const hh = f.h || base * 3;   // 아래 선이 없으면 두 줄까지
      const canWrap = f.solo && hh > base * 2.3;
      if (canWrap && (text.includes('\n') || !fits(base * 0.78))) {
        const sz = text.includes('\n') ? base : base * 0.88, lh = sz * 1.3;
        const maxLines = Math.max(1, Math.floor((hh - 2) / lh));
        const lines = wrap(font, text, sz, maxW).slice(0, maxLines);
        const y0 = text.includes('\n') || lines.length > 2 ? f.y - sz * 0.9 : f.y + (lines.length - 1) * lh / 2 - sz * 0.36;
        lines.forEach((ln, i) => pg.drawText(ln, { x: f.x, y: y0 - i * lh, size: sz, font, color: black }));
        continue;
      }
      const s = fitText(font, text.replace(/\n/g, ' '), base, maxW);
      const tw = font.widthOfTextAtSize(text, s);
      let x = f.x;
      if (f.a === 'g') x = f.x + Math.max(0, (maxW - tw) / 2);
      else if (f.a === 'c') x = f.x - tw / 2;
      else if (f.a === 'r') x = f.x - tw;
      pg.drawText(text, { x, y: f.solo ? f.y - s * 0.36 : f.y, size: s, font, color: black });
    }
  }
  out.setTitle(title); out.setProducer('KICC 파트너센터'); out.setCreator('KICC 채널영업2팀');
  return out.save();
}

// 날인 가이드용: 출력 PDF에서 서류별 쪽 범위(1부터) { 키: { from, to, copies: [{ from, to, label }] } }
export function docPages(layout, data, offset = 0, opt = {}) {
  const plan = pagePlan(layout, data, opt);
  const out = {};
  plan.forEach(({ doc, copy, label }, i) => {
    if (!doc) return;
    const n = offset + i + 1;
    const d = out[doc] ||= { from: n, to: n, copies: [] };
    d.from = Math.min(d.from, n); d.to = Math.max(d.to, n);
    const c = d.copies[copy] ||= { from: n, to: n, label };
    c.from = Math.min(c.from, n); c.to = Math.max(c.to, n);
  });
  return { pages: out, count: plan.length };
}
