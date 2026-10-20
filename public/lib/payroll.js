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

  // 標準報酬月額の等級表（健康保険 1〜50等級。厚生年金は 88,000円〜650,000円の 1〜32等級）。[標準報酬月額, 報酬月額の下限（以上）]
  const STD_TABLE = [[58000, 0], [68000, 63000], [78000, 73000], [88000, 83000], [98000, 93000], [104000, 101000], [110000, 107000], [118000, 114000], [126000, 122000], [134000, 130000], [142000, 138000], [150000, 146000], [160000, 155000], [170000, 165000], [180000, 175000], [190000, 185000], [200000, 195000], [220000, 210000], [240000, 230000], [260000, 250000], [280000, 270000], [300000, 290000], [320000, 310000], [340000, 330000], [360000, 350000], [380000, 370000], [410000, 395000], [440000, 425000], [470000, 455000], [500000, 485000], [530000, 515000], [560000, 545000], [590000, 575000], [620000, 605000], [650000, 635000], [680000, 665000], [710000, 695000], [750000, 730000], [790000, 770000], [830000, 810000], [880000, 855000], [930000, 905000], [980000, 955000], [1030000, 1005000], [1090000, 1055000], [1150000, 1115000], [1210000, 1175000], [1270000, 1235000], [1330000, 1295000], [1390000, 1355000]];
  const STD_GRADES = STD_TABLE.map(([std, lo], i) => {
    const hi = STD_TABLE[i + 1]?.[1] || null;
    // 厚生年金は 88,000円未満は1等級、650,000円を超えると32等級で計算する
    const pen = std < 88000 ? 1 : std > 650000 ? 32 : i - 2;
    return { std, lo, hi, health: i + 1, pension: pen };
  });
  // 報酬月額から等級を探す
  const gradeFor = pay => STD_GRADES.find(g => pay >= g.lo && (g.hi === null || pay < g.hi)) || STD_GRADES[0];

  // 年齢での判定。「〇歳に達した日」は誕生日の前日（年齢計算に関する法律）。月は 'YYYY-MM'
  const ymOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const shiftYM = (m, k) => { const [y, mo] = m.split('-').map(Number); return ymOf(new Date(y, mo - 1 + k, 1)); };
  function reachMonth(birth, age, onBirthday) {
    const [y, mo, d] = birth.split('-').map(Number);
    const day = new Date(y + age, mo - 1, d);
    if (day.getMonth() !== mo - 1) day.setDate(0);   // 2月29日生まれで、うるう年でない年
    if (!onBirthday) day.setDate(day.getDate() - 1);
    return ymOf(day);
  }
  // 保険料の月（pm）に、どの保険の対象か。介護 40歳到達月〜65歳到達月の前月、厚生年金 70歳到達月の前月まで、
  // 健康保険（介護・子ども・子育て支援金を含む）は75歳の誕生日の月の前月まで（後期高齢者医療へ移る）
  function ageFlags(birth, pm) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth || '') || !pm) return null;
    const health = pm < reachMonth(birth, 75, true);
    return {
      health,
      care: health && reachMonth(birth, 40) <= pm && pm < reachMonth(birth, 65),
      pension: pm < reachMonth(birth, 70),
    };
  }
  // 締め日と支払う月から、支給の月（m）の賃金の計算期間を出す。closeDay 0 は末日締め、payLag 1 は翌月払い
  const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
  const pad = v => String(v).padStart(2, '0');
  function period(m, c) {
    const close = n(c?.closeDay), E = shiftYM(m, -n(c?.payLag));
    let from, to;
    if (!close) { from = `${E}-01`; to = `${E}-${pad(daysIn(E))}`; }
    else { const S = shiftYM(E, -1); from = `${S}-${pad(Math.min(close + 1, daysIn(S)))}`; to = `${E}-${pad(Math.min(close, daysIn(E)))}`; }
    const jp = d => { const [, mo, dd] = d.split('-').map(Number); return `${mo}月${dd}日`; };
    return { from, to, label: `${jp(from)}〜${jp(to)}` };
  }
  // 支給日（payDay 0 は末日）
  const payDate = (m, c) => `${m}-${pad(n(c?.payDay ?? 25) ? Math.min(n(c?.payDay ?? 25), daysIn(m)) : daysIn(m))}`;
  const ruleText = c => `${n(c?.closeDay) ? `${n(c.closeDay)}日` : '末日'}締め・${n(c?.payLag) ? '翌月' : '当月'}${n(c?.payDay ?? 25) ? `${n(c?.payDay ?? 25)}日` : '末日'}払い`;

  function ageAt(birth, date) {
    const [y, mo, d] = birth.split('-').map(Number), [Y, M, D] = date.split('-').map(Number);
    return Y - y - ((M < mo || (M === mo && D < d)) ? 1 : 0);
  }

  // e：従業員（登録内容）、x：その月の入力、R：料率、P：源泉の計算の額、opt：{ month 支給の月, lag 社会保険料を前月分で引くなら1 }
  // x.ov に入れた額は、計算の代わりにその額を使う（事務所や顧問先が直したとき）
  function calc(e, x, R, P, opt) {
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
    // 生年月日があれば年齢で判定する。なければ登録のチェック（介護の対象か）を使う
    const pm = opt?.month ? shiftYM(opt.month, -(n(opt.lag))) : null;
    const age = ageFlags(e.birth, pm) || { health: true, care: !!e.care, pension: true };
    if (e.shaho && n(e.std) > 0) {
      const std = n(e.std);
      if (age.health) {
        // 介護保険の対象者は、健康保険と介護保険を合わせた料率で計算し、その中から介護分を分ける
        const both = r50(std * (n(R.health) + (age.care ? n(R.care) : 0)) / 200);
        care = age.care ? r50(std * n(R.care) / 200) : 0;
        health = both - care;
        kids = r50(std * n(R.kids) / 200);
      }
      if (age.pension) pension = r50(Math.min(Math.max(std, 88000), 650000) * n(R.pension) / 200);
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
    return { age, premMonth: pm, type, basePay, ot, allow, extraPay, commute, taxable, gross, health, care, kids, pension, emp, shaho, col, autoTax, itax, rtax, fixedDed, extraDed, otherDed, net };
  }

  window.Payroll = { period, payDate, ruleText, STD_GRADES, gradeFor, calc, withholdKou, r50, ageFlags, ageAt, TYPES, DEFAULT_RATES, DEFAULT_TAX };
})();
