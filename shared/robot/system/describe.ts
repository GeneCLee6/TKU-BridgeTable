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
  transfer: { zh: '轉換', 'zh-Hans': '转移叫', en: 'Jacoby transfer', vi: 'Chuyển Jacoby', ja: 'ジャコビー・トランスファー', ko: '자코비 트랜스퍼' },
  superAccept: { zh: '超接受', 'zh-Hans': '超接受', en: 'Super-accept', vi: 'Siêu chấp nhận', ja: 'スーパーアクセプト', ko: '슈퍼 억셉트' },
  texas: { zh: 'Texas 轉換', 'zh-Hans': 'Texas 转移', en: 'Texas transfer', vi: 'Chuyển Texas', ja: 'テキサス・トランスファー', ko: '텍사스 트랜스퍼' },
  minorStayman: { zh: '低花 Stayman', 'zh-Hans': '低花 Stayman', en: 'Minor-suit Stayman', vi: 'Stayman hoa thấp', ja: 'マイナー・ステイマン', ko: '마이너 스테이먼' },
  gerber: { zh: 'Gerber', 'zh-Hans': 'Gerber', en: 'Gerber', vi: 'Gerber', ja: 'ガーバー', ko: '거버' },
  quantitative: { zh: '定量邀請', 'zh-Hans': '定量邀叫', en: 'Quantitative', vi: 'Mời định lượng', ja: 'クォンティタティブ', ko: '정량 초대' },
  jacoby2N: { zh: 'Jacoby 2NT', 'zh-Hans': 'Jacoby 2NT', en: 'Jacoby 2NT', vi: 'Jacoby 2NT', ja: 'ジャコビー2NT', ko: '자코비 2NT' },
  splinter: { zh: 'Splinter', 'zh-Hans': '斯普林特', en: 'Splinter', vi: 'Splinter', ja: 'スプリンター', ko: '스플린터' },
  limitRaise: { zh: 'Limit raise', 'zh-Hans': '限制性加叫', en: 'Limit raise', vi: 'Nâng giới hạn', ja: 'リミットレイズ', ko: '리밋 레이즈' },
  preemptiveRaise: { zh: '阻擊性加叫', 'zh-Hans': '阻击性加叫', en: 'Preemptive raise', vi: 'Nâng chặn', ja: 'プリエンプティブ・レイズ', ko: '선제 레이즈' },
  invertedMinor: { zh: '倒轉低花加叫', 'zh-Hans': '倒转低花加叫', en: 'Inverted minor', vi: 'Nâng hoa thấp đảo ngược', ja: 'インバーテッド・マイナー', ko: '인버티드 마이너' },
  shortSuitTry: { zh: '短門成局試探', 'zh-Hans': '短门成局试探', en: 'Short-suit game try', vi: 'Thử game hoa ngắn', ja: 'ショートスーツ・ゲームトライ', ko: '숏 수트 게임 트라이' },
  longSuitTry: { zh: '長門成局試探', 'zh-Hans': '长门成局试探', en: 'Long-suit game try', vi: 'Thử game hoa dài', ja: 'ロングスーツ・ゲームトライ', ko: '롱 수트 게임 트라이' },
  generalTry: { zh: '一般成局試探', 'zh-Hans': '一般成局试探', en: 'General game try', vi: 'Thử game chung', ja: 'ジェネラル・ゲームトライ', ko: '일반 게임 트라이' },
  askShortness: { zh: '詢問短門', 'zh-Hans': '询问短门', en: 'Shortness ask', vi: 'Hỏi hoa ngắn', ja: 'ショートネス・アスク', ko: '숏니스 질문' },
  drury: { zh: 'Reverse Drury', 'zh-Hans': 'Reverse Drury', en: 'Reverse Drury', vi: 'Reverse Drury', ja: 'リバース・ドルーリー', ko: '리버스 드루리' },
  soloway: { zh: 'Soloway 跳叫新花', 'zh-Hans': 'Soloway 跳叫新花', en: 'Soloway jump shift', vi: 'Nhảy đổi hoa Soloway', ja: 'ソロウェイ・ジャンプシフト', ko: '솔로웨이 점프 시프트' },
  fitJump: { zh: '配合跳叫', 'zh-Hans': '配合跳叫', en: 'Fit jump', vi: 'Nhảy có fit', ja: 'フィットジャンプ', ko: '핏 점프' },
  newMinorForcing: { zh: '新低花迫叫', 'zh-Hans': '新低花逼叫', en: 'New minor forcing', vi: 'Hoa thấp mới bắt buộc', ja: 'ニューマイナー・フォーシング', ko: '뉴 마이너 포싱' },
  fourthSuit: { zh: '第四花色迫叫', 'zh-Hans': '第四花色逼叫', en: 'Fourth suit forcing', vi: 'Hoa thứ tư bắt buộc', ja: 'フォース・スーツ・フォーシング', ko: '포스 수트 포싱' },
  reverse: { zh: '反序', 'zh-Hans': '逆序', en: 'Reverse', vi: 'Kêu đảo', ja: 'リバース', ko: '리버스' },
  strong2C: { zh: '強 2♣', 'zh-Hans': '强 2♣', en: 'Strong 2♣', vi: '2♣ mạnh', ja: '強い2♣', ko: '강한 2♣' },
  waiting: { zh: '等待叫', 'zh-Hans': '等待叫', en: 'Waiting', vi: 'Chờ', ja: 'ウェイティング', ko: '웨이팅' },
  doubleNegative: { zh: '二次否定', 'zh-Hans': '二次否定', en: 'Double negative', vi: 'Phủ định kép', ja: 'ダブル・ネガティブ', ko: '더블 네거티브' },
  weakTwo: { zh: '弱二', 'zh-Hans': '弱二', en: 'Weak two', vi: 'Weak two', ja: 'ウィークツー', ko: '위크 투' },
  featureAsk: { zh: '詢問特徵', 'zh-Hans': '询问特征', en: 'Feature ask', vi: 'Hỏi đặc điểm', ja: 'フィーチャー・アスク', ko: '피처 질문' },
  feature: { zh: '特徵', 'zh-Hans': '特征', en: 'Feature', vi: 'Đặc điểm', ja: 'フィーチャー', ko: '피처' },
  preempt: { zh: '阻擊', 'zh-Hans': '阻击', en: 'Preempt', vi: 'Chặn', ja: 'プリエンプト', ko: '선제' },
  overcall: { zh: '爭叫', 'zh-Hans': '争叫', en: 'Overcall', vi: 'Tranh kêu', ja: 'オーバーコール', ko: '오버콜' },
  weakJumpOvercall: { zh: '弱跳爭叫', 'zh-Hans': '弱跳争叫', en: 'Weak jump overcall', vi: 'Tranh kêu nhảy yếu', ja: 'ウィーク・ジャンプ・オーバーコール', ko: '위크 점프 오버콜' },
  weakJumpShift: { zh: '弱跳叫新花', 'zh-Hans': '弱跳叫新花', en: 'Weak jump shift', vi: 'Nhảy hoa mới yếu', ja: 'ウィーク・ジャンプ・シフト', ko: '위크 점프 시프트' },
  takeout: { zh: '技術性賭倍', 'zh-Hans': '技术性加倍', en: 'Takeout double', vi: 'Phạt kỹ thuật', ja: 'テイクアウト・ダブル', ko: '테이크아웃 더블' },
  negative: { zh: '負性賭倍', 'zh-Hans': '否定性加倍', en: 'Negative double', vi: 'Phạt phủ định', ja: 'ネガティブ・ダブル', ko: '네거티브 더블' },
  responsive: { zh: '回答性賭倍', 'zh-Hans': '应答性加倍', en: 'Responsive double', vi: 'Phạt đáp', ja: 'レスポンシブ・ダブル', ko: '리스판시브 더블' },
  support: { zh: '支持性賭倍', 'zh-Hans': '支持性加倍', en: 'Support double', vi: 'Phạt hỗ trợ', ja: 'サポート・ダブル', ko: '서포트 더블' },
  penalty: { zh: '處罰性賭倍', 'zh-Hans': '惩罚性加倍', en: 'Penalty double', vi: 'Phạt', ja: 'ペナルティ・ダブル', ko: '페널티 더블' },
  michaels: { zh: 'Michaels 扣叫', 'zh-Hans': 'Michaels 扣叫', en: 'Michaels cue bid', vi: 'Michaels', ja: 'マイケルズ・キュービッド', ko: '마이클스 큐비드' },
  unusual2N: { zh: '不尋常 2NT', 'zh-Hans': '不寻常 2NT', en: 'Unusual 2NT', vi: '2NT bất thường', ja: 'アンユージュアル2NT', ko: '언유주얼 2NT' },
  cappelletti: { zh: 'Cappelletti', 'zh-Hans': 'Cappelletti', en: 'Cappelletti', vi: 'Cappelletti', ja: 'カペレッティ', ko: '카펠레티' },
  sandwich: { zh: '夾擊 1NT', 'zh-Hans': '夹击 1NT', en: 'Sandwich 1NT', vi: '1NT kẹp', ja: 'サンドイッチ1NT', ko: '샌드위치 1NT' },
  lebensohl: { zh: '雷本索', 'zh-Hans': 'Lebensohl', en: 'Lebensohl', vi: 'Lebensohl', ja: 'レーベンゾール', ko: '레벤졸' },
  truscott: { zh: 'Truscott 2NT', 'zh-Hans': 'Truscott 2NT', en: 'Truscott 2NT', vi: 'Truscott 2NT', ja: 'トラスコット2NT', ko: '트러스콧 2NT' },
  cueRaise: { zh: '扣叫加叫', 'zh-Hans': '扣叫加叫', en: 'Cue-bid raise', vi: 'Nâng bằng cue bid', ja: 'キュービッド・レイズ', ko: '큐비드 레이즈' },
  unusualVsUnusual: { zh: '對抗不尋常 2NT', 'zh-Hans': '对抗不寻常 2NT', en: 'Unusual vs. Unusual', vi: 'Chống 2NT bất thường', ja: 'アンユージュアル対策', ko: '언유주얼 대응' },
  rkcb: { zh: 'RKCB 0314', 'zh-Hans': 'RKCB 0314', en: 'RKCB 0314', vi: 'RKCB 0314', ja: 'RKCB 0314', ko: 'RKCB 0314' },
  keycards: { zh: '回答關鍵張', 'zh-Hans': '回答关键张', en: 'Keycard answer', vi: 'Trả lời quân chủ chốt', ja: 'キーカードの回答', ko: '키카드 응답' },
  queenAsk: { zh: '詢問王牌 Q', 'zh-Hans': '询问将牌 Q', en: 'Trump queen ask', vi: 'Hỏi Q chủ', ja: '切り札Qのアスク', ko: '트럼프 Q 질문' },
  kingAsk: { zh: '詢問 K', 'zh-Hans': '询问 K', en: 'King ask', vi: 'Hỏi K', ja: 'キングアスク', ko: '킹 질문' },
  rkcb1430: { zh: 'RKCB 1430', 'zh-Hans': 'RKCB 1430', en: 'RKCB 1430', vi: 'RKCB 1430', ja: 'RKCB 1430', ko: 'RKCB 1430' },
  ekb: { zh: 'EKB（除外問 A）', 'zh-Hans': 'EKB（除外问 A）', en: 'Exclusion keycard', vi: 'Exclusion keycard', ja: 'エクスクルージョン・キーカード', ko: '익스클루전 키카드' },
  blackwood: { zh: '黑木問 A', 'zh-Hans': '黑木问 A', en: 'Blackwood', vi: 'Blackwood', ja: 'ブラックウッド', ko: '블랙우드' },
  grandSlamForce: { zh: '大滿貫迫叫', 'zh-Hans': '大满贯逼叫', en: 'Grand slam force', vi: 'Ép grand slam', ja: 'グランドスラム・フォース', ko: '그랜드 슬램 포스' },
  dopi: { zh: 'DOPI', 'zh-Hans': 'DOPI', en: 'DOPI', vi: 'DOPI', ja: 'DOPI', ko: 'DOPI' },
  cue: { zh: '扣叫', 'zh-Hans': '扣叫', en: 'Cue bid', vi: 'Cue bid', ja: 'キュービッド', ko: '큐비드' },
  relay: { zh: '接力', 'zh-Hans': '接力', en: 'Relay', vi: 'Chuyển tiếp', ja: 'リレー', ko: '릴레이' },
  j2n: { zh: 'J2N', 'zh-Hans': 'J2N', en: 'J2N (Jacoby 2NT)', vi: 'J2N (Jacoby 2NT)', ja: 'J2N（ジャコビー2NT）', ko: 'J2N (자코비 2NT)' },
  bergen: { zh: 'Bergen 加叫', 'zh-Hans': 'Bergen 加叫', en: 'Bergen raise', vi: 'Nâng Bergen', ja: 'バーゲン・レイズ', ko: '버건 레이즈' },
  oneMajorWeakTwo: { zh: '一高弱二', 'zh-Hans': '一高弱二', en: 'Weak two in a major', vi: 'Weak two một hoa cao', ja: 'どちらかのメジャーのウィークツー', ko: '메이저 하나의 위크 투' },
  twoSuiter: { zh: '雙套', 'zh-Hans': '双套', en: 'Two-suiter', vi: 'Hai hoa dài', ja: 'ツースーター', ko: '투 수터' },
  minorAsk: { zh: '詢問低花', 'zh-Hans': '询问低花', en: 'Minor-suit ask', vi: 'Hỏi hoa thấp', ja: 'マイナーのアスク', ko: '마이너 질문' },
  passOrCorrect: { zh: 'P/C', 'zh-Hans': 'P/C', en: 'Pass or correct', vi: 'Pass hoặc sửa', ja: 'パス・オア・コレクト', ko: '패스 오어 코렉트' },
  ask: { zh: '詢問', 'zh-Hans': '询问', en: 'Asking bid', vi: 'Hỏi', ja: 'アスク', ko: '질문' },
}

