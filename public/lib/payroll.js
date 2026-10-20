// 給与計算。顧問先のページ（入力・明細）と事務所のページ（仕訳）で同じ計算を使う
(function () {
  const n = v => Number(v) || 0;
  const sum = list => (list || []).reduce((t, x) => t + n(x.amount), 0);

  // 社会保険料・雇用保険料の被保険者負担分：50銭以下は切り捨て、50銭を超えたら切り上げ
  const r50 = x => { const sen = Math.round(x * 100), yen = Math.floor(sen / 100); return sen - yen * 100 > 50 ? yen + 1 : yen; };

  // 料率（%。雇用保険だけは労働者負担の千分率）。年度で変わるので、事務所の設定で入れる
  const DEFAULT_RATES = { health: '', care: '', kids: '', pension: 18.3, emp: '' };
  // 源泉所得税（月額表の甲欄）の電子計算機等による計算の特例で使う額（令和8年分）。告示で確かめて事務所の設定で直せる
  const DEFAULT_TAX = { kiso: 48334, fuyo: 31667, kyuyoMin: 54167 };
  const TAX_TABLE = [
    [162500, 0.05105, 0], [275000, 0.10210, 8296], [579166, 0.20420, 36374], [750000, 0.23483, 54113],
    [1500000, 0.33693, 130688], [3333333, 0.40840, 237893], [Infinity, 0.45945, 408061],
  ];

  // 給与所得控除の額（月額。1円未満切り上げ）
  function kyuyoKojo(A, P) {
    if (A <= 158333) return n(P.kyuyoMin);
    if (A <= 299999) return Math.ceil(A * 0.3 + 6667);
    if (A <= 549999) return Math.ceil(A * 0.2 + 36667);
    if (A <= 708330) return Math.ceil(A * 0.1 + 91667);
    return 162500;
  }
  // 基礎控除の額（月額）
  function kisoKojo(A, P) {
    if (A <= 2162499) return n(P.kiso);
    if (A <= 2204166) return 26667;
    if (A <= 2245833) return 13334;
    return 0;
  }
  // 甲欄：A は社会保険料等を差し引いたあとの給与の額。10円未満は四捨五入
  function withholdKou(A, deps, P) {
    P = { ...DEFAULT_TAX, ...P };
    if (A <= 0) return 0;
    const B = A - kyuyoKojo(A, P) - n(P.fuyo) * n(deps) - kisoKojo(A, P);
    if (B <= 0) return 0;
    const [, rate, ded] = TAX_TABLE.find(([max]) => B <= max);
    return Math.max(0, Math.round((B * rate - ded) / 10) * 10);
  }

  const TYPES = { monthly: '月給', hourly: '時給', daily: '日給' };

  // e：従業員（登録内容）、x：その月の入力、R：料率、P：源泉の計算の額
  // x.ov に入れた額は、計算の代わりにその額を使う（事務所や顧問先が直したとき）
  function calc(e, x, R, P) {
    x = x || {}; R = { ...DEFAULT_RATES, ...R };
    const ov = x.ov || {}, pick = (k, v) => ov[k] !== undefined && ov[k] !== '' ? n(ov[k]) : v;
    const type = e.type || 'monthly';
    const basePay = pick('basePay', type === 'hourly' ? Math.round(n(e.base) * n(x.hours)) : type === 'daily' ? Math.round(n(e.base) * n(x.days)) : n(e.base));
    const ot = pick('ot', Math.round(n(e.otRate) * n(x.otHours)));
    const allow = sum(e.allowances);
    const extraPay = n(x.extraPay);
    const commute = pick('commute', e.commuteType === 'day' ? n(e.commute) * n(x.days) : n(e.commute));
    const taxable = basePay + ot + allow + extraPay;
    const gross = taxable + commute;
    let health = 0, care = 0, kids = 0, pension = 0;
    if (e.shaho && n(e.std) > 0) {
      const std = n(e.std);
      // 介護保険の対象者は、健康保険と介護保険を合わせた料率で計算し、その中から介護分を分ける
      const both = r50(std * (n(R.health) + (e.care ? n(R.care) : 0)) / 200);
      care = e.care ? r50(std * n(R.care) / 200) : 0;
      health = both - care;
      kids = r50(std * n(R.kids) / 200);
      pension = r50(Math.min(Math.max(std, 88000), 650000) * n(R.pension) / 200);
    }
    health = pick('health', health); care = pick('care', care); kids = pick('kids', kids); pension = pick('pension', pension);
    const emp = pick('emp', e.koyo ? r50(gross * n(R.emp) / 1000) : 0);
    const shaho = health + care + kids + pension + emp;
    const col = e.col || '甲';
    const autoTax = col === '甲';
    const itax = pick('itax', autoTax ? withholdKou(taxable - shaho, e.deps, P) : n(x.itax));
    const rtax = pick('rtax', n(e.rtax));
    const fixedDed = sum(e.deductions), extraDed = n(x.extraDed);
    const otherDed = fixedDed + extraDed;
    const net = gross - shaho - itax - rtax - otherDed;
    return { type, basePay, ot, allow, extraPay, commute, taxable, gross, health, care, kids, pension, emp, shaho, col, autoTax, itax, rtax, fixedDed, extraDed, otherDed, net };
  }

  window.Payroll = { calc, withholdKou, r50, TYPES, DEFAULT_RATES, DEFAULT_TAX };
})();
