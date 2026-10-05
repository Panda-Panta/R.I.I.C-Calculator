import { PRODUCTION_SINGLETONS } from './productionSingletons'

export type AtomicFacilityType = 'manufacture' | 'trading' | 'power' | 'central' | 'office' | 'dormitory'

export interface AtomicMember {
  name: string
  roomType: AtomicFacilityType
  product?: 'gold' | 'exp'
  minLevel?: number
}

export interface AtomicUnitConfPolicy {
  exhaustRequire?: string[]
  restInFull?: string[]
  restingPriorityLow?: string[]
  restingPriorityHigh?: string[]
  workaholic?: string[]
}

export interface ExternalCountRequirement {
  name: string
  count: number
  pool: string[]
}

export interface AtomicUnit {
  id: string
  name: string
  description: string
  preferredFacilityType: 'manufacture' | 'trading'
  preferredProduct?: 'gold' | 'exp' | 'any'
  coreMembers: AtomicMember[]
  /** Complete alternative core sets. Never require every alternative at once. */
  coreVariants?: { members: AtomicMember[]; requiredPowerCount?: number }[]
  nonCoreMembers?: AtomicMember[]
  nonCoreSkillClasses?: string[]
  allowProductionFillers?: boolean
  thirdMemberWhitelist?: string[]
  perCapitaOutput?: number
  /** User preference, applied only after actual availability and validation. */
  allocationPriority?: number
  /** Optional members to prefer when a legal placement exists, never admission gates. */
  preferredNonCoreMembers?: string[]
  externalRequirements?: ExternalCountRequirement[]
  /** Optional actual-presence plans, not ownership/admission thresholds. */
  presenceBoosts?: { whenMember?: string; pool: string[]; maximumUsefulCount: number }[]
  confPolicy?: AtomicUnitConfPolicy
  adaptToPowerCount?: (powerCount: number, product?: 'gold' | 'exp') => {
    coreMembers: AtomicMember[]
    thirdMemberWhitelist?: string[]
    confPolicy?: AtomicUnitConfPolicy
  }
}

export interface AuxiliaryFacilityCandidate {
  primary: string
  backup: string
  fallbackPrimary?: string
  fallbackBackup?: string
}

export const AUXILIARY_FACILITY_CANDIDATES = {
  meeting: [
    { primary: '伊内丝', backup: '提丰', fallbackPrimary: '星极', fallbackBackup: '陈' },
    { primary: '晓歌', backup: '远山', fallbackPrimary: '暗索', fallbackBackup: '白雪' },
  ],
  factory: [
    { primary: '特克诺', backup: '锡兰', fallbackPrimary: '年', fallbackBackup: '九色鹿' },
  ],
  train: [
    { primary: '左乐', backup: '达利尔', fallbackPrimary: '截云', fallbackBackup: '鞭刃' },
    { primary: '艾丽妮', backup: '达利尔', fallbackPrimary: '火龙S黑角', fallbackBackup: '鞭刃' },
  ],
} as const

