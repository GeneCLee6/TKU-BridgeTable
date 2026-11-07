import { isBid, levelOf, strainOf, type Call } from '../../auction.ts'
import { SUIT_SYMBOL, SUITS, type Strain } from '../../cards.ts'
import type { Lang } from '../../messages.ts'
import { ANY, type Convention, type Forcing, type Note, type NoteKey, type Quality, type Range, type Spec, type Stop } from './spec.ts'

/**
 * Words for what a call shows, in every language of the site: the convention's name, extra notes,
 * then the hand features in GIB's order (suit lengths, suit quality, high-card points, total
 * points, shape, stoppers, controls, keycards, forcing). We write our own words; nothing here is
 * copied from BBO (docs/BBO GIB/README.md).
 */

type Words = Record<Lang, string>

const NAMES: Record<Convention, Words> = {
  stayman: { zh: 'Stayman', 'zh-Hans': 'Stayman', en: 'Stayman', vi: 'Stayman', ja: 'ステイマン', ko: '스테이먼' },
  smolen: { zh: 'Smolen', 'zh-Hans': 'Smolen', en: 'Smolen', vi: 'Smolen', ja: 'スモーレン', ko: '스몰렌' },
  transfer: { zh: 'Jacoby Transfer', 'zh-Hans': 'Jacoby Transfer', en: 'Jacoby Transfer', vi: 'Jacoby Transfer', ja: 'Jacoby Transfer', ko: 'Jacoby Transfer' },
  superAccept: { zh: '超接受', 'zh-Hans': '超接受', en: 'Super-accept', vi: 'Siêu chấp nhận', ja: 'スーパーアクセプト', ko: '슈퍼 억셉트' },
  texas: { zh: 'Texas Transfer', 'zh-Hans': 'Texas Transfer', en: 'Texas Transfer', vi: 'Texas Transfer', ja: 'Texas Transfer', ko: 'Texas Transfer' },
  minorStayman: { zh: 'Minor Stayman', 'zh-Hans': 'Minor Stayman', en: 'Minor Stayman', vi: 'Minor Stayman', ja: 'Minor Stayman', ko: 'Minor Stayman' },
  gerber: { zh: 'Gerber', 'zh-Hans': 'Gerber', en: 'Gerber', vi: 'Gerber', ja: 'ガーバー', ko: '거버' },
  quantitative: { zh: 'Quantitative Invitational', 'zh-Hans': 'Quantitative Invitational', en: 'Quantitative Invitational', vi: 'Quantitative Invitational', ja: 'Quantitative Invitational', ko: 'Quantitative Invitational' },
  jacoby2N: { zh: 'Jacoby 2NT', 'zh-Hans': 'Jacoby 2NT', en: 'Jacoby 2NT', vi: 'Jacoby 2NT', ja: 'ジャコビー2NT', ko: '자코비 2NT' },
  splinter: { zh: 'Splinter', 'zh-Hans': '斯普林特', en: 'Splinter', vi: 'Splinter', ja: 'スプリンター', ko: '스플린터' },
  limitRaise: { zh: 'Limit Raise', 'zh-Hans': 'Limit Raise', en: 'Limit Raise', vi: 'Limit Raise', ja: 'Limit Raise', ko: 'Limit Raise' },
  preemptiveRaise: { zh: 'Preemptive Raise', 'zh-Hans': 'Preemptive Raise', en: 'Preemptive Raise', vi: 'Preemptive Raise', ja: 'Preemptive Raise', ko: 'Preemptive Raise' },
  invertedMinor: { zh: 'Inverted Minor Raise', 'zh-Hans': 'Inverted Minor Raise', en: 'Inverted Minor Raise', vi: 'Inverted Minor Raise', ja: 'Inverted Minor Raise', ko: 'Inverted Minor Raise' },
  shortSuitTry: { zh: '短門 Game 試探', 'zh-Hans': '短门 Game 试探', en: 'Short-suit Game Try', vi: 'Thử Game hoa ngắn', ja: 'ショートスーツ・Game トライ', ko: '숏 수트 Game 트라이' },
  longSuitTry: { zh: '長門 Game 試探', 'zh-Hans': '长门 Game 试探', en: 'Long-suit Game Try', vi: 'Thử Game hoa dài', ja: 'ロングスーツ・Game トライ', ko: '롱 수트 Game 트라이' },
  generalTry: { zh: '一般 Game 試探', 'zh-Hans': '一般 Game 试探', en: 'General Game Try', vi: 'Thử Game chung', ja: 'ジェネラル・Game トライ', ko: '일반 Game 트라이' },
  askShortness: { zh: '詢問短門', 'zh-Hans': '询问短门', en: 'Shortness ask', vi: 'Hỏi hoa ngắn', ja: 'ショートネス・アスク', ko: '숏니스 질문' },
  drury: { zh: 'Reverse Drury', 'zh-Hans': 'Reverse Drury', en: 'Reverse Drury', vi: 'Reverse Drury', ja: 'リバース・ドルーリー', ko: '리버스 드루리' },
  soloway: { zh: 'Soloway Jump Shift', 'zh-Hans': 'Soloway Jump Shift', en: 'Soloway Jump Shift', vi: 'Soloway Jump Shift', ja: 'Soloway Jump Shift', ko: 'Soloway Jump Shift' },
  fitJump: { zh: 'Fit Jump', 'zh-Hans': 'Fit Jump', en: 'Fit Jump', vi: 'Fit Jump', ja: 'Fit Jump', ko: 'Fit Jump' },
  newMinorForcing: { zh: 'New Minor Forcing', 'zh-Hans': 'New Minor Forcing', en: 'New Minor Forcing', vi: 'New Minor Forcing', ja: 'New Minor Forcing', ko: 'New Minor Forcing' },
  fourthSuit: { zh: 'Fourth Suit Forcing', 'zh-Hans': 'Fourth Suit Forcing', en: 'Fourth Suit Forcing', vi: 'Fourth Suit Forcing', ja: 'Fourth Suit Forcing', ko: 'Fourth Suit Forcing' },
  reverse: { zh: '反序', 'zh-Hans': '逆序', en: 'Reverse', vi: 'Kêu đảo', ja: 'リバース', ko: '리버스' },
  strong2C: { zh: '強 2♣', 'zh-Hans': '强 2♣', en: 'Strong 2♣', vi: '2♣ mạnh', ja: '強い2♣', ko: '강한 2♣' },
  waiting: { zh: '等待叫', 'zh-Hans': '等待叫', en: 'Waiting', vi: 'Chờ', ja: 'ウェイティング', ko: '웨이팅' },
  doubleNegative: { zh: '二次否定', 'zh-Hans': '二次否定', en: 'Double negative', vi: 'Phủ định kép', ja: 'ダブル・ネガティブ', ko: '더블 네거티브' },
  weakTwo: { zh: '弱二', 'zh-Hans': '弱二', en: 'Weak two', vi: 'Weak two', ja: 'ウィークツー', ko: '위크 투' },
  featureAsk: { zh: '詢問特徵', 'zh-Hans': '询问特征', en: 'Feature ask', vi: 'Hỏi đặc điểm', ja: 'フィーチャー・アスク', ko: '피처 질문' },
  feature: { zh: '特徵', 'zh-Hans': '特征', en: 'Feature', vi: 'Đặc điểm', ja: 'フィーチャー', ko: '피처' },
  preempt: { zh: 'Preempt', 'zh-Hans': 'Preempt', en: 'Preempt', vi: 'Preempt', ja: 'Preempt', ko: 'Preempt' },
  overcall: { zh: 'Overcall', 'zh-Hans': 'Overcall', en: 'Overcall', vi: 'Overcall', ja: 'Overcall', ko: 'Overcall' },
  weakJumpOvercall: { zh: 'Weak Jump Overcall', 'zh-Hans': 'Weak Jump Overcall', en: 'Weak Jump Overcall', vi: 'Weak Jump Overcall', ja: 'Weak Jump Overcall', ko: 'Weak Jump Overcall' },
  weakJumpShift: { zh: 'Weak Jump Shift', 'zh-Hans': 'Weak Jump Shift', en: 'Weak Jump Shift', vi: 'Weak Jump Shift', ja: 'Weak Jump Shift', ko: 'Weak Jump Shift' },
  takeout: { zh: 'Takeout Double', 'zh-Hans': 'Takeout Double', en: 'Takeout Double', vi: 'Takeout Double', ja: 'Takeout Double', ko: 'Takeout Double' },
  negative: { zh: 'Negative Double', 'zh-Hans': 'Negative Double', en: 'Negative Double', vi: 'Negative Double', ja: 'Negative Double', ko: 'Negative Double' },
  responsive: { zh: 'Responsive Double', 'zh-Hans': 'Responsive Double', en: 'Responsive Double', vi: 'Responsive Double', ja: 'Responsive Double', ko: 'Responsive Double' },
  support: { zh: 'Support Double', 'zh-Hans': 'Support Double', en: 'Support Double', vi: 'Support Double', ja: 'Support Double', ko: 'Support Double' },
  penalty: { zh: 'Penalty Double', 'zh-Hans': 'Penalty Double', en: 'Penalty Double', vi: 'Penalty Double', ja: 'Penalty Double', ko: 'Penalty Double' },
  michaels: { zh: 'Michaels Cuebid', 'zh-Hans': 'Michaels Cuebid', en: 'Michaels Cuebid', vi: 'Michaels Cuebid', ja: 'Michaels Cuebid', ko: 'Michaels Cuebid' },
  unusual2N: { zh: '不尋常 2NT', 'zh-Hans': '不寻常 2NT', en: 'Unusual 2NT', vi: '2NT bất thường', ja: 'アンユージュアル2NT', ko: '언유주얼 2NT' },
  cappelletti: { zh: 'Cappelletti', 'zh-Hans': 'Cappelletti', en: 'Cappelletti', vi: 'Cappelletti', ja: 'カペレッティ', ko: '카펠레티' },
  sandwich: { zh: '夾擊 1NT', 'zh-Hans': '夹击 1NT', en: 'Sandwich 1NT', vi: '1NT kẹp', ja: 'サンドイッチ1NT', ko: '샌드위치 1NT' },
  lebensohl: { zh: '雷本索', 'zh-Hans': 'Lebensohl', en: 'Lebensohl', vi: 'Lebensohl', ja: 'レーベンゾール', ko: '레벤졸' },
  truscott: { zh: 'Truscott 2NT', 'zh-Hans': 'Truscott 2NT', en: 'Truscott 2NT', vi: 'Truscott 2NT', ja: 'トラスコット2NT', ko: '트러스콧 2NT' },
  cueRaise: { zh: 'Cuebid Raise', 'zh-Hans': 'Cuebid Raise', en: 'Cuebid Raise', vi: 'Cuebid Raise', ja: 'Cuebid Raise', ko: 'Cuebid Raise' },
  unusualVsUnusual: { zh: '對抗不尋常 2NT', 'zh-Hans': '对抗不寻常 2NT', en: 'Unusual vs. Unusual', vi: 'Chống 2NT bất thường', ja: 'アンユージュアル対策', ko: '언유주얼 대응' },
  rkcb: { zh: 'RKCB 0314', 'zh-Hans': 'RKCB 0314', en: 'RKCB 0314', vi: 'RKCB 0314', ja: 'RKCB 0314', ko: 'RKCB 0314' },
  keycards: { zh: '回答關鍵張', 'zh-Hans': '回答关键张', en: 'Keycard answer', vi: 'Trả lời quân chủ chốt', ja: 'キーカードの回答', ko: '키카드 응답' },
  queenAsk: { zh: '詢問 Trump Q', 'zh-Hans': '询问 Trump Q', en: 'Trump queen ask', vi: 'Hỏi Q Trump', ja: 'Trump Q のアスク', ko: 'Trump Q 질문' },
  kingAsk: { zh: '詢問 K', 'zh-Hans': '询问 K', en: 'King ask', vi: 'Hỏi K', ja: 'キングアスク', ko: '킹 질문' },
  rkcb1430: { zh: 'RKCB 1430', 'zh-Hans': 'RKCB 1430', en: 'RKCB 1430', vi: 'RKCB 1430', ja: 'RKCB 1430', ko: 'RKCB 1430' },
  ekb: { zh: 'EKB（除外問 A）', 'zh-Hans': 'EKB（除外问 A）', en: 'Exclusion keycard', vi: 'Exclusion keycard', ja: 'エクスクルージョン・キーカード', ko: '익스클루전 키카드' },
  blackwood: { zh: '黑木問 A', 'zh-Hans': '黑木问 A', en: 'Blackwood', vi: 'Blackwood', ja: 'ブラックウッド', ko: '블랙우드' },
  grandSlamForce: { zh: 'Grand Slam Force', 'zh-Hans': 'Grand Slam Force', en: 'Grand Slam Force', vi: 'Grand Slam Force', ja: 'Grand Slam Force', ko: 'Grand Slam Force' },
  sos: { zh: 'SOS Redouble', 'zh-Hans': 'SOS Redouble', en: 'SOS Redouble', vi: 'SOS Redouble', ja: 'SOS Redouble', ko: 'SOS Redouble' },
  dopi: { zh: 'DOPI', 'zh-Hans': 'DOPI', en: 'DOPI', vi: 'DOPI', ja: 'DOPI', ko: 'DOPI' },
  cue: { zh: 'Cuebid', 'zh-Hans': 'Cuebid', en: 'Cuebid', vi: 'Cuebid', ja: 'Cuebid', ko: 'Cuebid' },
  relay: { zh: '接力', 'zh-Hans': '接力', en: 'Relay', vi: 'Chuyển tiếp', ja: 'リレー', ko: '릴레이' },
  j2n: { zh: 'J2N', 'zh-Hans': 'J2N', en: 'J2N (Jacoby 2NT)', vi: 'J2N (Jacoby 2NT)', ja: 'J2N（ジャコビー2NT）', ko: 'J2N (자코비 2NT)' },
  bergen: { zh: 'Bergen Raise', 'zh-Hans': 'Bergen Raise', en: 'Bergen Raise', vi: 'Bergen Raise', ja: 'Bergen Raise', ko: 'Bergen Raise' },
  oneMajorWeakTwo: { zh: '一門 Major 的弱二', 'zh-Hans': '一门 Major 的弱二', en: 'Weak two in a Major', vi: 'Weak two một Major', ja: 'どちらかの Major のウィークツー', ko: 'Major 하나의 위크 투' },
  twoSuiter: { zh: '雙套', 'zh-Hans': '双套', en: 'Two-suiter', vi: 'Hai hoa dài', ja: 'ツースーター', ko: '투 수터' },
  minorAsk: { zh: '詢問 Minor', 'zh-Hans': '询问 Minor', en: 'Minor ask', vi: 'Hỏi Minor', ja: 'Minor のアスク', ko: 'Minor 질문' },
  passOrCorrect: { zh: 'P/C', 'zh-Hans': 'P/C', en: 'Pass or correct', vi: 'Pass hoặc sửa', ja: 'Pass or correct', ko: 'Pass or correct' },
  ask: { zh: '詢問', 'zh-Hans': '询问', en: 'Asking bid', vi: 'Hỏi', ja: 'アスク', ko: '질문' },
  strongClub: { zh: '強 1♣', 'zh-Hans': '强 1♣', en: 'Strong 1♣', vi: '1♣ mạnh', ja: '強い1♣', ko: '강한 1♣' },
  clubNegative: { zh: 'Negative Response', 'zh-Hans': 'Negative Response', en: 'Negative Response', vi: 'Negative Response', ja: 'Negative Response', ko: 'Negative Response' },
  shortDiamonds: { zh: '♦ 短門的三門牌', 'zh-Hans': '♦ 短门的三门牌', en: 'Three-suiter, short diamonds', vi: 'Ba hoa, ♦ ngắn', ja: '♦ショートのスリースーター', ko: '♦ 숏 쓰리 수터' },
  gambling3N: { zh: '賭博性 3NT', 'zh-Hans': '赌博性 3NT', en: 'Gambling 3NT', vi: '3NT đánh liều', ja: 'ギャンブリング3NT', ko: '갬블링 3NT' },
}

