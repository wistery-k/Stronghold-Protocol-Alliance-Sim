// 「戦術」（ゲーム開始時に選ぶリーダー）。
// 本家データ（activity_table の act2autochess.bandDataListDict）の初期耐久値と効果を、日本語に訳したもの。
// 日本版に未実装のキャラクター名・効果名は独自の訳。

export type BandId =
  | 'bldsk'
  | 'amiya'
  | 'duyaoy'
  | 'sarkazb'
  | 'orchid'
  | 'justin'
  | 'ermengard'
  | 'lmlee'
  | 'kirara'
  | 'pepe'
  | 'harold'
  | 'sciurus'
  | 'paganini'
  | 'clementia'
  | 'emperor'
  | 'mberry'
  | 'humus'
  | 'quintus'
  | 'yu'
  | 'doberm'
  | 'cathy'
  | 'malkie'
  | 'qalaisa'
  | 'chen'
  | 'damaztic'
  | 'pith'
  | 'dusk'
  | 'cannot'
  | 'ducklord'
  | 'lisa'
  | 'vodfox'
  | 'ioleta'
  | 'jesica'
  | 'mlyss'
  | 'makiri'
  | 'fang'
  | 'mlynar'
  | 'chiave'
  | 'narant'
  | 'amedic';

export interface BandDef {
  id: BandId;
  /** リーダーの名前 */
  leader: string;
  /** 効果名 */
  name: string;
  description: string;
  /** 初期耐久値 */
  life: number;
  /** 'full' = 実装済み、'partial' = 一部だけ（note に説明）、'none' = 未実装（耐久値のみ） */
  impl: 'full' | 'partial' | 'none';
  note?: string;
}

