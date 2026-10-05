# 引き継ぎメモ（次の作業者向け）

アークナイツ「堅守協定：盟約（後期）」をブラウザで遊べるようにしたシミュレーター。TypeScript + Vite、GitHub Pages で公開。
ユーザーとは日本語でやりとりする。仕様の細部（README.md）はユーザーと一緒に詰めてきたものなので、変える時は必ず確認すること。

## 方針（ユーザーとの約束）

- **本家に忠実に**。仕様が分からない所は妥当な挙動を自分で決めて実装し、「何をどう仮定したか」を必ずユーザーに伝える（README にも書く）。
- 数値はまずゲームデータ（下記）から取る。データに無いものは攻略 wiki の値、それも無ければ仮の値（README に「仮」と明記）。
- 「物理・術ダメージをX軽減」でなく「ダメージをX軽減」のように**種別の指定がない効果は、確定ダメージ（マスのダメージ含む）にも効く**と解釈する。
- 名前は日本版（Yostar 版データ）の表記。日本版に無いものは大陸版の名前を日本語の字体に直す（`scripts/extract_battle.py` の `ENEMY_NAME_OVERRIDES` など）。ユーザーから呼び名の指定があればそれに従う（例：「仮想敵：淤困」→「仮想敵：泥濘」）。
- シミュレーションは**決定的**（確率は累積方式で `ACC_START = 0.5` から。乱数はボスのランダム対象・手下の移動の xorshift のみ）。
- 変更のたびに：型チェック → テスト → README 更新（素質を変えたら `docs/talents.md` も再生成）→ コミット → `main` に直接 push。

## 作業の流れ

```sh
npx tsc -p . --noEmit                       # 型チェック
npm install && npm test                     # テスト（vitest。tests/battle, game, sim の3本）
npx tsx scripts/talent_doc.ts               # docs/talents.md（素質の再現状況）を再生成
npm run dev                                 # 開発サーバー
```

- 前のセッションでは vitest を入れずに、`expect/describe/it` だけの自前の軽量シム（`toBeLessThan`・`toBeTruthy` が無いので `expect(a < b).toBe(true)` で書いている）＋ `tsx` でテストを回していた。npm で vitest が入るならそれで良い。
- コミットメッセージの末尾には、その時のシステムが指示する帰属表記（Co-Authored-By / Claude-Session）を付ける。
- 見た目の確認は、`battleSummary(result, board)` を使う小さな TS を esbuild でバンドルし、`src/ui/style.css` と一緒に静的サーバーで配信して Playwright（Chromium は `/opt/pw-browsers`）でスクリーンショットを撮っていた。リプレイは ×2 で自動再生するので、見たい戦闘時刻の約半分の実時間で撮る。

## データの作り方

