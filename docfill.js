// 개설 서류 자동 작성: 원본 Word 양식({{이름표}})에 입력값을 채워 새 Word 파일을 만든다.
// 브라우저에서는 PizZip·Docxtemplater를 CDN에서 불러오고, 테스트에서는 node 모듈을 넘겨 쓴다.

const BOX = (on) => (on ? '■' : '□');
const s = (v) => (v == null ? '' : String(v).trim());

// 날짜 'YYYY-MM-DD' → '2026년 11월 27일' (비어 있으면 손으로 쓸 수 있게 빈칸)
export function krDate(d) {
  const m = s(d).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : '　　　　년　　　월　　　일';
}
function splitAddr(a) {
  a = s(a);
  if (a.length <= 24) return [a, ''];
  const cut = a.lastIndexOf(' ', 24);
  return cut > 8 ? [a.slice(0, cut), a.slice(cut + 1)] : [a, ''];
}
function age(birth, ref = new Date()) {
  const m = s(birth).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  let a = ref.getFullYear() - Number(m[1]);
  if (ref.getMonth() + 1 < Number(m[2]) || (ref.getMonth() + 1 === Number(m[2]) && ref.getDate() < Number(m[3]))) a--;
  return String(a);
}

// 보안서약서(개인) 작성 대상: 대표자 + 종업원 현황의 이름 (중복 제거)
export function staffList(d) {
  const names = [s(d.rep), ...(d.emps || []).map((e) => s(e.name))].filter(Boolean);
  return [...new Set(names)];
}