const QUALITY: Record<Quality, Words> = {
  biddable: { zh: '可叫', 'zh-Hans': '可叫', en: 'biddable', vi: 'đủ để kêu', ja: 'ビッダブル', ko: '비더블' },
  rebiddable: { zh: 'Rebiddable', 'zh-Hans': 'Rebiddable', en: 'Rebiddable', vi: 'Rebiddable', ja: 'Rebiddable', ko: 'Rebiddable' },
  twiceRebiddable: { zh: 'Twice Rebiddable', 'zh-Hans': 'Twice Rebiddable', en: 'Twice Rebiddable', vi: 'Twice Rebiddable', ja: 'Twice Rebiddable', ko: 'Twice Rebiddable' },
  strongRebiddable: { zh: 'Strong Rebiddable', 'zh-Hans': 'Strong Rebiddable', en: 'Strong Rebiddable', vi: 'Strong Rebiddable', ja: 'Strong Rebiddable', ko: 'Strong Rebiddable' },
  solid: { zh: '堅強', 'zh-Hans': '坚强', en: 'solid', vi: 'vững chắc', ja: 'ソリッド', ko: '솔리드' },
}

const STOP: Record<Stop, Words> = {
  partial: { zh: '半擋', 'zh-Hans': '半挡', en: 'partial stop', vi: 'chặn một phần', ja: '部分ストッパー', ko: '부분 스토퍼' },
  likely: { zh: '可能有擋', 'zh-Hans': '可能有挡', en: 'likely stop', vi: 'có thể có chặn', ja: 'ストッパーの可能性', ko: '스토퍼 가능성' },
  stop: { zh: '有擋', 'zh-Hans': '有挡', en: 'stop', vi: 'có chặn', ja: 'ストッパー', ko: '스토퍼' },
  double: { zh: '雙擋', 'zh-Hans': '双挡', en: 'two stops', vi: 'hai chặn', ja: 'ダブルストッパー', ko: '더블 스토퍼' },
}

