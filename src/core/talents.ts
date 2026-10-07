// オペレーターの素質（本家の通常の素質）。
// 戦闘開始時に決まる補正（自身・周囲・職業への効果）はここで計算し、
// 戦闘中に変化するもの（HPに応じた攻撃速度、撃破で上昇、被弾時の効果など）は sim.ts で扱う。
// 各素質の再現状況は TALENT_STATUS にまとめ、画面と docs/talents.md に表示する。

import { cellX, cellY, neighbors, tileAt, unitRangeCells } from './board';
import { getUnit, unitState } from './data/units';
import type { AllianceId, Modifier, OwnedUnit, Profession, UnitDef } from './types';

/** 素質の blackboard（i 番目） */
export function talentBB(def: UnitDef, star: 1 | 2, i: number): Record<string, number> {
  const t = unitState(def, star).talents?.[i];
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(t?.blackboard ?? {})) if (typeof v === 'number') out[k] = v;
  return out;
}

/** 地面マス（高台・配置不可のマス以外） */
const isLowland = (pos: number) => !['wall', 'high'].includes(tileAt(pos));

/** 【アビサルハンター】 */
export const ABYSSAL = new Set(['char_263_skadi', 'char_143_ghost', 'char_474_glady', 'char_1012_skadi2', 'char_1023_ghost2', 'char_4145_ulpia']);