// 입력값 → Word 이름표 값
export function docData(d, opt = {}) {
  const now = opt.now || new Date();
  const y = now.getFullYear();
  const [addr1, addr2] = splitAddr(d.addr);
  const o = {
    agency: s(d.agency), rep: s(d.rep), bizno: s(d.bizno), addr: s(d.addr), addr1, addr2, zip: s(d.zip),
    tel: s(d.tel), fax: s(d.fax), mobile: s(d.mobile), email: s(d.email), homepage: s(d.homepage), open_date: s(d.open_date),
    biz_type: s(d.biz_type), biz_item: s(d.biz_item),
    own_buy: BOX(d.own === '매매'), own_rent: BOX(d.own === '임차'), area: s(d.area), lease_months: s(d.lease_months),
    deposit: s(d.deposit), emp_cnt: s(d.emp_cnt) || String((d.emps || []).filter((e) => s(e.name)).length || ''),
    oil_co: '', map_note: s(d.addr) ? `소재지: ${s(d.addr)}` : '',
    motive: s(d.motive), strategy: s(d.strategy),
    col_ins: BOX(d.col_type === '보증보험'), col_re: BOX(d.col_type === '부동산'),
    cv_name: s(d.cv_name) || s(d.rep), cv_eng: s(d.cv_eng), cv_addr: s(d.cv_addr),
    g_name: s(d.g_name), g_addr: s(d.g_addr), g_birth: krDate(d.g_birth).includes('　') ? '' : krDate(d.g_birth),
    bank: s(d.bank), branch: s(d.branch), holder: s(d.holder), account: s(d.account),
    mgr_dept: s(d.mgr_dept), mgr_name: s(d.mgr_name), mgr_tel: s(d.mgr_tel),
    date: krDate(d.doc_date), recv_date: opt.recvDate || '20　 .　 .　 .',
    y1: String(y), y2: String(y + 1), y3: String(y + 2),
    use_seal: !!d.use_seal && d.corp_type === '법인',   // 사용인감계는 법인만
    staff: (staffList(d).length ? staffList(d) : ['']).map((name) => ({ name, agency: s(d.agency), date: krDate(d.doc_date) })),
  };
  // PDF 출력용: 작성일 칸(년·월·일), 법인 여부(연대보증은 법인만)
  const dm_ = s(d.doc_date).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  Object.assign(o, { dy: dm_ ? dm_[1] : '', dm: dm_ ? String(Number(dm_[2])) : '', dd: dm_ ? String(Number(dm_[3])) : '', is_corp: d.corp_type === '법인' });
  if (!o.is_corp) Object.assign(o, { g_name: '', g_addr: '', g_birth: '' });
  // 간소화 신청서(v2) 항목
  Object.assign(o, {
    app_no: s(opt.appNo), addr_full: s(d.zip) ? `(${s(d.zip)}) ${s(d.addr)}` : s(d.addr),
    corp_p: BOX(d.corp_type === '개인'), corp_c: BOX(d.corp_type === '법인'),
    own_self: BOX(d.own === '자가' || d.own === '매매'),
    plan_text: s(d.plan_text) || [s(d.motive), s(d.strategy)].filter(Boolean).join('\n'),
    col_ins: BOX(d.col_type === '보증보험'), col_etc: BOX(d.col_type === '기타' || d.col_type === '부동산'),
    col_note: s(d.col_note) ? `(${s(d.col_note)})` : '', col_amt: s(d.col_amt) || s(d.ins_amt), col_date: s(d.col_date) || s(d.ins_date),
  });
  for (let i = 1; i <= 5; i++) { const x = (d.sols || [])[i - 1] || {}; o[`s${i}_cat`] = s(x.cat); o[`s${i}_name`] = s(x.name); o[`s${i}_mer`] = s(x.mer); }
  for (const k of ['pos', 'kiosk', 'tord', 'oil', 'etc']) { o[`${k}_sol`] = s(d[`${k}_sol`]); o[`${k}_mer`] = s(d[`${k}_mer`]); }
  const oils = d.oil_cos || [];
  for (const [k, n] of [['oil_hdo', 'HDO'], ['oil_gsc', 'GSC'], ['oil_ske', 'SKE'], ['oil_soil', 'S-oil'], ['oil_etc', '기타']]) o[k] = BOX(oils.includes(n));
  for (const k of ['org_sales', 'org_support', 'org_dev', 'org_ext']) o[k] = s(d[k]) || '　';
  for (let i = 1; i <= 10; i++) {
    const e = (d.emps || [])[i - 1] || {};
    for (const k of ['name', 'sex', 'birth', 'pos', 'duty', 'tel', 'mail']) o[`e${i}_${k}`] = s(e[k]);
  }
  for (let i = 1; i <= 5; i++) { const v = (d.vans || [])[i - 1] || {}; o[`v${i}_name`] = s(v.name); o[`v${i}_cnt`] = s(v.cnt); o[`v${i}_amt`] = s(v.amt); }
  for (let i = 1; i <= 3; i++) { const p = (d.plans || [])[i - 1] || {}; o[`p${i}_cnt`] = s(p.cnt); o[`p${i}_amt`] = s(p.amt); }
  for (const k of ['ins_amt', 'ins_period', 'ins_date', 're_kind', 're_owner', 're_rel', 're_loc', 're_area', 're_value', 're_prior', 're_amt']) o[k] = s(d[k]);
  const bm = s(d.cv_birth).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  o.cv_by = bm ? bm[1] : '　　　'; o.cv_bm = bm ? String(Number(bm[2])) : '　　'; o.cv_bd = bm ? String(Number(bm[3])) : '　　';
  o.cv_age = age(d.cv_birth, now) || '　　';
  o.cv_birth_kr = bm ? `${bm[1]}년 ${Number(bm[2])}월 ${Number(bm[3])}일 (만 ${o.cv_age}세)` : '';
  for (let i = 1; i <= 15; i++) {
    const c = (d.careers || [])[i - 1] || {};
    const m = s(c.ym).match(/^(\d{4})-?(\d{1,2})?/);
    o[`c${i}_y`] = m ? m[1] : ''; o[`c${i}_m`] = m && m[2] ? String(Number(m[2])) : '';
    o[`c${i}_t`] = s(c.t); o[`c${i}_n`] = s(c.n); o[`c${i}_ym`] = s(c.ym);
  }
  return o;
}

// 템플릿(ArrayBuffer) + 값 → 완성된 Word(Blob 또는 Uint8Array)
export function fillDocx(PizZip, Docxtemplater, buf, data, asNode = false) {
  const zip = new PizZip(buf);
  // 조직도(SmartArt)는 docxtemplater가 다루지 않아 직접 바꾼다
  for (const f of Object.keys(zip.files)) {
    if (!/^word\/diagrams\/(data|drawing)\d+\.xml$/.test(f)) continue;
    const x = zip.file(f).asText().replace(/\{\{(\w+)\}\}/g, (_, k) => xmlEsc(data[k] ?? ''));
    zip.file(f, x);
  }
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true, nullGetter: () => '',
  });
  doc.render(data);
  return doc.getZip().generate(asNode ? { type: 'nodebuffer', compression: 'DEFLATE' }
    : { type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
const xmlEsc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