ゲームデータは [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)（大陸版。イベント `act2autochess` のデータ源）と [Kengxxiao/ArknightsGameData_YoStar](https://github.com/Kengxxiao/ArknightsGameData_YoStar)（日本語名・説明）。`--filter=blob:none` で clone すると軽い。

```sh
python3 scripts/extract_gamedata.py <ArknightsGameData> <ArknightsGameData_YoStar>   # → src/core/data/gamedata.json（ユニット・盟約・装備など）
python3 scripts/extract_battle.py   <ArknightsGameData> <ArknightsGameData_YoStar>   # → src/core/data/battledata.json（敵・ラウンド・射程など）
```

- 生成物の JSON は手で直さない。敵の特殊能力は `extract_battle.py` で blackboard や図鑑の説明から拾い、`EnemySpec`（`src/core/data/battle.ts`）のフィールドにする → `sim.ts` で実装、という流れ。
- 使っているモードは `MODE = 'mode_single_normal'`。ボス（R14・R15）の HP は難易度ごとの値 `bossInfoDict` の `bloodPoint*` から取っていて、今は `BOSS_HP_FIELD = 'bloodPointHard'`（絶境＝日本版の死地。冑 180万・360万）。`difficultyFactorInfo`（1.0/1.6/1.7/1.7）と `modeFactorInfo`（1.25）は意味が不明で未使用。
- 飛行の敵は各ステージの飛行経路（経由点）を `route` として持つ。盤面と座標系が違うボスステージ（R14・15）は対象外。

## コードの地図

| ファイル | 中身 |
|---|---|
| `src/core/sim.ts`（約4100行） | 戦闘シミュレーター本体。`runEngine` の中に、ユニット（`Runtime`）・敵（`Enemy`）の状態、攻撃・被弾・スキル・素質・盟約の戦闘効果・敵の特殊能力がすべてある。リプレイ用の `frames`・`fx` もここで記録 |
| `src/core/game.ts` | ゲーム進行（ラウンド、ショップ、戦闘の解決、取り消し） |
| `src/core/alliance.ts` / `garrison.ts` / `band.ts` / `items.ts` / `talents.ts` | 盟約・堅守特性・戦術・装備・素質。戦闘前の補正（`Modifier`）は `alliance.ts` の `battleSetup` で作り、`game.ts` の `buildSimInputs` がシミュレーターへの入力にまとめる |
| `src/core/board.ts` | マップ（m1〜m8、旧マップ legacy）、経路、配置、`BOSS_CELLS` |
| `src/ui/battleView.ts` + `style.css` | 戦闘結果とリプレイ（SVG）。凡例の文章もここ |
| `scripts/autoplay.ts` | 自動プレイでのバランス確認（`npm run balance`） |

よく使う仕組み：

- 敵→味方のダメージは `hurt()`（被弾時の反応・反撃もここ）→ `takeDamage()`。マスや継続ダメージは `takeDps()`。固定値軽減は `flatCut()`。
- 味方→敵は `deal()` / `hitDamage()`。攻撃範囲は `covers()`（大型ボスは `BOSS_CELLS`）。
- 堅守特性の戦闘中の加算は `GarrisonEvent` → `gainStacks()`（ラウンド14・15は戦闘中の加算が無効）。
- リプレイの敵フレームのフラグ（`e[4]`）：1 解放された囚人 / 2 スタン / 4 恐怖 / 8 ステルス / 16 活性源石の上 / 32 石像形態 / 64 飛行形態になった石像。フレームのその他：`lf` 離陸中、`dl` 身替り中、`tk` 紙人形、`zr` ザーロ、`sg`/`sc` サルゴン・シラクーザ、`st` ステルスの味方。
- fx の種類：0 命中 / 1 円 / 2 範囲 / 3 敵の射撃 / 4 治療 / 5 範囲効果 / 6 汚染秽蝕 / 7 3×3 の範囲（スタン・爆発）/ 8 剣雨 / 9 ザーロ。

## 最近やったこと（このセッション）

- 海溝の実験体（固定値のダメージ軽減・【エーギル】の反撃）、冑の当たり判定を左の列まで拡張、ボス戦は冑を倒すと即終了、冑の HP を絶境の値に
- スキル中に攻撃しない／する（スズランS3・クオーラ・キャサリン・バブル・アンジェリーナS3・荒蕪ラップランドS3）、ティッピS2（離陸）
- 傀儡師（カゼマル・帰溟スペクター）の身替り、紙人形、素質、堅守特性
- 敵：バクダンバチ、祝祭のジャズ奏者、掠海のフローター、枯朽サルカズ戦車、墓守の石像、「帝国の甲冑」、仮想敵：泥濘。飛行の敵の飛行経路。活性源石の上の敵の表示

## 仮の値・未確認の点（ユーザーに伝え済み）

- カゼマルS2の紙人形：1体だけ・前方優先・スキル終了で消える。攻撃力は本家トークンの比で約1.117倍
- 傀儡師の入れ替わり時の HP は最大値（身替りになる時も本体に戻る時も）
- バクダンバチの加速は +200%（`move_speed 2.0` の解釈）
- 祝祭のジャズ奏者の「狂宴の刻」は未実装（このモードに無いと判断）
- 枯朽サルカズ戦車の汚染秽蝕の半径 1、「帝国の甲冑」の連撃の倍率は通常と同じ、泥濘の爆発で広がる元素損傷は 500、墓守の石像の飛行形態は HP を引き継ぎ障害物を無視して直進
- 冑の無人機の HP はボスの最大 HP×2%、弾の速さ・手下の突進の速さ（1マス/秒）は仮
- 飛行経路の斜めの区間は1マスずつ斜めに進む（本家より少し速い）

## まだやっていないこと

- 未再現の素質：`docs/talents.md` で ❌（約39件）・一部（約31件）。スズランの足止め、アンジェリーナの反重力、キャサリンの支援装置など
- スキル：サンクタ・ミキサー（反撃）、レミュアン（ロックオン爆撃）は実装済み（`sim.ts` の `mixerCounter`・`lemuenLock`・`lemuenBombard`）。仮の点は README の「弾薬スキル」の項を参照。未再現：二人の素質（バリア・指名手配）、手動停止
- 戦術（バンド）の一部：`src/core/data/bands.ts` の `impl: 'partial' | 'none'`
- ボスの HP の難易度をゲーム内で選べるようにする案（ユーザーと話しただけで未着手）
- コキュートスはデータ上攻撃力があるが攻撃しない（ユーザー確認済み、このままで正しい）