interface Grammar {
  sep: string
  or: string
  named: (name: string, rest: string) => string
  len: (range: string, suit: string) => string
  quality: (quality: string, suit: string) => string
  stop: (stop: string, suit: string) => string
  hcp: (range: string) => string
  tp: (range: string) => string
  controls: (range: string) => string
  keycards: (counts: string) => string
  balanced: readonly [string, string]
  trumpQueen: readonly [string, string]
  forcing: Record<Forcing, string>
  artificial: string
  /** Leads what the player had already shown (`Spec.before`, Z1), on its own line */
  before: string
  notes: Record<NoteKey, (n: { s: string; c: string[]; counts: string }) => string>
}

const zh: Grammar = {
  sep: '，',
  or: ' 或 ',
  named: (name, rest) => (rest ? `${name}：${rest}` : name),
  len: (r, s) => `${r} 張${s}`,
  quality: (q, s) => `${s} ${q}`,
  stop: (st, s) => `${s} ${st}`,
  hcp: (r) => `${r} 大牌點`,
  tp: (r) => `${r} 總點`,
  controls: (r) => `${r} 控制`,
  keycards: (c) => `${c} 張關鍵張`,
  balanced: ['平均牌型', '非平均牌型'],
  trumpQueen: ['有 Trump Q', '沒有 Trump Q'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  artificial: '人工叫',
  before: '已表示：',
  notes: {
    asksMajor: () => '詢問 4 張 Major',
    fourMajor: () => '有 4 張以上的 Major',
    noMajor: () => '沒有 4 張 Major',
    noMinor: () => '沒有 4 張 Minor',
    transferTo: ({ s }) => `Transfer 到${s}`,
    completes: () => '完成 Transfer',
    relayTo: ({ c }) => `請同伴叫 ${c[0]}`,
    choiceOf: ({ c }) => `請同伴選 ${c.join(' 或 ')}`,
    shortIn: ({ s }) => `${s}單張或缺門`,
    shortSomewhere: () => '某一門單張或缺門',
    noShortness: () => '沒有單張或缺門',
    asksShortness: () => '詢問短門在哪一門',
    tryIn: ({ s }) => `${s}需要幫助`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => '打這個 Contract',
    slamTry: () => 'Slam 試探',
    slamInterest: () => '有 Slam 興趣',
    bothMajors: () => '兩門 Major',
    bothMinors: () => '兩門 Minor',
    withMinor: () => '和一門 Minor',
    withAnother: () => '和另一門 5 張以上的花色',
    oneSuiter: () => '一門長套',
    accept: () => '接受',
    decline: () => '拒絕',
    minimum: () => '低限',
    maximum: () => '高限',
    kingIn: ({ s }) => `有${s}K`,
    honourIn: ({ s }) => `${s}有 A 或 K`,
    noKing: () => '沒有可以叫出的旁門 K',
    void: () => '有一門缺門',
    voidIn: ({ s }) => `${s}缺門`,
    aces: ({ counts }) => `${counts} 張 A`,
    kings: ({ counts }) => `${counts} 張 K`,
    control: ({ s }) => `${s}第一輪控制`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `選擇${s}`,
    support: ({ s }) => `支持同伴的${s}`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const zhHans: Grammar = {
  ...zh,
  len: (r, s) => `${r} 张${s}`,
  stop: (st, s) => `${s} ${st}`,
  hcp: (r) => `${r} 大牌点`,
  tp: (r) => `${r} 总点`,
  keycards: (c) => `${c} 张关键张`,
  trumpQueen: ['有 Trump Q', '没有 Trump Q'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  before: '已表示：',
  notes: {
    asksMajor: () => '询问 4 张 Major',
    fourMajor: () => '有 4 张以上的 Major',
    noMajor: () => '没有 4 张 Major',
    noMinor: () => '没有 4 张 Minor',
    transferTo: ({ s }) => `Transfer 到${s}`,
    completes: () => '完成 Transfer',
    relayTo: ({ c }) => `请同伴叫 ${c[0]}`,
    choiceOf: ({ c }) => `请同伴选 ${c.join(' 或 ')}`,
    shortIn: ({ s }) => `${s}单张或缺门`,
    shortSomewhere: () => '某一门单张或缺门',
    noShortness: () => '没有单张或缺门',
    asksShortness: () => '询问短门在哪一门',
    tryIn: ({ s }) => `${s}需要帮助`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => '打这个 Contract',
    slamTry: () => 'Slam 试探',
    slamInterest: () => '有 Slam 兴趣',
    bothMajors: () => '两门 Major',
    bothMinors: () => '两门 Minor',
    withMinor: () => '和一门 Minor',
    withAnother: () => '和另一门 5 张以上的花色',
    oneSuiter: () => '一门长套',
    accept: () => '接受',
    decline: () => '拒绝',
    minimum: () => '低限',
    maximum: () => '高限',
    kingIn: ({ s }) => `有${s}K`,
    honourIn: ({ s }) => `${s}有 A 或 K`,
    noKing: () => '没有可以叫出的旁门 K',
    void: () => '有一门缺门',
    voidIn: ({ s }) => `${s}缺门`,
    aces: ({ counts }) => `${counts} 张 A`,
    kings: ({ counts }) => `${counts} 张 K`,
    control: ({ s }) => `${s}第一轮控制`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `选择${s}`,
    support: ({ s }) => `支持同伴的${s}`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const en: Grammar = {
  sep: '; ',
  or: ' or ',
  named: (name, rest) => (rest ? `${name}: ${rest}` : name),
  len: (r, s) => `${r} ${s}`,
  quality: (q, s) => `${q} ${s}`,
  stop: (st, s) => `${st} in ${s}`,
  hcp: (r) => `${r} HCP`,
  tp: (r) => `${r} total points`,
  controls: (r) => `${r} controls`,
  keycards: (c) => `${c} keycards`,
  balanced: ['balanced', 'unbalanced'],
  trumpQueen: ['trump queen', 'no trump queen'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  artificial: 'artificial',
  before: 'Shown so far: ',
  notes: {
    asksMajor: () => 'asks for a 4-card major',
    fourMajor: () => 'holds a 4+ card major',
    noMajor: () => 'no 4-card major',
    noMinor: () => 'no 4-card minor',
    transferTo: ({ s }) => `transfer to ${s}`,
    completes: () => 'completes the transfer',
    relayTo: ({ c }) => `asks partner to bid ${c[0]}`,
    choiceOf: ({ c }) => `choice of ${c.join(' or ')}`,
    shortIn: ({ s }) => `singleton or void in ${s}`,
    shortSomewhere: () => 'a singleton or void somewhere',
    noShortness: () => 'no singleton or void',
    asksShortness: () => 'asks where the shortness is',
    tryIn: ({ s }) => `help wanted in ${s}`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => 'to play',
    slamTry: () => 'slam try',
    slamInterest: () => 'slam interest',
    bothMajors: () => 'both majors',
    bothMinors: () => 'both minors',
    withMinor: () => 'and a minor',
    withAnother: () => 'and another suit of 5+',
    oneSuiter: () => 'one long suit',
    accept: () => 'accepts',
    decline: () => 'declines',
    minimum: () => 'minimum',
    maximum: () => 'maximum',
    kingIn: ({ s }) => `${s} king`,
    honourIn: ({ s }) => `ace or king in ${s}`,
    noKing: () => 'no side king to show',
    void: () => 'a void',
    voidIn: ({ s }) => `void in ${s}`,
    aces: ({ counts }) => `${counts} aces`,
    kings: ({ counts }) => `${counts} kings`,
    control: ({ s }) => `first-round control in ${s}`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `preference for ${s}`,
    support: ({ s }) => `supports partner's ${s}`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const vi: Grammar = {
  ...en,
  or: ' hoặc ',
  len: (r, s) => `${r} lá ${s}`,
  quality: (q, s) => `${s} ${q}`,
  stop: (st, s) => `${st} ${s}`,
  hcp: (r) => `${r} điểm HCP`,
  tp: (r) => `${r} tổng điểm`,
  controls: (r) => `${r} điểm kiểm soát`,
  keycards: (c) => `${c} quân chủ chốt`,
  balanced: ['bài cân', 'bài lệch'],
  trumpQueen: ['có Q Trump', 'không có Q Trump'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  artificial: 'nhân tạo',
  before: 'Đã cho thấy: ',
  notes: {
    asksMajor: () => 'hỏi Major 4 lá',
    fourMajor: () => 'có Major 4+ lá',
    noMajor: () => 'không có Major 4 lá',
    noMinor: () => 'không có Minor 4 lá',
    transferTo: ({ s }) => `Transfer sang ${s}`,
    completes: () => 'hoàn tất Transfer',
    relayTo: ({ c }) => `nhờ đồng đội kêu ${c[0]}`,
    choiceOf: ({ c }) => `chọn ${c.join(' hoặc ')}`,
    shortIn: ({ s }) => `${s} một lá hoặc chống`,
    shortSomewhere: () => 'có một hoa một lá hoặc chống',
    noShortness: () => 'không có hoa một lá hay chống',
    asksShortness: () => 'hỏi hoa ngắn ở đâu',
    tryIn: ({ s }) => `cần giúp ở ${s}`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => 'chơi Contract này',
    slamTry: () => 'thử Slam',
    slamInterest: () => 'quan tâm Slam',
    bothMajors: () => 'cả hai Major',
    bothMinors: () => 'cả hai Minor',
    withMinor: () => 'và một Minor',
    withAnother: () => 'và một hoa khác 5+ lá',
    oneSuiter: () => 'một hoa dài',
    accept: () => 'chấp nhận',
    decline: () => 'từ chối',
    minimum: () => 'tối thiểu',
    maximum: () => 'tối đa',
    kingIn: ({ s }) => `có K ${s}`,
    honourIn: ({ s }) => `có A hoặc K ${s}`,
    noKing: () => 'không có K phụ để báo',
    void: () => 'có một hoa chống',
    voidIn: ({ s }) => `chống ${s}`,
    aces: ({ counts }) => `${counts} quân A`,
    kings: ({ counts }) => `${counts} quân K`,
    control: ({ s }) => `kiểm soát vòng đầu ở ${s}`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `chọn ${s}`,
    support: ({ s }) => `ủng hộ ${s} của đồng đội`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const ja: Grammar = {
  sep: '、',
  or: 'か',
  named: (name, rest) => (rest ? `${name}：${rest}` : name),
  len: (r, s) => `${s}${r}枚`,
  quality: (q, s) => `${s}${q}`,
  stop: (st, s) => `${s}${st}`,
  hcp: (r) => `HCP ${r}`,
  tp: (r) => `トータルポイント ${r}`,
  controls: (r) => `コントロール ${r}`,
  keycards: (c) => `キーカード${c}枚`,
  balanced: ['バランスハンド', 'アンバランスハンド'],
  trumpQueen: ['Trump の Q あり', 'Trump の Q なし'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  artificial: '人工的',
  before: 'これまでに示した：',
  notes: {
    asksMajor: () => '4枚の Major を尋ねる',
    fourMajor: () => '4枚以上の Major あり',
    noMajor: () => '4枚の Major なし',
    noMinor: () => '4枚の Minor なし',
    transferTo: ({ s }) => `${s}への Transfer`,
    completes: () => 'Transfer を完了',
    relayTo: ({ c }) => `パートナーに${c[0]}を求める`,
    choiceOf: ({ c }) => `${c.join('か')}を選んでもらう`,
    shortIn: ({ s }) => `${s}がシングルトンかボイド`,
    shortSomewhere: () => 'どこかにシングルトンかボイド',
    noShortness: () => 'シングルトンもボイドもなし',
    asksShortness: () => 'ショートの場所を尋ねる',
    tryIn: ({ s }) => `${s}に助けがほしい`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => 'この Contract でプレー',
    slamTry: () => 'Slam トライ',
    slamInterest: () => 'Slam に興味あり',
    bothMajors: () => '両 Major',
    bothMinors: () => '両 Minor',
    withMinor: () => 'と Minor 1つ',
    withAnother: () => 'と別のスーツ5枚以上',
    oneSuiter: () => '長いスート1つ',
    accept: () => '受ける',
    decline: () => '断る',
    minimum: () => 'ミニマム',
    maximum: () => 'マキシマム',
    kingIn: ({ s }) => `${s}のK`,
    honourIn: ({ s }) => `${s}にAかK`,
    noKing: () => '示せるサイドのKなし',
    void: () => 'ボイドあり',
    voidIn: ({ s }) => `${s}ボイド`,
    aces: ({ counts }) => `エース${counts}枚`,
    kings: ({ counts }) => `キング${counts}枚`,
    control: ({ s }) => `${s}のファーストラウンド・コントロール`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `${s}を選ぶ`,
    support: ({ s }) => `パートナーの${s}をサポート`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const ko: Grammar = {
  sep: ', ',
  or: ' 또는 ',
  named: (name, rest) => (rest ? `${name}: ${rest}` : name),
  len: (r, s) => `${s} ${r}장`,
  quality: (q, s) => `${s} ${q}`,
  stop: (st, s) => `${s} ${st}`,
  hcp: (r) => `HCP ${r}`,
  tp: (r) => `총점 ${r}`,
  controls: (r) => `컨트롤 ${r}`,
  keycards: (c) => `키카드 ${c}장`,
  balanced: ['균형 핸드', '불균형 핸드'],
  trumpQueen: ['Trump Q 있음', 'Trump Q 없음'],
  forcing: { oneRound: 'Forcing one round', game: 'Game Forcing' },
  artificial: '인위적',
  before: '지금까지 보여 준 것: ',
  notes: {
    asksMajor: () => '4장 Major 질문',
    fourMajor: () => '4장 이상 Major 있음',
    noMajor: () => '4장 Major 없음',
    noMinor: () => '4장 Minor 없음',
    transferTo: ({ s }) => `${s} Transfer`,
    completes: () => 'Transfer 완료',
    relayTo: ({ c }) => `파트너에게 ${c[0]} 요청`,
    choiceOf: ({ c }) => `${c.join(' 또는 ')} 선택`,
    shortIn: ({ s }) => `${s} 싱글톤 또는 보이드`,
    shortSomewhere: () => '어딘가에 싱글톤 또는 보이드',
    noShortness: () => '싱글톤·보이드 없음',
    asksShortness: () => '숏니스 위치 질문',
    tryIn: ({ s }) => `${s}에 도움 필요`,
    invite: () => 'Invitational',
    signoff: () => 'Sign-off',
    toPlay: () => '이 Contract으로 플레이',
    slamTry: () => 'Slam 트라이',
    slamInterest: () => 'Slam 관심',
    bothMajors: () => '두 Major',
    bothMinors: () => '두 Minor',
    withMinor: () => '그리고 Minor 하나',
    withAnother: () => '그리고 다른 5장 이상 수트',
    oneSuiter: () => '긴 수트 하나',
    accept: () => '수락',
    decline: () => '거절',
    minimum: () => '미니멈',
    maximum: () => '맥시멈',
    kingIn: ({ s }) => `${s} K`,
    honourIn: ({ s }) => `${s} A 또는 K`,
    noKing: () => '보여줄 사이드 K 없음',
    void: () => '보이드 있음',
    voidIn: ({ s }) => `${s} 보이드`,
    aces: ({ counts }) => `에이스 ${counts}장`,
    kings: ({ counts }) => `킹 ${counts}장`,
    control: ({ s }) => `${s} 첫 라운드 컨트롤`,
    game: () => 'Game',
    smallSlam: () => 'Small Slam',
    grandSlam: () => 'Grand Slam',
    preference: ({ s }) => `${s} 선택`,
    support: ({ s }) => `파트너의 ${s} 서포트`,
    notrump: () => 'Notrump',
    positive: () => 'Positive Response',
  },
}

const GRAMMAR: Record<Lang, Grammar> = { zh, 'zh-Hans': zhHans, en, vi, ja, ko }

const LENGTH_TOP = 13

/** '5+', '0–9', '15–17' or '6'; null when the range says nothing */
function rangeText([min, max]: Range, top: number): string | null {
  if (min <= 0 && max >= top) return null
  if (max >= top) return `${min}+`
  if (min === max) return `${min}`
  return `${Math.max(0, min)}–${max}`
}

/** '4♥', '3NT', or the call itself for pass and doubles */
export function callText(call: Call): string {
  return isBid(call) ? `${levelOf(call)}${SUIT_SYMBOL[strainOf(call)]}` : call
}

const symbol = (strain: Strain | undefined) => (strain ? SUIT_SYMBOL[strain] : '')

/**
 * What a call shows, in words; '' when it shows nothing in particular. The call's own meaning
 * first, then on a line of its own what the player had already shown that the call does not
 * mention (`Spec.before`, Z1): "已表示：15–17 大牌點，平均牌型"
 */
export function describe(spec: Spec, lang: Lang): string {
  const g = GRAMMAR[lang]
  const own = features(spec, g, lang)
  const before = spec.before && features(spec.before, g, lang, spec.before.balanced ?? spec.balanced)
  if (!before) return own
  return own ? `${own}\n${g.before}${before}` : `${g.before}${before}`
}

function features(spec: Spec, g: Grammar, lang: Lang, balanced = spec.balanced): string {
  const parts: string[] = []
  const add = (text: string | null | undefined) => text && parts.push(text)

  for (const note of spec.notes ?? []) add(noteText(g, note))
  for (const s of SUITS) {
    // A balanced hand already has two to five cards in every suit
    if (balanced && spec.len?.[s]?.[0] === 2 && spec.len[s]![1] === 5) continue
    const range = spec.len?.[s] && rangeText(spec.len[s]!, LENGTH_TOP)
    if (range) add(g.len(range, SUIT_SYMBOL[s]))
  }
  for (const s of SUITS) if (spec.quality?.[s]) add(g.quality(QUALITY[spec.quality[s]!][lang], SUIT_SYMBOL[s]))
  if (spec.hcp) add(rangeText(spec.hcp, ANY) && g.hcp(rangeText(spec.hcp, ANY)!))
  if (spec.tp) add(rangeText(spec.tp, ANY) && g.tp(rangeText(spec.tp, ANY)!))
  if (spec.balanced !== undefined) add(g.balanced[spec.balanced ? 0 : 1])
  for (const s of SUITS) if (spec.stop?.[s]) add(g.stop(STOP[spec.stop[s]!][lang], SUIT_SYMBOL[s]))
  if (spec.controls) add(rangeText(spec.controls, ANY) && g.controls(rangeText(spec.controls, ANY)!))
  if (spec.keycards) add(g.keycards(spec.keycards.join(g.or)))
  if (spec.trumpQueen !== undefined) add(g.trumpQueen[spec.trumpQueen ? 0 : 1])
  if (spec.forcing) add(g.forcing[spec.forcing])
  if (spec.artificial && !spec.name && !spec.notes?.length) add(g.artificial)

  const rest = parts.join(g.sep)
  return spec.name ? g.named(NAMES[spec.name][lang], rest) : rest
}

function noteText(g: Grammar, note: Note): string {
  const counts = (note.counts ?? (note.count !== undefined ? [note.count] : [])).join(g.or)
  return g.notes[note.key]({ s: symbol(note.strain), c: (note.calls ?? []).map(callText), counts })
}

/** The name of a convention, for tests and the system card */
export const conventionName = (name: Convention, lang: Lang) => NAMES[name][lang]