/** 戦闘開始時の素質の補正（自身・周囲・職業など） */
export function applyTalentMods(
  board: OwnedUnit[],
  bondsOf: (o: OwnedUnit) => AllianceId[],
  apply: (uids: Iterable<number>, d: Modifier) => void,
): { initialCost: number } {
  let initialCost = 0;
  const defOf = (o: OwnedUnit) => getUnit(o.defId);
  const byProf = (p: Profession) => board.filter((o) => defOf(o).profession === p).map((o) => o.uid);
  const byBond = (b: AllianceId) => board.filter((o) => bondsOf(o).includes(b)).map((o) => o.uid);
  const abyssal = board.filter((o) => ABYSSAL.has(defOf(o).charId)).map((o) => o.uid);
  const inRange = (o: OwnedUnit) => new Set(o.pos === undefined ? [] : unitRangeCells(o));
  for (const o of board) {
    const def = defOf(o);
    const t0 = talentBB(def, o.star, 0);
    const t1 = talentBB(def, o.star, 1);
    const self = [o.uid];
    switch (def.charId) {
      case 'char_199_yak': // マッターホルン：術耐性
        apply(self, { resFlat: t0.magic_resistance });
        break;
      case 'char_107_liskam': // リスカム：術耐性（2つ目）
        apply(self, { resFlat: t1.magic_resistance ?? 0 });
        break;
      case 'char_150_snakek': // クオーラ：防御力
        apply(self, { defPct: t0.def });
        break;
      case 'char_143_ghost': // スペクター：最大HP・HP回復
        apply(self, { hpPct: t0.max_hp, regenPct: t0.hp_recovery_per_sec_by_max_hp_ratio });
        break;
      case 'char_4122_grabds': // グレインバッズ：攻撃速度
        apply(self, { aspd: t0.attack_speed });
        break;
      case 'char_103_angel': {
        // エクシア：攻撃速度。天使の祝福は自身と味方1人（ランダムの代わりに最も後に配置された味方）
        apply(self, { aspd: t0.attack_speed });
        if (t1.atk !== undefined) {
          const ally = board.filter((x) => x !== o).at(-1);
          apply([o.uid, ...(ally ? [ally.uid] : [])], { atkPct: t1.atk, hpPct: t1.max_hp });
        }
        break;
      }
      case 'char_294_ayer': // エアースカーペ：自身と周囲8マスの攻撃速度
        apply([o.uid, ...neighbors(board, o, true).map((x) => x.uid)], { aspd: t0.attack_speed });
        break;
      case 'char_308_swire': // スワイヤー：周囲8マスの近距離の攻撃力
        apply(neighbors(board, o, true).filter((x) => defOf(x).position === 'melee').map((x) => x.uid), { atkPct: t0.atk });
        break;
      case 'char_263_skadi': // スカジ：アビサルハンターの攻撃力、再配置時間
        apply(abyssal, { atkPct: t0.atk });
        if (t1.respawn_time) apply(self, { respawnFlat: t1.respawn_time });
        break;
      case 'char_388_mint': // ミント：隣接4マスの防御力（スキル未発動時の効果を常に）
        apply(neighbors(board, o, false).map((x) => x.uid), { defPct: t0.def });
        break;
      case 'char_4013_kjera': {
        // イェラ：攻撃範囲内に地面マスが3つ以上なら攻撃力上昇が大きい
        const ground = [...inRange(o)].filter((c) => isLowland(c)).length;
        apply(self, { atkPct: ground > (t0.cnt ?? 2) ? t0['kjera_t_1[high].atk'] : t0.atk });
        break;
      }
      case 'char_431_ashlok': {
        // アッシュロック：隣接4マスがすべて地面マスなら攻撃力上昇が大きい
        const adj = o.pos === undefined ? [] : [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => [cellX(o.pos!) + dx, cellY(o.pos!) + dy]);
        const allGround = adj.length === 4 && adj.every(([x, y]) => x >= 0 && y >= 0 && x < 9 && y < 4 && isLowland(y * 9 + x));
        apply(self, { atkPct: allGround ? t0['ashlok_t_1.atk'] : t0.atk });
        break;
      }
      case 'char_136_hsguma': // ホシグマ：重装の防御力（2つ目）
        if (t1.def) apply(byProf('defender'), { defPct: t1.def });
        break;
      case 'char_4039_horn': // ホルン：重装の攻撃力
        apply(byProf('defender'), { atkPct: t0.atk });
        break;
      case 'char_4058_pepe': // ペペ：前衛の攻撃力（2つ目）
        if (t1.atk) apply(byProf('guard'), { atkPct: t1.atk });
        break;
      case 'char_258_podego': // ポデンコ：補助の攻撃力
        apply(byProf('supporter'), { atkPct: t0.atk });
        break;
      case 'char_108_silent': // サイレンス：医療の攻撃速度
        apply(byProf('medic'), { aspd: t0.attack_speed });
        break;
      case 'char_222_bpipe': // バグパイプ：先鋒の初期SP（2つ目）
        if (t1.sp) apply(byProf('vanguard'), { startSp: t1.sp });
        break;
      case 'char_1038_whitw2': // 荒蕪ラップランド：シラクーザの初期SP（2つ目）
        if (t1.sp) apply(byBond('siracusa'), { startSp: t1.sp });
        break;
      case 'char_237_gravel': // グラベル：配置コスト10以下の防御力
        apply(
          board.filter((x) => unitState(defOf(x), x.star).stats.cost <= (t0['cond.cost'] ?? 10)).map((x) => x.uid),
          { defPct: t0.def },
        );
        break;
      case 'char_172_svrash': // シルバーアッシュ：攻撃力、全員の再配置時間
        apply(self, { atkPct: t0.atk });
        apply(board.map((x) => x.uid), { respawnPct: t0.respawn_time });
        break;
      case 'char_1041_angel2': {
        // 新約エクシア：弾薬消費系スキルの攻撃力（ラテラーノは倍）
        const b = t1.atk !== undefined ? t1 : t0;
        if (b.atk === undefined) break;
        for (const x of board) {
          if (unitState(defOf(x), x.star).skill.durationType !== 'AMMO') continue;
          apply([x.uid], { atkPct: b.atk * (bondsOf(x).includes('laterano') ? (b.mult ?? 2) : 1) });
        }
        break;
      }
      case 'char_291_aglina': // アンジェリーナ：全員の攻撃速度
        apply(board.map((x) => x.uid), { aspd: t0.attack_speed });
        break;
      case 'char_1039_thorn2': // 引星ソーンズ：攻撃力、全員の攻撃速度
        apply(self, { atkPct: t0.atk });
        if (t1.attack_speed_ally) apply(board.map((x) => x.uid), { aspd: t1.attack_speed_ally });
        break;
      case 'char_213_mostma': // モスティマ：術師のSP回復
        apply(byProf('caster'), { spRegenTalent: t0.sp_recovery_per_sec });
        break;
      case 'char_128_plosis': // フィリオプシス：全員のSP回復
        apply(board.map((x) => x.uid), { spRegenTalent: t0.sp_recovery_per_sec });
        break;
      case 'char_358_lisa': // スズラン：補助のSP回復
        apply(byProf('supporter'), { spRegenTalent: t0.sp_recovery_per_sec });
        break;
      case 'char_440_pinecn': // パインコーン：配置後のSP回復
        apply(self, { spRegen: t0.sp_recovery_per_sec });
        break;
      case 'char_1023_ghost2': // 帰溟スペクター：アビサルハンターの最大HP（2つ目）
        if (t1.max_hp) apply(abyssal, { hpPct: t1.max_hp });
        break;
      case 'char_474_glady': // グレイディーア：アビサルハンターのHP回復
        apply(abyssal, { regenPct: t0.hp_recovery_per_sec_by_max_hp_ratio });
        break;
      case 'char_391_rosmon': {
        // ロスモンティス：防御力無視、自身と術師1名の攻撃力（ランダムの代わりに最初の術師）
        apply(self, { defIgnoreFlat: t0.def_penetrate_fixed });
        if (t1.atk) {
          const caster = board.find((x) => x !== o && defOf(x).profession === 'caster');
          apply([o.uid, ...(caster ? [caster.uid] : [])], { atkPct: t1.atk });
        }
        break;
      }
      case 'char_279_excu': // イグゼキュター：防御力無視
        apply(self, { defIgnoreFlat: t0.def_penetrate_fixed });
        break;
      case 'char_350_surtr': // スルト：術耐性無視
        apply(self, { resIgnoreFlat: t0.magic_resist_penetrate_fixed });
        break;
      case 'char_1014_nearl2': // 耀騎士ニアール：防御力無視（2つ目）
        if (t1.def_penetrate) apply(self, { defIgnorePct: t1.def_penetrate });
        break;
      case 'char_264_f12yin': // マウンテン：防御力・物理回避（2つ目）
        if (t1.def !== undefined) apply(self, { defPct: t1.def, evadePhys: t1.prob });
        break;
      case 'char_1019_siege2': {
        // ヴィーナ・ヴィクトリア：自身と周囲8マスの物理被ダメージ軽減、攻撃範囲内の味方1人ごとに攻撃力
        apply([o.uid, ...neighbors(board, o, true).map((x) => x.uid)], { physReduce: t0.damage_resistance });
        const cells = inRange(o);
        const allies = board.filter((x) => x !== o && x.pos !== undefined && cells.has(x.pos)).length;
        apply(self, { atkPct: (t0.atk ?? 0) * allies });
        break;
      }
      case 'char_420_flamtl': // フレイムテイル：カジミエーシュの物理回避（2つ目）
        if (t1.prob) apply(byBond('kazimierz'), { evadePhys: t1.prob });
        break;
      case 'char_102_texas': // テキサス：初期所持コスト
        initialCost += t0.cost ?? 0;
        break;
      case 'char_1012_skadi2': {
        // 濁心スカジ：攻撃範囲内に味方がいれば攻撃力（アビサルハンターなら大きく）
        const b = t1['skadi2_t_2[atk][1].atk'] !== undefined ? t1 : t0;
        const cells = inRange(o);
        const allies = board.filter((x) => x !== o && x.pos !== undefined && cells.has(x.pos));
        if (allies.some((x) => ABYSSAL.has(defOf(x).charId))) apply(self, { atkPct: b['skadi2_t_2[atk][2].atk'] });
        else if (allies.length) apply(self, { atkPct: b['skadi2_t_2[atk][1].atk'] });
        break;
      }
      case 'char_1045_svash2': {
        // 凛御シルバーアッシュ：イェラグの防御力・HP回復（2つ目。15秒後の倍増は未再現）
        const b = t1.def !== undefined ? t1 : t0;
        if (b.def !== undefined) apply(byBond('kjerag'), { defFlat: b.def, regenPct: b.hp_recovery_per_sec_by_max_hp_ratio });
        break;
      }
      case 'char_1032_excu2': {
        // 聖約イグゼキュター：味方のラテラーノ1名につき弾薬+1（最大4）
        if (t1.add_count) {
          const n = board.filter((x) => x !== o && bondsOf(x).includes('laterano')).length;
          apply(self, { ammoFlat: Math.min(n * t1.add_count, t1.add_count_max_stack ?? 4) });
        }
        break;
      }
      case 'char_498_inside': // インサイダー：弾薬+3（配置から20秒後の条件は省略）
        apply(self, { ammoFlat: t0.self_ammo });
        break;
      case 'char_4193_lemuen': // レミュアン：攻撃力・弾薬（配置から20秒後の条件は省略）
        if (t1.atk !== undefined) apply(self, { atkPct: t1.atk, ammoFlat: t1.add_count });
        break;
      case 'char_4056_titi': // ティティ：サルゴンの攻撃速度（HP50%以上の条件は省略、2つ目）
        if (t1.attack_speed) apply(byBond('sargon'), { aspd: t1.attack_speed });
        break;
      case 'char_1026_gvial2': // 百錬ガヴィル：攻撃力・防御力（ブロック数による上昇は戦闘中）
        apply(self, { atkPct: t0.atk, defPct: t0.def });
        break;
      case 'char_1016_agoat2': {
        // 純燼エイヤフィヤトラ：攻撃範囲内の味方の最大HP（2つ目）
        if (!t1.max_hp) break;
        const cells = inRange(o);
        apply(board.filter((x) => x.pos !== undefined && cells.has(x.pos)).map((x) => x.uid), { hpPct: t1.max_hp });
        break;
      }
    }
  }
  return { initialCost };
}