export const ATOMIC_UNITS: readonly AtomicUnit[] = [
  // 1. 深海猎人 (5人全核心)
  {
    id: 'abyssal_hunters',
    name: '深海猎人',
    description: '歌蕾蒂娅中枢，斯卡蒂、乌尔比安、安哲拉、幽灵鲨进驻制造站。全员核心，宿舍低优先级保障歌蕾蒂娅快速回满。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    perCapitaOutput: 26,
    coreMembers: [
      { name: '歌蕾蒂娅', roomType: 'central' },
      { name: '斯卡蒂', roomType: 'manufacture' },
      { name: '乌尔比安', roomType: 'manufacture' },
      { name: '安哲拉', roomType: 'manufacture' },
      { name: '幽灵鲨', roomType: 'manufacture' },
    ],
    nonCoreMembers: [{ name: '深巡', roomType: 'trading' }],
    confPolicy: {
      restingPriorityLow: ['乌尔比安', '斯卡蒂', '幽灵鲨', '安哲拉'],
      restingPriorityHigh: ['歌蕾蒂娅'],
    },
  },

  // 2. 自动化体系 (温蒂+森蚺+承曦格雷伊；2/3电自适应，Lancet-2入workaholic)
  {
    id: 'automation',
    name: '自动化体系',
    description: '温蒂+森蚺+承曦格雷伊。3电森蚺进制造，2电森蚺进中枢且Lancet-2进发电站。同站第3人严禁普通散件。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    perCapitaOutput: 47.5,
    coreMembers: [
      { name: '温蒂', roomType: 'manufacture' },
      { name: '森蚺', roomType: 'manufacture' },
      { name: '承曦格雷伊', roomType: 'power' },
    ],
    thirdMemberWhitelist: ['冬时', '异客', '掠风', '清流', '森蚺'],
    adaptToPowerCount: (powerCount: number, product?: 'gold' | 'exp') => {
      const isGold = product === 'gold'
      if (powerCount >= 3) {
        return {
          coreMembers: [
            { name: '温蒂', roomType: 'manufacture', product: isGold ? 'gold' : undefined },
            { name: '森蚺', roomType: 'manufacture', product: isGold ? 'gold' : undefined },
            { name: '承曦格雷伊', roomType: 'power' },
            ...(isGold ? [{ name: '清流', roomType: 'manufacture' as const, product: 'gold' as const }] : []),
          ],
          thirdMemberWhitelist: ['冬时', '异客', '掠风', '清流', '森蚺'],
        }
      }
      // 2-power adaptive
      return {
        coreMembers: [
          { name: '温蒂', roomType: 'manufacture', product: isGold ? 'gold' : undefined },
          { name: '森蚺', roomType: 'central' },
          { name: 'Lancet-2', roomType: 'power' },
          { name: '承曦格雷伊', roomType: 'power' },
          ...(isGold ? [{ name: '清流', roomType: 'manufacture' as const, product: 'gold' as const }] : []),
        ],
        thirdMemberWhitelist: ['冬时', '异客', '掠风', '清流'],
        confPolicy: {
          workaholic: ['Lancet-2'],
        },
      }
    },
  },

  // 3. 红松林骑士 (5人全核心，严禁包含酒神)
  {
    id: 'pinus_sylvestris',
    name: '红松林骑士',
    description: '薇薇安娜与焰尾中枢，野鬃、灰毫、远牙制造站经验。全员核心，不包含酒神。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'exp',
    perCapitaOutput: 28,
    coreMembers: [
      { name: '薇薇安娜', roomType: 'central' },
      { name: '焰尾', roomType: 'central' },
      { name: '野鬃', roomType: 'manufacture', product: 'exp' },
      { name: '灰毫', roomType: 'manufacture', product: 'exp' },
      { name: '远牙', roomType: 'manufacture', product: 'exp' },
    ],
    nonCoreMembers: [
      { name: '玛恩纳', roomType: 'central' },
      { name: '砾', roomType: 'manufacture', product: 'exp' },
    ],
  },

  // 4. 黑钢国际 (4人全核心)
  {
    id: 'blacksteel',
    name: '黑钢国际',
    description: '涤火杰西卡进中枢，水月、香草、杰西卡进制造站。4人全核心。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    perCapitaOutput: 25,
    coreMembers: [
      { name: '涤火杰西卡', roomType: 'central' },
      { name: '水月', roomType: 'manufacture' },
      { name: '香草', roomType: 'manufacture' },
      { name: '杰西卡', roomType: 'manufacture' },
    ],
  },

  // 5. 红云酒神猫猫 (3人强制绑定，不可拆换)
  {
    id: 'vermeil_dionysus',
    name: '红云酒神猫猫',
    description: '红云+酒神+Miss.Christine进作战记录制造站。3人强行绑定，不可拆换。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'exp',
    perCapitaOutput: 48,
    coreMembers: [
      { name: '红云', roomType: 'manufacture', product: 'exp' },
      { name: '酒神', roomType: 'manufacture', product: 'exp' },
      { name: 'Miss.Christine', roomType: 'manufacture', product: 'exp' },
    ],
  },

  // 6. 红云容量组 (2核心+1推荐)
  {
    id: 'vermeil_capacity',
    name: '红云容量组',
    description: '红云+稀音进作战记录制造站，第3人为容量加成散件。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'exp',
    perCapitaOutput: 38,
    coreMembers: [
      { name: '红云', roomType: 'manufacture', product: 'exp' },
      { name: '稀音', roomType: 'manufacture', product: 'exp' },
    ],
    nonCoreMembers: [
      { name: '刻俄柏', roomType: 'manufacture', product: 'exp' },
      { name: '帕拉斯', roomType: 'manufacture', product: 'exp' },
      { name: '卡达', roomType: 'manufacture', product: 'exp' },
      { name: '豆苗', roomType: 'manufacture', product: 'exp' },
    ],
  },

  // 7. 莱茵生命：多萝西单核心，可选增强按实际技能和在场人数计算。
  {
    id: 'rhine_lab',
    name: '莱茵生命',
    description: '多萝西单核心。淬羽赫默与其他增强成员可选；娜斯提按实际入驻的莱茵成员数计算赤金增益，不设人数门槛。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    perCapitaOutput: 35,
    coreMembers: [
      { name: '多萝西', roomType: 'manufacture' },
    ],
    nonCoreMembers: [
      { name: '淬羽赫默', roomType: 'manufacture' },
      { name: '娜斯提', roomType: 'manufacture', product: 'gold' },
      { name: '白面鸮', roomType: 'manufacture' },
      { name: '赫默', roomType: 'manufacture' },
      { name: '星源', roomType: 'manufacture' },
      { name: '梅尔', roomType: 'manufacture' },
      { name: '溯光星源', roomType: 'manufacture' },
    ],
    nonCoreSkillClasses: ['莱茵科技'],
    presenceBoosts: [
      { whenMember: '娜斯提', maximumUsefulCount: 5,
        pool: ['赫默', '伊芙利特', '塞雷娅', '白面鸮', '梅尔', '麦哲伦', '多萝西', '星源', '缪尔赛思', '娜斯提'] },
    ],
  },

  // 8. 苍苔金属工艺 (1核心+2金属)
  {
    id: 'cantabile_metalcraft',
    name: '苍苔金属工艺',
    description: '苍苔单核心，按实际已解锁金属工艺技能比较零、一、两名增强成员。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'gold',
    perCapitaOutput: 35,
    coreMembers: [
      { name: '苍苔', roomType: 'manufacture', product: 'gold' },
    ],
    nonCoreMembers: [
      { name: '砾', roomType: 'manufacture', product: 'gold' },
      { name: '引星棘刺', roomType: 'manufacture', product: 'gold' },
      { name: '斑点', roomType: 'manufacture', product: 'gold' },
      { name: '夜烟', roomType: 'manufacture', product: 'gold' },
      { name: '温米', roomType: 'manufacture', product: 'gold' },
    ],
    nonCoreSkillClasses: ['金属工艺'],
  },

  // 9. 槐琥阿罗玛 (2人核心，无第三人)
  {
    id: 'aroma_waaifu',
    name: '槐琥阿罗玛',
    description: '阿罗玛+槐琥进驻赤金制造站。严格双人核心，无第三人。配置exhaust_require与rest_in_full进行暖机轮转。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'gold',
    perCapitaOutput: 65,
    coreMembers: [
      { name: '阿罗玛', roomType: 'manufacture', product: 'gold' },
      { name: '槐琥', roomType: 'manufacture', product: 'gold' },
    ],
    confPolicy: {
      exhaustRequire: ['阿罗玛', '槐琥'],
      restInFull: ['阿罗玛', '槐琥'],
    },
  },

  // 10. 泡泡容量组 (2人核心)
  {
    id: 'bubble_capacity',
    name: '泡泡容量组',
    description: '泡泡+火神进驻制造站，推荐贝娜提升大容量生产力。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    perCapitaOutput: 38,
    coreMembers: [
      { name: '泡泡', roomType: 'manufacture' },
      { name: '火神', roomType: 'manufacture' },
    ],
    nonCoreMembers: [
      { name: '贝娜', roomType: 'manufacture' },
      { name: '刻俄柏', roomType: 'manufacture' },
    ],
  },

  // 11. 纯感知信息体系：迷迭香与絮雨双核心，黑键可选。
  {
    id: 'pure_perception',
    name: '纯感知信息体系',
    description: '迷迭香制造站、絮雨办公室为核心。黑键贸易站及宿舍/中枢支持可选。独立于人间烟火。',
    preferredFacilityType: 'manufacture',
    perCapitaOutput: 35,
    allocationPriority: 1,
    preferredNonCoreMembers: ['黑键'],
    coreMembers: [
      { name: '迷迭香', roomType: 'manufacture' },
      { name: '絮雨', roomType: 'office' },
    ],
    nonCoreMembers: [
      { name: '黑键', roomType: 'trading' },
      { name: '爱丽丝', roomType: 'dormitory' },
      { name: '车尔尼', roomType: 'dormitory' },
      { name: '琴柳', roomType: 'central' },
    ],
  },

  // 12. 感知+人间烟火体系：五人核心，黑键有则优先。
  {
    id: 'perception_fireworks',
    name: '感知+人间烟火双核体系',
    description: '迷迭香制造、絮雨办公室、乌有贸易、夕与令中枢为核心。黑键可选且有则优先，使用时与乌有分驻两个贸易站；爱丽丝与车尔尼为宿舍支持。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 36,
    allocationPriority: 1,
    preferredNonCoreMembers: ['黑键'],
    coreMembers: [
      { name: '迷迭香', roomType: 'manufacture' },
      { name: '絮雨', roomType: 'office' },
      { name: '乌有', roomType: 'trading' },
      { name: '夕', roomType: 'central' },
      { name: '令', roomType: 'central' },
    ],
    nonCoreMembers: [
      { name: '黑键', roomType: 'trading' },
      { name: '桑葚', roomType: 'office' },
      { name: '爱丽丝', roomType: 'dormitory' },
      { name: '车尔尼', roomType: 'dormitory' },
    ],
  },

  // 13. 鸿雪4杜林体系 (2贸易核心+4杜林强制)
  {
    id: 'pozemka_durin',
    name: '鸿雪4杜林体系',
    description: '鸿雪+图耶贸易核心。绮良与杜林在场支持可选，按实际人数和虚拟赤金线计算，不设人数准入门槛。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 46,
    coreMembers: [
      { name: '鸿雪', roomType: 'trading' },
      { name: '图耶', roomType: 'trading' },
    ],
    nonCoreMembers: [
      { name: '绮良', roomType: 'trading' },
    ],
    presenceBoosts: [
      { maximumUsefulCount: 4, pool: ['杜林', '桃金娘', '褐果', '至简'] },
    ],
  },

  // 14. 企鹅物流 (2人核心，排除空)
  {
    id: 'penguin_logistics',
    name: '企鹅物流',
    description: '德克萨斯+拉普兰德进驻贸易站。第3人匹配高效率散件，排除空。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 33,
    coreMembers: [
      { name: '德克萨斯', roomType: 'trading' },
      { name: '拉普兰德', roomType: 'trading' },
    ],
    nonCoreMembers: [
      { name: '能天使', roomType: 'trading' },
    ],
    allowProductionFillers: true,
  },

  // 15. 拉特兰商道 (2人双核心，无第三人)
  {
    id: 'laterano',
    name: '拉特兰商道',
    description: '蕾缪安+能天使进驻贸易站。严格双人核心，无第三人。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 43,
    coreMembers: [
      { name: '蕾缪安', roomType: 'trading' },
      { name: '能天使', roomType: 'trading' },
    ],
  },

  // 16. 叙拉古组 (2人核心)
  {
    id: 'siracusa',
    name: '叙拉古组',
    description: '伺夜+贝洛内进驻贸易站，八幡海铃进驻中枢加成。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 35,
    coreMembers: [
      { name: '伺夜', roomType: 'trading' },
      { name: '贝洛内', roomType: 'trading' },
    ],
    nonCoreMembers: [
      { name: '八幡海铃', roomType: 'central' },
    ],
  },

  // 17. 格拉斯哥帮 (2人核心)
  {
    id: 'glasgow',
    name: '格拉斯哥帮',
    description: '推进之王+摩根进驻贸易站，戴菲恩进驻中枢。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 28,
    coreMembers: [
      { name: '推进之王', roomType: 'trading' },
      { name: '摩根', roomType: 'trading' },
    ],
    nonCoreMembers: [
      { name: '戴菲恩', roomType: 'central' },
    ],
  },

  // 18. 喀兰贸易 (3人核心)
  {
    id: 'karlan',
    name: '喀兰贸易',
    description: '银灰+孑进驻贸易站，灵知进驻中枢。',
    preferredFacilityType: 'trading',
    perCapitaOutput: 30,
    coreMembers: [
      { name: '银灰', roomType: 'trading' },
      { name: '孑', roomType: 'trading' },
      { name: '灵知', roomType: 'central' },
    ],
    nonCoreMembers: [
      { name: '崖心', roomType: 'trading' },
      { name: '琳琅诗怀雅', roomType: 'trading' },
    ],
  },
  {
    id: 'monster_hunter',
    name: '怪物猎人',
    description: '焰狐龙梓兰与雷狼龙S空爆贸易双核心，按实际解锁的泡影国狩猎小队技能计算。',
    preferredFacilityType: 'trading',
    coreMembers: [
      { name: '焰狐龙梓兰', roomType: 'trading' },
      { name: '雷狼龙S空爆', roomType: 'trading' },
    ],
  },
  {
    id: 'laterano_alter',
    name: '拉特兰商道-2',
    description: '蕾缪安、新约能天使与安比尔或空弦同站。空弦仅在三座已建造电站的布局下使用。',
    preferredFacilityType: 'trading',
    coreMembers: [
      { name: '蕾缪安', roomType: 'trading' },
      { name: '新约能天使', roomType: 'trading' },
    ],
    coreVariants: [
      { members: [{ name: '蕾缪安', roomType: 'trading' }, { name: '新约能天使', roomType: 'trading' }, { name: '安比尔', roomType: 'trading' }] },
      { members: [{ name: '蕾缪安', roomType: 'trading' }, { name: '新约能天使', roomType: 'trading' }, { name: '空弦', roomType: 'trading' }], requiredPowerCount: 3 },
    ],
  },
  {
    id: 'mizuki_standardization',
    name: '水月组',
    description: '水月单核心，按当前已解锁的标准化类技能展开可选成员并比较整站效率。',
    preferredFacilityType: 'manufacture',
    preferredProduct: 'any',
    coreMembers: [{ name: '水月', roomType: 'manufacture' }],
    nonCoreSkillClasses: ['标准化'],
  },
] as const

export const HIGH_EFFICIENCY_SINGLETONS = {
  ...PRODUCTION_SINGLETONS,
  control: ['缪尔赛思', '凯尔希', '阿米娅', '琴柳', '玛恩纳', '维娜·维多利亚', '早露', '灰风'],
  durinRace: ['杜林', '桃金娘', '褐果', '至简'],
} as const

export const ALL_ATOMIC_CORE_NAMES: ReadonlySet<string> = new Set(
  ATOMIC_UNITS.flatMap((u) => [...u.coreMembers, ...(u.coreVariants?.flatMap(v => v.members) ?? [])].map((m) => m.name)),
)
