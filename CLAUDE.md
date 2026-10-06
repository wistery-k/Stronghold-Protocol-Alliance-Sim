# 引き継ぎメモ（次の作業者向け）

アークナイツ「堅守協定：盟約（後期）」をブラウザで遊べるようにしたシミュレーター。TypeScript + Vite、GitHub Pages で公開。
ユーザーとは日本語でやりとりする。仕様の細部（README.md・docs/rules.md・docs/battle.md）はユーザーと一緒に詰めてきたものなので、変える時は必ず確認すること。

## 方針（ユーザーとの約束）

- **本家に忠実に**。仕様が分からない所は妥当な挙動を自分で決めて実装し、「何をどう仮定したか」を必ずユーザーに伝える（docs/ の仕様書にも書く）。
- 数値はまずゲームデータ（下記）から取る。データに無いものは攻略 wiki の値、それも無ければ仮の値（docs/ の仕様書に「仮」と明記）。
- 素質・スキルの「味方【陣営】」へのバフや効果は、特に断りがなければ本人（その陣営に所属するオペレーター自身）にも乗ると解釈する（ユーザーの指摘。ムリナールS3・素質など）。
- 「物理・術ダメージをX軽減」でなく「ダメージをX軽減」のように**種別の指定がない効果は、確定ダメージ（マスのダメージ含む）にも効く**と解釈する。
- 名前は日本版（Yostar 版データ）の表記。日本版に無いものは大陸版の名前を日本語の字体に直す（`scripts/extract_battle.py` の `ENEMY_NAME_OVERRIDES` など）。ユーザーから呼び名の指定があればそれに従う（例：「仮想敵：淤困」→「仮想敵：泥濘」）。
- シミュレーションは**決定的**（確率は累積方式で `ACC_START = 0.5` から。乱数はボスのランダム対象・手下の移動の xorshift のみ）。
- 変更のたびに：型チェック → テスト → README／docs/rules.md／docs/battle.md 更新（素質を変えたら `docs/talents.md` も再生成）→ コミット → `main` に直接 push。

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

- 戦闘で使うスキルはイベントデータの `defaultSkillIndex`。ユーザーの指定で変える時は `scripts/skill_choice.py` の `SKILL_INDEX_OVERRIDES`（両方の抽出スクリプトが使う。今はメテオ→S1）
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
- リプレイの敵フレームのフラグ（`e[4]`）：1 解放された囚人 / 2 スタン / 4 恐怖 / 8 ステルス / 16 活性源石の上 / 32 石像形態 / 64 飛行形態になった石像 / 128 寒冷 / 256 凍結 / 512 戦慄 / 1024 バインド。フレームのその他：`lf` 離陸中、`dl` 身替り中、`tk` 紙人形、`mv` 【強襲】で再配置された味方の位置と向き、`zr` ザーロ、`sg`/`sc` サルゴン・シラクーザ、`kz` カジミエーシュの攻撃力上昇（%）、`st` ステルスの味方、`us` ステータス表示用の値（最大HP・HP・攻撃力・防御力・攻撃速度・攻撃間隔・術耐性。`sim.ts` の `statFrame`、表示は `battleView.ts` の `drawStats`。オペレーターをクリックで選択）。
- fx の種類：0 命中 / 1 円 / 2 範囲 / 3 敵の射撃 / 4 治療 / 5 範囲効果 / 6 汚染秽蝕 / 7 3×3 の範囲（スタン・爆発）/ 8 剣雨 / 9 ザーロ / 10 レミュアンのロックオン / 11 レミュアンの爆撃の着弾（砲弾が落ちる時間付き）/ 12 帝国砲撃誘導機の砲撃 / 13 専用のスキル演出（`SKILL_FX`：ノーシスS2・凛御シルバーアッシュS2・シルバーアッシュS3・聖聆プラマニクスS3。命中した敵の位置付き。描画は `battleView.ts` の `drawSkillFx`）。 / 14 グレイディーアS3の渦（生成・ダメージ・消滅。`sim.ts` の `openVortex`・`tickVortex`・`closeVortex`、描画は `battleView.ts` の `drawVortex`・`drawVortexPulse`。渦の本体は敵の下のレイヤー `fxUnder` に描く）。 / 15 ウルサス軍重野砲の燃焼区域（`sim.ts` の `burnZones`、`tickPollution` でダメージ）。

## 最近やったこと（このセッション）