// ------------------------------------------------------------
// 再現状況
// ------------------------------------------------------------

export type TalentImpl = 'full' | 'partial' | 'none';

/**
 * 素質ごとの再現状況（キャラクターID → 素質の順番どおり）。
 * 載っていない素質は未再現。確率の効果は期待値（確率を累積し、1に達するたびに発生）で扱う。
 */
export const TALENT_STATUS: Record<string, [TalentImpl, string?][]> = {
  char_498_inside: [['partial', '配置から20秒後の条件と、味方【ラテラーノ】への付与は省略（常に弾薬+3）']],
  char_199_yak: [['full']],
  char_306_leizi: [['full']],
  char_4137_udflow: [['partial', '海の怪物への倍増は未再現（敵の種類が無いため）']],
  char_494_vendla: [['none']],
  char_145_prove: [['partial', '確率は期待値。正面1マスの敵で確率が上がる効果は未再現']],
  char_102_texas: [['full']],
  char_4100_caper: [['full', '確率は期待値']],
  char_196_sunbr: [['partial', '確率は期待値。スタンは未再現']],
  char_127_estell: [['full']],
  char_258_podego: [['full']],
  char_253_greyy: [['none', '足止めは未再現']],
  char_469_indigo: [['none', 'バインドは未再現']],
  char_337_utage: [['full']],
  char_496_wildmn: [['none', '配置コストの変化は未再現']],
  char_107_liskam: [['full'], ['full']],
  char_279_excu: [['full']],
  char_108_silent: [['full']],
  char_4122_grabds: [['partial', '攻撃速度のみ（足止めの延長は未再現）']],
  char_4114_harold: [['full']],
  char_4139_papyrs: [['partial', 'バリアの持続時間（8秒）は未再現']],
  char_143_ghost: [['full']],
  char_381_bubble: [['full']],
  char_491_humus: [['full']],
  char_4040_rockr: [['full']],
  char_4016_kazema: [['full']],
  char_237_gravel: [['partial', '自身の配置コスト-1は未再現']],
  char_4191_tippi: [['full']],
  char_181_flower: [['full']],
  char_140_whitew: [['full']],
  char_4207_branch: [['full']],
  char_431_ashlok: [['full']],
  char_4151_tinman: [['none', '本家の別モード用の素質'], ['full']],
  char_103_angel: [['full'], ['partial', 'ランダムな味方1人は、最後に配置された味方で代用']],
  char_294_ayer: [['full']],
  char_308_swire: [['full']],
  char_1033_swire2: [['full'], ['full']],
  char_263_skadi: [['full'], ['full']],
  char_4148_philae: [['full']],
  char_388_mint: [['partial', 'スキル中も防御力上昇が続く。狙われにくさは未再現']],
  char_4079_haini: [['full']],
  char_440_pinecn: [['partial', '60秒の制限なし']],
  char_4211_snhunt: [['full']],
  char_423_blemsh: [['full'], ['none', '睡眠は未再現']],
  char_4054_malist: [['full', '確率は期待値']],
  char_174_slbell: [['full'], ['full']],
  char_150_snakek: [['full']],
  char_126_shotst: [['full']],
  char_4026_vulpis: [['full'], ['full']],
  char_427_vigil: [['none', '召喚は未再現'], ['none', '召喚は未再現']],
  char_4013_kjera: [['full']],
  char_332_archet: [['full'], ['full']],
  char_4194_rmixer: [['full'], ['full', 'バリアは攻撃を受けた時に先に削られる']],
  char_213_mostma: [['full'], ['full']],
  char_4087_ines: [['full', '奪った攻撃力は対象が倒れても残る（仮）'], ['full', '影哨の範囲は通常の攻撃範囲（仮）']],
  char_1021_kroos2: [['partial', '確率は期待値。スタンは未再現']],
  char_222_bpipe: [['partial', '確率は期待値。攻撃対象数+1は未再現'], ['full']],
  char_437_mizuki: [['full'], ['full']],
  char_446_aroma: [['partial', '浮遊は未再現']],
  char_4162_cathy: [['partial', '支援装置を戦闘開始時（配置時）に自動で2個置く。支援先は敵をブロックする味方・最大HPの高い順']],
  char_474_glady: [['partial', '海の怪物からの被ダメージ軽減は未再現'], ['none', '敵の重量が無いため未再現']],
  char_206_gnosis: [['full'], ['none', '状態異常が無いため未再現']],
  char_373_lionhd: [['full']],
  char_1028_texas2: [['full'], ['full']],
  char_136_hsguma: [['full', '確率は期待値'], ['full']],
  char_311_mudrok: [['full'], ['none', '敵の種類（サルカズ）が無いため未再現']],
  char_420_flamtl: [['none'], ['full', '確率は期待値']],
  char_430_fartth: [['full'], ['none']],
  char_128_plosis: [['full']],
  char_172_svrash: [['full'], ['full']],
  char_1026_gvial2: [['full'], ['full']],
  char_426_billro: [['partial', 'オーバーチャージ時の倍増は未再現'], ['none']],
  char_4134_cetsyr: [['partial', 'S3中のみ（スキル外の「微塵」は未再現）'], ['none', '敵の種類（サルカズ）が無いため未再現']],
  char_171_bldsk: [['full']],
  char_1032_excu2: [['full', '確率は期待値'], ['full']],
  char_4056_titi: [['full', '睡眠中の敵への攻撃・継続ダメージ、移動していない敵への追加ダメージ'], ['partial', 'HP50%以上の条件は省略。【ミノス】は対象外']],
  char_1040_blaze2: [['full'], ['none', 'ダウン状態は未再現']],
  char_4145_ulpia: [['full'], ['full']],
  char_4010_etlchi: [['full'], ['full']],
  char_350_surtr: [['full'], ['full']],
  char_4039_horn: [['full'], ['full']],
  char_358_lisa: [['full'], ['none', '足止めは未再現']],
  char_202_demkni: [['full'], ['full']],
  char_2015_dusk: [['partial', '「小自在」の撃破は数えない'], ['none', '召喚は未再現']],
  char_1023_ghost2: [['full'], ['full']],
  char_1045_svash2: [['none', '待機中のオペレーターが無いため未再現'], ['partial', '15秒後の倍増・凍結無効は未再現']],
  char_1039_thorn2: [['partial', '錬金ユニットの持続時間延長は未再現'], ['partial', '敵の攻撃速度低下と、直線経路での倍増は未再現']],
  char_264_f12yin: [['partial', '確率は期待値。攻撃力低下は未再現'], ['full', '回避は期待値']],
  char_4064_mlynar: [['full'], ['full']],
  char_291_aglina: [['full'], ['full']],
  char_341_sntlla: [['full']],
  char_4146_nymph: [['full'], ['full']],
  char_4196_reckpr: [['full']],
  char_4193_lemuen: [['full', '滞在時間は累計'], ['partial', '配置から20秒後の条件は省略']],
  char_1046_sbell2: [['none', '積雪は未再現'], ['partial', '自身の凍結は行動不能として扱う']],
  char_2026_yu: [['full'], ['full']],
  char_1012_skadi2: [['none', 'シーボーンは未再現'], ['full']],
  char_472_pasngr: [['partial', '3秒間の効果は、HP80%以上の敵への攻撃時のみで代用'], ['full']],
  char_4058_pepe: [['full'], ['full']],
  char_1019_siege2: [['full'], ['none', '戦慄は未再現']],
  char_1020_reed2: [['full', '確率は期待値'], ['none']],
  char_245_cello: [['full'], ['full']],
  char_249_mlyss: [['none', '援軍は未再現'], ['none', '配置コストの変化は未再現']],
  char_391_rosmon: [['full'], ['partial', 'ランダムな術師1名は、最初の術師で代用']],
  char_1041_angel2: [['none'], ['full']],
  char_4042_lumen: [['none', '状態異常が無いため未再現'], ['none', '状態異常が無いため未再現']],
  char_4082_qiubai: [['none'], ['none', 'バインドは未再現']],
  char_1047_halo2: [['none', '停頓は未再現'], ['partial', '7秒の滞在は、出現からの時間で近似']],
  char_1014_nearl2: [['none', '配置時の効果は未再現'], ['full']],
  char_1038_whitw2: [['full', '浮遊ユニットの段階強化（上限+10%・特殊能力無効化・数+1）'], ['full']],
  char_4116_blkkgt: [['full'], ['full']],
  char_1016_agoat2: [['none'], ['full']],
};

/** 素質の再現状況（名前の無い内部用の素質は除く） */
export function talentStatus(def: UnitDef, star: 1 | 2): { name: string; description: string; impl: TalentImpl; note?: string }[] {
  const list = TALENT_STATUS[def.charId] ?? [];
  return (unitState(def, star).talents ?? [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.name)
    .map(({ t, i }) => ({ name: t.name, description: t.description, impl: list[i]?.[0] ?? 'none', note: list[i]?.[1] }));
}