const QUALITY: Record<Quality, Words> = {
  biddable: { zh: '可叫', 'zh-Hans': '可叫', en: 'biddable', vi: 'đủ để kêu', ja: 'ビッダブル', ko: '비더블' },
  rebiddable: { zh: '可再叫', 'zh-Hans': '可再叫', en: 'rebiddable', vi: 'kêu lại được', ja: 'リビッダブル', ko: '리비더블' },
  twiceRebiddable: { zh: '可兩次再叫', 'zh-Hans': '可两次再叫', en: 'twice rebiddable', vi: 'kêu lại hai lần được', ja: '2回リビッダブル', ko: '두 번 리비더블' },
  strongRebiddable: { zh: '強可再叫', 'zh-Hans': '强可再叫', en: 'strong rebiddable', vi: 'rất mạnh', ja: '強いリビッダブル', ko: '강한 리비더블' },
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
  trumpQueen: ['有王牌 Q', '沒有王牌 Q'],
  forcing: { oneRound: '迫叫一圈', game: '迫叫成局' },
  artificial: '人工叫',
  notes: {
    asksMajor: () => '詢問 4 張高花',
    noMajor: () => '沒有 4 張高花',
    noMinor: () => '沒有 4 張低花',
    transferTo: ({ s }) => `轉到${s}`,
    completes: () => '完成轉換',
    relayTo: ({ c }) => `請同伴叫 ${c[0]}`,
    choiceOf: ({ c }) => `請同伴選 ${c.join(' 或 ')}`,
    shortIn: ({ s }) => `${s}單張或缺門`,
    shortSomewhere: () => '某一門單張或缺門',
    noShortness: () => '沒有單張或缺門',
    asksShortness: () => '詢問短門在哪一門',
    tryIn: ({ s }) => `${s}需要幫助`,
    invite: () => '邀請',
    signoff: () => '止叫',
    toPlay: () => '打這個合約',
    slamTry: () => '滿貫試探',
    slamInterest: () => '有滿貫興趣',
    bothMajors: () => '兩門高花',
    bothMinors: () => '兩門低花',
    withMinor: () => '和一門低花',
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
    game: () => '成局',
    smallSlam: () => '小滿貫',
    grandSlam: () => '大滿貫',
    preference: ({ s }) => `選擇${s}`,
    support: ({ s }) => `支持同伴的${s}`,
    notrump: () => '無王',
    positive: () => '正面答叫',
  },
}

