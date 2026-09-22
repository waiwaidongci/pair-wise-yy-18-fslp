module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  // 配重分层判定参数：超限或重压脆一律整单拒绝
  tourRules: {
    // 偶头单件克重达到该值即视为重偶头
    heavyHeadGrams: 1500,
    // 每只巡演箱同箱总重上限（克）；登记时可逐箱覆盖
    defaultBoxWeightLimitGrams: 4000,
    // 层位约定：数字越小越靠箱底（1 = 底层）
    bottomLayer: 1
  },
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      // 待复核：到场错层/封签不符；解封资格失效后也留在待复核
      statuses: ['草稿', '已装箱', '巡演中', '待复核', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '旦角',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼机关顺畅',
        accessories: ['凤冠', '水袖'],
        boxNo: '木箱甲-01',
        weightGrams: 1200,
        currentUsable: true
      },
      note: '可装箱巡演'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-3',
      status: '可演出',
      data: {
        role: '净角',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '长髯机关顺畅',
        accessories: ['黑满', '蟒靠'],
        boxNo: '木箱甲-02',
        weightGrams: 1900,
        currentUsable: true
      },
      note: '重型偶头，登记需分层避脆'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '凤冠点翠',
        role: '旦角',
        play: '火焰山',
        boxNo: '配件箱-01',
        fragile: true
      },
      note: '点翠脆配件，禁止重偶头压放'
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tour/packing 登记装箱（箱号、层位、单件克重、封签号）',
    'POST /api/tour/boxes/:id/arrival 到场核验（错层或封签不符只转待复核）',
    'POST /api/tour/boxes/:id/return-confirm 返场清点另一人连续两次确认',
    'POST /api/tour/boxes/:id/correct 更正配重或层位（解封与装箱资格失效重算，旧稿留档）',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
