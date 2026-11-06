import type { PuzzleSource } from '../puzzles.ts'

/**
 * The first set (`e10-t13`). AI drafts: `npm run puzzles` verified the cards with `shared/robot/dd.ts`,
 * but nobody from the club has read the bridge in them yet, so all ten stay `status: 'draft'` until an
 * admin publishes each from the admin page. The solver only proves the contract makes on this layout;
 * whether a line is what a player should find, and whether the words are good, is for a club officer.
 *
 * They are endings of 5 to 9 cards: on a whole 13-card deal `dd.ts` gave up within the 20 million
 * positions (refused after about a minute), and the stored decisions grow fast with every card left
 * (some 7- and 9-card trials went over the limit; `SOLVE_LIMITS`). Words
 * are in 繁體中文 only; the page says so in the other languages (`t.puzzles.zhOnly`).
 */

export const FIRST_SET: readonly PuzzleSource[] = [
  {
    id: 'p01',
    status: 'draft',
    level: 1,
    title: '解開阻塞：用大牌超過同伴的大牌',
    contract: { level: 3, strain: 'N' },
    deal: 'N:AJT98.2.. 76.KQ.K.K KQ.A.A.32 54.J.Q.JT',
    won: 3,
    leader: 'S',
    opening: [],
    story: '3NT，前 7 墩你拿 3 墩、防家拿 4 墩，剩下 6 墩要全拿。你在手上出牌。夢家的黑桃很長，但夢家除了黑桃，只有一張小紅心。',
    hints: ['數一數：手上的黑桃打完之後，誰在出牌？', '夢家的黑桃要全部兌現，最後一輪黑桃不能由手上贏。'],
    explanation:
      '出 ♠K（夢家跟小牌），再出 ♠Q 時夢家要用 ♠A 超過，之後 ♠J、♠10、♠9、♠8 都是贏張，最後小紅心回手上的 ♥A。如果第二輪不超過，就會留在手上，夢家的黑桃再也進不去。注意第一輪用 ♠A 超過 ♠K 也不行：之後 ♠J 還是會被手上的 ♠Q 吃住。',
  },
  {
    id: 'p02',
    status: 'draft',
    level: 1,
    title: '先王吃，再清王',
    contract: { level: 4, strain: 'S' },
    deal: 'N:83.5.A.76 7.KQJ.K.K AKQ.A76.. 54.T98.J.',
    won: 4,
    leader: 'S',
    opening: [],
    story: '4♠，前 7 墩你拿 4 墩、防家拿 3 墩，剩下 6 墩要全拿。你在手上出牌。手上的紅心有兩張輸張，夢家紅心只有一張。',
    hints: ['夢家的兩張王牌是做什麼用的？', '清王的輪數和夢家的王牌張數比一比。'],
    explanation:
      '可以先清一輪王牌，但不能清兩輪，否則夢家沒有王牌可以王吃。兌現 ♥A、王吃 ♥7，然後用夢家的 ♦A 墊掉手上最後一張 ♥6。先想清楚每一張王牌的用途，再決定什麼時候清王。',
  },
  {
    id: 'p03',
    status: 'draft',
    level: 1,
    title: '先墊掉輸張，再動王牌',
    contract: { level: 4, strain: 'S' },
    deal: 'N:543.AKQ.32.6 A2.J98.Q8.K3 KQJT9.3.76.4 876.T76.JT.Q',
    won: 3,
    leader: 'N',
    opening: [],
    story: '4♠，前 4 墩你拿 3 墩、防家拿 1 墩，剩下 9 墩要拿 7 墩。你在夢家出牌，王牌還沒清，♠A 不在你們手上。',
    hints: ['防家拿到 ♠A 之後，會打哪一門？', '夢家的紅心比手上多兩張贏張，它們現在就有用。'],
    explanation:
      '立刻兌現 ♥A、♥K、♥Q，手上墊掉 ♦7、♦6。如果先出王牌，防家拿到 ♠A 就會兌現方塊，加上 ♣ 的輸張就超過可以輸的墩數。「會失去出牌權之前，先把快輸張墊掉」是坐莊的基本順序。',
  },
  {
    id: 'p04',
    status: 'draft',
    level: 1,
    title: '王吃要夠大',
    contract: { level: 4, strain: 'S' },
    deal: 'N:K3..A2.32 J98..Q.KQ AQT.7.3.5 .KQJT.J.A',
    won: 5,
    leader: 'S',
    opening: [],
    story: '4♠，前 7 墩你拿 5 墩、防家拿 2 墩，剩下 6 墩要拿 5 墩。你在手上出牌。還缺 ♠J、♠9、♠8 三張王牌，都在東家，而且東家紅心已經缺門。',
    hints: ['夢家王吃的時候，下一家還可能出什麼牌？', '夢家的兩張王牌，哪一張給得起？'],
    explanation:
      '出 ♥7，西家跟牌之後夢家要用 ♠K 王吃。用 ♠3 王吃，東家可以用 ♠8 超吃。♠K 王吃之後，手上的 ♠A、♠Q、♠10 正好清掉東家的三張王牌。夢家還有一張 ♠3 可以回手上。',
  },
  {
    id: 'p05',
    status: 'draft',
    level: 2,
    title: '忍讓兩次，切斷防家的聯絡',
    contract: { level: 3, strain: 'N' },
    deal: 'N:.73.KQJT.A .T62.A85.Q .A84.63.K3 .KQJ95.7.J',
    won: 5,
    leader: 'W',
    opening: ['HK'],
    story: '3NT，前 6 墩你拿 5 墩、防家拿 1 墩，剩下 7 墩要拿 4 墩。西家出 ♥K。方塊還要讓掉 ♦A 才能建立，黑桃都打完了。',
    hints: ['方塊讓掉的時候，上手的那一家還有沒有紅心可以回？', '數防家的紅心：你要讓哪一家先出完？'],
    explanation:
      '♥K 和下一輪紅心都不要吃，第三輪才用 ♥A 贏。東家只有三張紅心，這時已經出完；等東家用 ♦A 上手，就回不了紅心，西家的長紅心進不去。太早吃下 ♥A，東家上手回紅心，西家就能兌現剩下的紅心，合約倒了。',
  },
  {
    id: 'p06',
    status: 'draft',
    level: 2,
    title: '讓一輪，留住長門的進手',
    contract: { level: 3, strain: 'N' },
    deal: 'N:..AK765.7 QJ..QJ8.Q A..432.A5 98..T9.KJ',
    won: 4,
    leader: 'S',
    opening: [],
    story: '3NT，前 7 墩你拿 4 墩、防家拿 3 墩，剩下 6 墩要拿 5 墩。你在手上出牌。夢家五張方塊，除了 ♦A、♦K 之外沒有別的進手。',
    hints: ['方塊 3-2 分配時，第幾輪之後夢家的小方塊才是贏張？', '輸掉那一輪方塊的時候，夢家手上最好還留著什麼？'],
    explanation:
      '方塊一定要輸一輪才能建立，關鍵是輸的時候夢家還要有方塊大牌當進手。先打 ♦A、♦K 再輸第三輪，夢家的 ♦7、♦6 就進不去了。趁夢家還有大牌時讓一輪（第一輪或第二輪都可以），之後才能連拿四墩方塊。也不要先兌現手上的 A：防家上手後就有黑桃或梅花可以兌現。',
  },
  {
    id: 'p07',
    status: 'draft',
    level: 2,
    title: '飛牌的方向：不讓危險的一家上手',
    contract: { level: 3, strain: 'N' },
    deal: 'N:.A.AJT94. 76.Q.Q65. K4.3.K32. AQT8..87.',
    won: 4,
    leader: 'S',
    opening: [],
    story: '3NT，前 7 墩你拿 4 墩、防家拿 3 墩，剩下 6 墩要拿 5 墩。你在手上出牌，西家之前攻黑桃，看來還有長黑桃。手上的 ♠K4 只擋得住從西家出的黑桃。',
    hints: ['東西兩家，哪一家上手你不怕？', '方塊的 Q 兩邊都可以飛，輸給哪一家都一樣嗎？'],
    explanation:
      '東家上手會穿過 ♠K 出黑桃，西家的 ♠A、♠Q 就都能拿。所以東家是危險的一家，飛牌要讓輸的時候是西家上手。先用 ♥3 到夢家的 ♥A，從夢家出 ♦J 飛：即使輸給西家的 ♦Q，西家也不能出黑桃而不送你一墩 ♠K。如果從手上出小方塊往 ♦J 飛，這副牌 ♦Q 在東家，他上手一回黑桃合約就倒了。',
  },
  {
    id: 'p08',
    status: 'draft',
    level: 3,
    title: '清完再丟：投入防家',
    contract: { level: 6, strain: 'S' },
    deal: 'N:.K2.AQ4. .QJ.K3.K .A3.76.5 .T9.JT.J',
    won: 8,
    leader: 'S',
    opening: [],
    story: '6♠，前 8 墩你全拿，王牌都打完了，剩下 5 墩要拿 4 墩。你在手上出牌。方塊飛牌如果失敗，還會再輸一墩梅花。',
    hints: ['有沒有辦法讓防家自己出方塊？', '先把防家可以安全脫手的牌清掉，再選一張輸張送出去。'],
    explanation:
      '先打 ♥3 到 ♥K、♥2 回 ♥A，把紅心清光。再出 ♣5，夢家墊掉 ♦4。東家用 ♣K 贏進之後只剩方塊，只好出到夢家的 ♦A Q 前面，♦Q 贏一墩，一墩梅花換回一墩方塊。直接飛方塊的話，這副牌 ♦K 在東家，會輸給 ♦K，之後還要輸 ♣5。',
  },
  {
    id: 'p09',
    status: 'draft',
    level: 3,
    title: '單緊逼：最後一張贏張',
    contract: { level: 6, strain: 'N' },
    deal: 'N:32.AJ.4. 98.7.65. AK.3.AJ. 7.KQ.KQ.',
    won: 7,
    leader: 'S',
    opening: [],
    story: '6NT，前 8 墩你拿 7 墩、防家拿 1 墩，剩下 5 墩要全拿，但贏張只有四個。你在手上出牌。從叫牌與前面的出牌看，♥K Q 與 ♦K Q 都在西家，飛牌沒有用。',
    hints: ['只有西家能同時守住紅心和方塊。他要墊牌的時候，手上還留得住幾張？', '先把不必讓防家上手的贏張打完，同時別動紅心和方塊。'],
    explanation:
      '連打 ♠A、♠K。第二張黑桃時西家要墊牌：紅心和方塊他都要留兩張才守得住，卻只能留三張。墊紅心，♥3 到 ♥A 打下他另一張大牌，♥J 成為贏張，再用 ♦4 回 ♦A。墊方塊，♦A 打下他另一張大牌，♦J 成為贏張，再用 ♥3 到 ♥A。這就是單緊逼：贏張差一墩時，讓最後一張贏張把守兩門的人逼到無牌可墊。',
  },
  {
    id: 'p10',
    status: 'draft',
    level: 3,
    title: '王牌短打：縮短自己的王牌',
    contract: { level: 6, strain: 'S' },
    deal: 'N:.4.AKQJ. Q9.K.98. AJ2..32. .T9.T7.T',
    won: 7,
    leader: 'S',
    opening: [],
    story: '6♠，前 8 墩你拿 7 墩、防家拿 1 墩，剩下 5 墩要全拿。你在手上出牌。西家王牌已經缺門，所以 ♠Q9 都在東家，正好在你的 ♠A J 前面。',
    hints: ['東家的 ♠Q 要被飛掉，牌要從哪一手出？', '最後兩張牌時，你手上的王牌要跟東家一樣多。現在你多一張。'],
    explanation:
      '手上的王牌比東家多一張，要先縮短：♦3 到夢家，出 ♥4 用 ♠2 王吃，♦2 再回夢家。最後從夢家出方塊，東家只剩 ♠Q 9，不論先出哪一張都被手上的 ♠A J 夾住，兩墩都是你的。夢家沒有王牌，飛牌只能這樣完成，這叫王牌短打（trump coup）。',
  },
]