export const BANDS: BandDef[] = [
  { id: 'bldsk', leader: 'ワルファリン', name: '重点監護', life: 28, impl: 'full', description: '戦闘開始時、場にいる等級ごとにランダムな1名を選び、その所属盟約の加算数+2' },
  { id: 'amiya', leader: 'アーミヤ', name: '衆志一心', life: 25, impl: 'full', description: '場に発動中の盟約が3/4/5種類以上あると、全オペレーターの攻撃力・最大HP+20/30/40%' },
  { id: 'duyaoy', leader: 'ドゥ・ヤオイェ', name: '豪傑歓迎', life: 29, impl: 'full', description: '毎ラウンド最初の2回の更新は特殊更新：【炎】のオペレーターが優先して1名出現する' },
  { id: 'sarkazb', leader: 'ゴリアテ', name: '難攻不落', life: 45, impl: 'full', description: '初期耐久値が45' },
  {
    id: 'orchid',
    leader: 'オーキッド',
    name: 'ヘッドハンター',
    life: 30,
    impl: 'partial',
    note: '「同名2名が出現し1名を凍結」は未実装（10ラウンド目の呼出モジュールのみ）',
    description: '更新はすべて特殊更新：同じオペレーターが必ず2名出現し、そのうち1名を凍結する。10ラウンド目に「呼出モジュール」を1つ獲得',
  },
  { id: 'justin', leader: 'ジャスティンJr.', name: '私募ファンド', life: 23, impl: 'full', description: '1・4・7・10ラウンドの準備開始時に「騎士の貯金箱」を1つ獲得' },
  { id: 'ermengard', leader: 'エルマンガルド', name: '命結の秘', life: 27, impl: 'full', description: '戦闘中、最初に倒れたオペレーター3名はその場で即座に復活する' },
  { id: 'lmlee', leader: 'リー', name: '飲茶でもどう', life: 27, impl: 'full', description: '1・2ラウンドの資金は3ラウンドにまとめて支給。3ラウンドの準備開始時に2等級と4等級のランダムなオペレーターを1名ずつ獲得' },
  { id: 'kirara', leader: 'キララ', name: 'クリア報酬', life: 26, impl: 'full', description: '資金を20使うたびに、管理レベル以下の等級のランダムなオペレーターを1名獲得' },
  { id: 'pepe', leader: 'ペペ', name: '博学多才', life: 23, impl: 'full', description: '管理レベルを2・4・6に上げると特殊更新を1回獲得：その更新では【サルゴン】のオペレーターが優先して出現する' },
  { id: 'harold', leader: 'ハロルド', name: '人材ガチャ', life: 23, impl: 'full', description: '4ラウンドから2ラウンドごとに【ヴィクトリア】のオペレーターを1名獲得' },
  { id: 'sciurus', leader: 'スキウース', name: '雪国の贈り物', life: 24, impl: 'full', description: '毎ラウンド最初に招集する【イェラグ】のオペレーターは資金1で招集できる' },
  { id: 'paganini', leader: 'パガニーニ', name: '特注銃', life: 24, impl: 'full', description: '資金を累計55使うと、4等級以上のランダムな【ラテラーノ】の精鋭オペレーターを1名獲得' },
  { id: 'clementia', leader: 'クレメンティア', name: '崇高な犠牲', life: 26, impl: 'full', description: '【エーギル】のオペレーターが倒れると、その等級と同じだけ【エーギル】の加算数を得る' },
  { id: 'emperor', leader: 'エンペラー', name: '緊急派遣', life: 26, impl: 'full', description: 'オペレーターの再配置時間-50%' },
  { id: 'mberry', leader: 'マルベリー', name: '薬効実験', life: 28, impl: 'full', description: '戦闘開始時、一番右の列のオペレーター全員が「攻撃時25%の確率で護盾を1層獲得（最大1層）」を得る' },
  { id: 'humus', leader: 'ヒューマス', name: 'リサイクル', life: 24, impl: 'full', description: '地上オペレーターのスキル終了時、周囲4マスのランダムなオペレーター1名のSP+3' },
  { id: 'quintus', leader: 'クィントゥス', name: '不安定要素', life: 31, impl: 'full', description: '3ラウンド目に特殊装備「変異細胞」を獲得' },
  { id: 'yu', leader: 'ユー', name: 'とろ火煮込み', life: 27, impl: 'full', description: '8ラウンド開始時、発動中の盟約が1つだけならその加算数+36、そうでなければ発動中の全盟約の加算数+12' },
  {
    id: 'doberm',
    leader: 'ドーベルマン',
    name: '追加訓練！',
    life: 30,
    impl: 'none',
    note: '特殊法術は未実装',
    description: '2ラウンドごとに特殊法術「教鞭」を獲得（使うと次の戦闘に敵が追加され、完璧に防衛すると資金を獲得）',
  },
  {
    id: 'cathy',
    leader: 'キャサリン',
    name: '指定投下',
    life: 26,
    impl: 'partial',
    note: '3つから選ぶ代わりに、ランダムな装備を1つ獲得',
    description: '管理レベルを上げるたびに、装備3つから1つを選んで獲得',
  },
  { id: 'malkie', leader: 'マルキェヴィッチ', name: '商業パッケージ', life: 28, impl: 'full', description: '最初に「プロデュース戦略」を1つ獲得' },
  { id: 'qalaisa', leader: 'カライシャ', name: '屍喰らいの蝶', life: 26, impl: 'full', description: 'オペレーターが倒れると、場に残るオペレーターの攻撃力+20%（最大200%。そのオペレーターが倒れるか戦闘終了まで）' },
  { id: 'chen', leader: 'チェン', name: '己の長所で', life: 22, impl: 'full', description: '全オペレーターの物理・術ダメージが弱点ダメージになる（敵の防御力と術耐性に応じて有利な方になる）' },
  { id: 'damaztic', leader: '「変形者」', name: '変形同構', life: 29, impl: 'full', description: '5ラウンドごとに特殊装備「変形同位体」を獲得' },
  { id: 'pith', leader: 'Pith', name: '優等生', life: 24, impl: 'none', note: '専用オペレーターは未実装', description: '1ラウンド目に、神経・灼熱・凋亡損傷を与える専用オペレーター（調和盟約）を1名獲得' },
  {
    id: 'dusk',
    leader: 'シー',
    name: '墨の真顔',
    life: 28,
    impl: 'partial',
    note: '特殊法術「画巻」は未実装',
    description: '場に同名のオペレーターがいると、それらの攻撃力+30%。1ラウンド目に特殊法術「画巻」（範囲内のオペレーター1名を複製）を獲得',
  },
  { id: 'cannot', leader: 'キャノット', name: '複利', life: 27, impl: 'full', description: '残った資金を次のラウンドに繰り越せる。5以上残っていると、毎ラウンド資金+1' },
  {
    id: 'ducklord',
    leader: 'ダック卿',
    name: '「謎の客」',
    life: 29,
    impl: 'none',
    note: '未実装',
    description: '5ラウンド目から、敵の一部がダック卿・ゴプニク・涙目の小僧・円仔に置き換わり、倒すと資金+1',
  },
  { id: 'lisa', leader: 'スズラン', name: 'お守りの力', life: 20, impl: 'full', description: '毎ラウンド開始時、場のオペレーター1名（右・下を優先）の獲得時の特性を1回発動' },
  { id: 'vodfox', leader: 'シャマレ', name: '身代わり人形', life: 22, impl: 'full', description: '毎ラウンド最初に通常のオペレーターを売却する時、代わりに調達所のランダムなオペレーターと交換する' },
  { id: 'ioleta', leader: 'イオレッタ・ラッセル', name: '統率号令', life: 29, impl: 'full', description: '戦闘開始時、場の精鋭オペレーター1名につき、精鋭オペレーターの攻撃力・最大HP+10%' },
  { id: 'jesica', leader: 'ジェシカ', name: '集結指示', life: 22, impl: 'full', description: '4・7・10・13ラウンドの準備開始時に「呼出モジュール」を1つ獲得' },
  { id: 'mlyss', leader: 'ミュルジス', name: '至純凝結', life: 28, impl: 'full', description: '1ラウンド目に精鋭の「ドクターのホログラム」（装備したオペレーターを即座に精鋭化）を1つ獲得' },
  { id: 'makiri', leader: 'マツキリ', name: '九流の縁', life: 24, impl: 'full', description: '偶数ラウンドの準備開始時、調達所のランダムなオペレーターを1名獲得' },
  {
    id: 'fang',
    leader: 'フェン',
    name: '協力前進',
    life: 24,
    impl: 'full',
    description: '8・10・12・14ラウンドに「ビーコン」を1つ獲得',
  },
  { id: 'mlynar', leader: 'ムリナール', name: '業績目標', life: 24, impl: 'full', description: '【カジミエーシュ】のオペレーターを招集するたびに、次のラウンド開始時に資金+1（1ラウンド最大3）' },
  { id: 'chiave', leader: 'キアーベ', name: '一味の仕事', life: 23, impl: 'full', description: '調達所を6回更新するたびに、管理レベル以下の等級の【シラクーザ】のオペレーターを1名獲得（1ラウンド最大2名）' },
  {
    id: 'narant',
    leader: 'ナラントゥヤ',
    name: '見た者で山分け',
    life: 26,
    impl: 'partial',
    note: '2つから選ぶ代わりにランダムな装備を1つ獲得。サルゴンLv2の置き換えは未実装',
    description: '偶数ラウンドの準備開始時、装備2つから1つを無料で獲得。【サルゴン】Lv2の効果が「スキル発動後60秒間、周囲8マスの味方も装備（V等級以下）の効果を得る」に置き換わる',
  },
  {
    id: 'amedic',
    leader: 'Touch',
    name: '外勤医療',
    life: 28,
    impl: 'none',
    note: '未実装',
    description: '場に「予備オペレーター-医療」が出現。戦闘開始時に精鋭オペレーターが2名以上いれば「Touch」に置き換わる',
  },
];

export const getBand = (id: BandId | null | undefined): BandDef | undefined => BANDS.find((b) => b.id === id);