const zhHans: Grammar = {
  ...zh,
  len: (r, s) => `${r} 张${s}`,
  stop: (st, s) => `${s} ${st}`,
  hcp: (r) => `${r} 大牌点`,
  tp: (r) => `${r} 总点`,
  keycards: (c) => `${c} 张关键张`,
  trumpQueen: ['有将牌 Q', '没有将牌 Q'],
  forcing: { oneRound: '逼叫一轮', game: '逼叫到局' },
  notes: {
    asksMajor: () => '询问 4 张高花',
    noMajor: () => '没有 4 张高花',
    noMinor: () => '没有 4 张低花',
    transferTo: ({ s }) => `转移到${s}`,
    completes: () => '完成转移',
    relayTo: ({ c }) => `请同伴叫 ${c[0]}`,
    choiceOf: ({ c }) => `请同伴选 ${c.join(' 或 ')}`,
    shortIn: ({ s }) => `${s}单张或缺门`,
    shortSomewhere: () => '某一门单张或缺门',
    noShortness: () => '没有单张或缺门',
    asksShortness: () => '询问短门在哪一门',
    tryIn: ({ s }) => `${s}需要帮助`,
    invite: () => '邀叫',
    signoff: () => '止叫',
    toPlay: () => '打这个定约',
    slamTry: () => '满贯试探',
    slamInterest: () => '有满贯兴趣',
    bothMajors: () => '两门高花',
    bothMinors: () => '两门低花',
    withMinor: () => '和一门低花',
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
    game: () => '成局',
    smallSlam: () => '小满贯',
    grandSlam: () => '大满贯',
    preference: ({ s }) => `选择${s}`,
    support: ({ s }) => `支持同伴的${s}`,
    notrump: () => '无将',
    positive: () => '积极应叫',
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
  forcing: { oneRound: 'forcing', game: 'game forcing' },
  artificial: 'artificial',
  notes: {
    asksMajor: () => 'asks for a 4-card major',
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
    invite: () => 'invitational',
    signoff: () => 'sign-off',
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
    game: () => 'game',
    smallSlam: () => 'small slam',
    grandSlam: () => 'grand slam',
    preference: ({ s }) => `preference for ${s}`,
    support: ({ s }) => `supports partner's ${s}`,
    notrump: () => 'notrump',
    positive: () => 'positive response',
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
  trumpQueen: ['có Q chủ', 'không có Q chủ'],
  forcing: { oneRound: 'bắt buộc một vòng', game: 'bắt buộc đến game' },
  artificial: 'nhân tạo',
  notes: {
    asksMajor: () => 'hỏi hoa cao 4 lá',
    noMajor: () => 'không có hoa cao 4 lá',
    noMinor: () => 'không có hoa thấp 4 lá',
    transferTo: ({ s }) => `chuyển sang ${s}`,
    completes: () => 'hoàn tất chuyển',
    relayTo: ({ c }) => `nhờ đồng đội kêu ${c[0]}`,
    choiceOf: ({ c }) => `chọn ${c.join(' hoặc ')}`,
    shortIn: ({ s }) => `${s} một lá hoặc chống`,
    shortSomewhere: () => 'có một hoa một lá hoặc chống',
    noShortness: () => 'không có hoa một lá hay chống',
    asksShortness: () => 'hỏi hoa ngắn ở đâu',
    tryIn: ({ s }) => `cần giúp ở ${s}`,
    invite: () => 'mời',
    signoff: () => 'dừng',
    toPlay: () => 'chơi hợp đồng này',
    slamTry: () => 'thử slam',
    slamInterest: () => 'quan tâm slam',
    bothMajors: () => 'cả hai hoa cao',
    bothMinors: () => 'cả hai hoa thấp',
    withMinor: () => 'và một hoa thấp',
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
    game: () => 'game',
    smallSlam: () => 'tiểu slam',
    grandSlam: () => 'đại slam',
    preference: ({ s }) => `chọn ${s}`,
    support: ({ s }) => `ủng hộ ${s} của đồng đội`,
    notrump: () => 'không chủ',
    positive: () => 'đáp tích cực',
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
  trumpQueen: ['切り札のQあり', '切り札のQなし'],
  forcing: { oneRound: 'フォーシング', game: 'ゲームフォーシング' },
  artificial: '人工的',
  notes: {
    asksMajor: () => '4枚のメジャーを尋ねる',
    noMajor: () => '4枚のメジャーなし',
    noMinor: () => '4枚のマイナーなし',
    transferTo: ({ s }) => `${s}へのトランスファー`,
    completes: () => 'トランスファーを完了',
    relayTo: ({ c }) => `パートナーに${c[0]}を求める`,
    choiceOf: ({ c }) => `${c.join('か')}を選んでもらう`,
    shortIn: ({ s }) => `${s}がシングルトンかボイド`,
    shortSomewhere: () => 'どこかにシングルトンかボイド',
    noShortness: () => 'シングルトンもボイドもなし',
    asksShortness: () => 'ショートの場所を尋ねる',
    tryIn: ({ s }) => `${s}に助けがほしい`,
    invite: () => 'インビテーション',
    signoff: () => 'サインオフ',
    toPlay: () => 'この契約でプレー',
    slamTry: () => 'スラムトライ',
    slamInterest: () => 'スラムに興味あり',
    bothMajors: () => '両メジャー',
    bothMinors: () => '両マイナー',
    withMinor: () => 'とマイナー1つ',
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
    game: () => 'ゲーム',
    smallSlam: () => 'スモールスラム',
    grandSlam: () => 'グランドスラム',
    preference: ({ s }) => `${s}を選ぶ`,
    support: ({ s }) => `パートナーの${s}をサポート`,
    notrump: () => 'ノートランプ',
    positive: () => 'ポジティブ・レスポンス',
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
  trumpQueen: ['트럼프 Q 있음', '트럼프 Q 없음'],
  forcing: { oneRound: '포싱', game: '게임 포싱' },
  artificial: '인위적',
  notes: {
    asksMajor: () => '4장 메이저 질문',
    noMajor: () => '4장 메이저 없음',
    noMinor: () => '4장 마이너 없음',
    transferTo: ({ s }) => `${s} 트랜스퍼`,
    completes: () => '트랜스퍼 완료',
    relayTo: ({ c }) => `파트너에게 ${c[0]} 요청`,
    choiceOf: ({ c }) => `${c.join(' 또는 ')} 선택`,
    shortIn: ({ s }) => `${s} 싱글톤 또는 보이드`,
    shortSomewhere: () => '어딘가에 싱글톤 또는 보이드',
    noShortness: () => '싱글톤·보이드 없음',
    asksShortness: () => '숏니스 위치 질문',
    tryIn: ({ s }) => `${s}에 도움 필요`,
    invite: () => '초대',
    signoff: () => '사인오프',
    toPlay: () => '이 계약으로 플레이',
    slamTry: () => '슬램 트라이',
    slamInterest: () => '슬램 관심',
    bothMajors: () => '두 메이저',
    bothMinors: () => '두 마이너',
    withMinor: () => '그리고 마이너 하나',
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
    game: () => '게임',
    smallSlam: () => '스몰 슬램',
    grandSlam: () => '그랜드 슬램',
    preference: ({ s }) => `${s} 선택`,
    support: ({ s }) => `파트너의 ${s} 서포트`,
    notrump: () => '노트럼프',
    positive: () => '포지티브 응답',
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

/** What a call shows, in words; '' when it shows nothing in particular */
export function describe(spec: Spec, lang: Lang): string {
  const g = GRAMMAR[lang]
  const parts: string[] = []
  const add = (text: string | null | undefined) => text && parts.push(text)

  for (const note of spec.notes ?? []) add(noteText(g, note))
  for (const s of SUITS) {
    // A balanced hand already has two to five cards in every suit
    if (spec.balanced && spec.len?.[s]?.[0] === 2 && spec.len[s]![1] === 5) continue
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
