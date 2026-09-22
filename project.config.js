module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱（配重分层）和返场解封台。',
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
      statuses: ['草稿', '已装箱', '巡演中', '待复核', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play'],
      titleFields: ['showName', 'play']
    },
    tourBoxRevisions: {
      label: '装箱旧稿留档',
      defaultStatus: '已留档',
      statuses: ['已留档'],
      required: ['tourBoxId', 'revisionNo', 'snapshot'],
      titleFields: ['tourBoxId', 'revisionNo']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  // 配重分层与解封判定参数
  tour: {
    boxWeightLimitGrams: 15000, // 同箱总重上限（克）
    heavyHeadGrams: 2500,       // 达到该克重视为重偶头
    maxLayer: 5,                // 最大层位，数字越大越靠上
    fragileKeywords: ['绸', '纱', '绢', '绒', '珠', '翎', '冠', '盔', '脆', '薄', '玻璃', '点翠']
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
        role: '孙悟空',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '转眼灵活',
        boxNo: '木箱甲-01',
        currentUsable: true
      }
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
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes/pack 登记装箱（箱号/层位/单件克重，超限或重压脆整单拒绝）',
    'POST /api/tourBoxes/:id/arrival 到场核验（错层或封签不符只转待复核）',
    'POST /api/tourBoxes/:id/release 返场解封台（双人确认+修补完成+位置复位）',
    'GET /api/tour-overview 装箱、履历与数量汇总'
  ]
};