- 海溝の実験体（固定値のダメージ軽減・【エーギル】の反撃）、冑の当たり判定を左の列まで拡張、ボス戦は冑を倒すと即終了、冑の HP を絶境の値に
- スキル中に攻撃しない／する（スズランS3・クオーラ・キャサリン・バブル・アンジェリーナS3・荒蕪ラップランドS3）、ティッピS2（離陸）
- 傀儡師（カゼマル・帰溟スペクター）の身替り、紙人形、素質、堅守特性
- 敵：バクダンバチ、祝祭のジャズ奏者、掠海のフローター、枯朽サルカズ戦車、墓守の石像、「帝国の甲冑」、仮想敵：泥濘。飛行の敵の飛行経路。活性源石の上の敵の表示
- リプレイ：敵の寒冷・凍結の表示（水色の縁と雪の結晶／氷塊、凍った瞬間の破片、再生バーの数）、ノーシスS2・シルバーアッシュS3・凛御シルバーアッシュS2・聖聆プラマニクスS3の専用演出（fx 13）。スキル名の表示と山のマークはユーザーの希望で入れていない

- 鈎縄師（`'hookmaster'`、グレイディーア）も `RANGED_TRAIT_SUBPROF` で常に対空。S3の渦（バインド・減速・1.5秒ごとの術ダメージと引き寄せ）は `sim.ts` の `openVortex` など
- 領主（`subProfession === 'lord'`）の特性：飛行の敵も攻撃、自身がブロックしていない敵へは攻撃力80%（`sim.ts` の `hitsAir`・`lordScale`、スキル中に100%になるのは `LORD_FULL_ATK_SKILL`）。凛御シルバーアッシュS2・デーゲンブレヒャーS3は対空（`SKILL_ANTI_AIR`）。偵察兵（`'agent'`、イネス）と哨戒衛士（`'shotprotector'`、アンダーフロー・リスカム・サンクタ・ミキサー）も特性「遠距離攻撃も行える」で常に対空（`RANGED_TRAIT_SUBPROF`）、攻撃力の低下なし
- デーゲンブレヒャー：剣豪の特性（通常攻撃2回）、素質（累積方式で攻撃力160%と戦慄、戦慄の敵に防御力25%無視）、S3を斬撃10回＋最後の一撃のモーション（`sim.ts` の `BLKKGT`・`motionLen`/`slashLeft`。モーション中はスキル中扱いでゲージが減り、通常攻撃・SP回復なし）。敵の状態「戦慄」（`trembleUntil`：ブロック中は通常攻撃しない）。リプレイはモーション中にスキル範囲を表示（`SKILL_RANGE_SHOWN`）、戦慄の敵に「慄」の印

- 精鋭のモジュールによる通常時の攻撃範囲の拡大（`extract_battle.py` の `module_range`：範囲拡大の隠し素質 prefabKey "10"。フィリオプシス・レオンハルト・シー）
- 戦闘結果のダメージグラフを種別で色分け（`SimUnitResult.byKind`：物理・術・確定・元素。`deal()` の第4引数で種別を渡す）。回復と、バリアが防いだ量（`barrier`、`Runtime.barrierBy` の味方の実績）も同じバーに積む

- 「サンクタの翼」「サンクタの眼」：HP半分以下で一度だけ恐怖と加速（`EnemySpec.selfFear`、`sim.ts` の `checkSelfFear`）、眼の弾薬奪取（`attack.stealAmmo`）
- イネス：素質のバインド（`rootEnemy`・`Enemy.rootUntil`）、退場で奪った攻撃力を返して影哨を残す（`inesLeaves`・`inesSentinels`）、S2の自身のステルスと攻撃速度の奪取（`Enemy.stolenAspd`・`enemyAspdRate`）
- 【強襲】の再配置（`sim.ts` の `raidRelocate`・`placeAt`、`BattleGlobals.raid`）：10秒攻撃しないかスキル準備完了で範囲内に敵がいなければ、地上の敵の周囲へ移る（配置時の効果も発動。撤退・再配置はその位置）。攻撃力・HP+25%（+1%／層）はスキル発動中だけ（`raidSkillBuff`、移動とは無関係。ユーザー確認済み）。リプレイは赤い枠と「襲」の印（コマの `mv`）
- 【カジミエーシュ】の攻撃力は戦闘中の配置回数（`sim.ts` の `deployCount`・`countDeploy`・`kazimierzAtk`、`BattleGlobals.kazimierz`）。所属者が配置中かに関係なく全員にかかる（ユーザー確認済み）。〈配置時〉の堅守特性（`GarrisonEvent` の `deploy`）は戦闘中の再配置でも発動
- 被撃回復のスキル（`SkillModel.charge === 'hit'`、`hurt()` の先頭で SP+1）、ブレミシャインの「盾剣騎士」（`blemishineSp`）、リスカムS2の自身のスタン・スキルの確率スタン（`skillStun`）。エステルS2の治療対象外は未実装
- 解放者（ムリナール）の特性：スキル中だけ攻撃・ブロック、通常時に攻撃力が40秒で+200%まで上昇しスキル終了でリセット（`sim.ts` の `liberatorAtk`・`LIBRATOR_*`、`Runtime.liberStack`/`liberKills`）。S3の特性2倍（撃破ごとに-10%）と、【カジミエーシュ】（自身を含む）の攻撃への確定ダメージ（`strike()` 内）。素質「我関せず」の挑発と反撃（`mlynarCounter`）
- 「次の通常攻撃時」のスキル（`SkillModel.nextAttack`）：通常攻撃の置き換え、チャージ（`charges`：SPを spCost×N まで溜め、発動ごとに spCost を使う）、ミニマリストの2連続・バグパイプの追加の一撃（`hits`）、マドロックのスキル範囲の地上の敵全員（`allGround`）、シーのスプラッシュ拡大（`splashRadius`）
- 仮想敵：黒雲の吞み込み（`EnemySpec.devour`：周囲の飛行の敵をバインド→吞み込んで弾薬）と全弾発射（`salvo`）。`sim.ts` の `tickBlackCloud`・`stopDevour`、`Enemy.boundBy`/`devoured`（懸賞に数えない）

## 仮の値・未確認の点（ユーザーに伝え済み）

- カゼマルS2の紙人形：1体だけ・前方優先・スキル終了で消える。攻撃力は本家トークンの比で約1.117倍
- 傀儡師の入れ替わり時の HP は最大値（身替りになる時も本体に戻る時も）
- バクダンバチの加速は +200%（`move_speed 2.0` の解釈）
- 祝祭のジャズ奏者の「狂宴の刻」は未実装（このモードに無いと判断）
- 枯朽サルカズ戦車の汚染秽蝕の半径 1、「帝国の甲冑」の連撃の倍率は通常と同じ、泥濘の爆発で広がる元素損傷は 500、墓守の石像の飛行形態は HP を引き継ぎ障害物を無視して直進
- 冑の無人機の HP はボスの最大 HP×2%、弾の速さ・手下の突進の速さ（1マス/秒）は仮
- 撃ち落とされた剣・鎚は20秒（`special_stun_duration`）で復帰してボスのそばへ戻る（解釈）。受けたダメージがボスに伝わる割合100%は仮
- 飛行経路の斜めの区間は1マスずつ斜めに進む（本家より少し速い）
- 領主の遠距離攻撃の判定は「自身がブロックしていない敵への攻撃」、80%は通常攻撃の本体のダメージだけに掛ける
- SelfFear の move_speed 1.5 は+150%（バクダンバチと同じ加算の解釈）。眼に奪われた弾は「弾薬消費」に数えない
- イネスの奪った攻撃力は対象が倒れても残る（退場で消える）。影哨は撃破でも撤退でも残り、範囲は通常の攻撃範囲、リプレイには描かない。影哨の効果の範囲はS2中は拡大後の範囲
- デーゲンブレヒャーS3：最初の斬撃は発動と同時、最後の一撃は10回目の0.3秒後（モーション3.0秒）。最後の一撃の対象も最大 max_target 体。引き寄せは未再現。素質で付いた戦慄による防御無視は次のダメージから
- 【強襲】：対象は防衛地点に最も近い地上の敵、置き場所はその周囲8マス（敵のマスを含む）から、範囲内の敵の数 → ブロックできるか → 近さ → 範囲内の経路マスの数で選ぶ。（配置時の効果が発動すること、撤退・再配置がその位置なこと、強化がスキル中だけなことはユーザー確認済み）
- グレイディーアS3の渦の半径 1.3（`GLADY_VORTEX_RADIUS`）、引き寄せの距離 0.5／1.0マス（`GLADY_PULL`、経路に沿って動かす）、渦の位置は発動時に固定
- ウルサス軍重野砲の燃焼区域のダメージは術（データに種別が無い。ユーザー確認済み）、値は敵の攻撃力の補正を受けない
- 通常のスプラッシュ半径 1.0（`SPLASH_RADIUS`）。シーS1の拡大後の 1.7 は攻略 wiki の値（ユーザー提供）

## まだやっていないこと

- 未再現の素質：`docs/talents.md` で ❌（約39件）・一部（約31件）。スズランの足止め、アンジェリーナの反重力、キャサリンの支援装置など
- スキル：サンクタ・ミキサー（反撃）、レミュアン（ロックオン爆撃）は実装済み（`sim.ts` の `mixerCounter`・`lemuenLock`・`lemuenBombard`）。仮の点は docs/battle.md の「弾薬スキル」の項を参照。素質（ミキサーの防御力・バリア、レミュアンの指名手配）と、リプレイのロックオン・爆撃の演出（fx 10 ロックオン／11 爆撃の発射）も実装済み。爆撃は `LEMUEN_BOMB_*`（最初の着弾0.2秒後・0.3秒間隔・一辺0.4のランダム位置）。fx 11 の時刻は着弾の時刻で、リプレイは砲弾をそれ以前から描く
- 戦術（バンド）の一部：`src/core/data/bands.ts` の `impl: 'partial' | 'none'`
- ボスの HP の難易度をゲーム内で選べるようにする案（ユーザーと話しただけで未着手）
- コキュートスはデータ上攻撃力があるが攻撃しない（ユーザー確認済み、このままで正しい）
