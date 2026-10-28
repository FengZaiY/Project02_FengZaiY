// Fixed application operations; internal RPC, raw database and shell access are excluded.
const groups = [
  ['read', [
    ['noteTree', '笔记知识体系', 'domain'], ['draftWorkflow', '草稿处理状态', 'id'],
    ['changeList', '修改批次列表', 'offset,limit'], ['changeDetail', '修改批次详情', 'id'],
    ['financeCsvExport', '导出财务 CSV', ''], ['exportMarkdown', '导出笔记 Markdown', 'id'],
    ['assetCatalog', '资料目录', 'domain,collectionId,categoryId,topicId,query,kind,availability,usage,tag,sort,trash,offset,limit,directory'], ['assetDetail', '资料详情', 'id'], ['assetDuplicates', '重复附件', 'id'],
    ['materialTree', '资料分类与主题', ''],
    ['materialProposalPreview', '资料方案实际位置预览', 'id'],
    ['materialCleanupPreview', '可读目录旧副本清理预览', ''], ['storageInternalPreview', '内部数据目录迁移预览', ''],
    ['syncStatus', '同步状态', ''], ['syncIntegrity', '修改记录校验', ''], ['deviceStatus', '设备状态', ''],
    ['storageStatus', '本机存储状态', ''], ['localHierarchyStatus', '本地目录维护状态', ''],
    ['receivedObjectsStatus', '原件接收目录状态', 'offset,limit'], ['deletionStatus', '永久删除收尾状态', ''],
    ['materialMigrationStatus', '资料迁移状态', ''], ['agentStatus', 'Agent 授权与访问记录', ''],
    ['agentSkill', '内置 Skill 与偏好', ''], ['skillInstallList', '已关联 Skill', ''],
    ['trashPreview', '永久删除预览', 'domain,legacyOnly'], ['assetMergePreview', '重复附件合并预览', 'ids,targetId'],
    ['syncDisconnectPreview', '解绑预览', ''], ['materialMigrationPreview', '集中资料迁移预览', ''],
    ['vaultStatus', '密码库锁定状态', '']
  ]],
  ['secret', [
    ['vaultRead', '读取账号密码', 'accountId,revision'], ['vaultHistory', '密码修改历史', 'accountId'],
    ['vaultGenerate', '生成密码', 'length']
  ]],
  ['confirm', [
    ['save', '创建或保存知识内容', 'type,id,parents,data,notePlacement'], ['saveBranch', '保存并发分支', 'type,id,parents,data'],
    ['librarySave', '创建或修改知识库', 'id,title,description,parents'], ['noteMove', '移动或排序笔记', 'id,parents,parentNoteId,data,notePlacement'],
    ['delete', '移入回收站', 'id,parents'],
    ['personalDelete', '回收业务记录', 'id,parents'], ['personalRestore', '恢复业务记录', 'id,parents'],
    ['restoreVersion', '恢复历史版本', 'id,revision,parents'], ['changeUndo', '撤回整批修改', 'id'],
    ['approve', '确认整理方案入库', 'id,itemIds,parents'], ['draftArchive', '直接归档草稿', 'id,parents,domain,parentNoteId'],
    ['proposalCleanup', '清理已确认方案', 'id,parents'], ['trashEmpty', '永久清空回收内容', 'domain,legacyOnly,token,confirmed'],
    ['deletionRetry', '重试永久删除收尾', ''], ['assetMerge', '合并重复附件', 'ids,targetId,token,confirmed'],
    ['assetUpdate', '修改附件属性', 'id,parents,changes'], ['assetBatch', '批量管理附件', 'items,action,tags,domain'],
    ['assetImport', '导入本机文件', 'path,domain,duplicateMode'], ['assetPin', '保留本机原件', 'id,pinned'],
    ['assetHydrate', '接收原件', 'id'], ['assetEvict', '释放本机原件', 'id,confirmed'],
    ['financeCsvPreview', '财务 CSV 映射预览', 'csv,mapping'], ['financeCsvImport', '提交 CSV 导入', 'csv,mapping,token'],
    ['materialMigrate', '迁移集中资料', 'token,confirmed,resume'], ['localHierarchyRefresh', '维护本地目录', ''],
    ['materialCleanup', '清理迁移旧副本', 'token,confirmed'], ['storageInternalSchedule', '安排重启迁移内部目录', 'token,confirmed'],
    ['storageInspect', '检查目标工作区', 'mode,directory'], ['storageSchedule', '迁移或切换工作区', 'mode,directory'], ['storageCancel', '取消存储变更', ''],
    ['storagePreviousPreview', '检查旧工作区副本', ''], ['storagePreviousClean', '清理旧工作区副本', 'token,confirmed'],
    ['emptyDirectoriesPreview', '检查废弃目录', ''], ['emptyDirectoriesClean', '清理废弃空目录', 'token,confirmed'],
    ['syncConfigure', '配置同步', 'folder,key'], ['syncScan', '检查同步目录', ''], ['syncPlan', '准备发布', 'batchBytes'],
    ['syncPublish', '发布本机内容', 'batchBytes'], ['syncImport', '接收同步内容', 'metadataOnly'],
    ['syncCancel', '取消发布任务', ''], ['syncPause', '暂停同步', ''], ['syncConfirmBatch', '确认本批上传', 'confirmed'],
    ['syncConfirmUpload', '确认上传完成', 'id,confirmed'], ['syncDisconnect', '解除本机同步绑定', 'token,confirmed'],
    ['deviceManage', '管理设备', 'deviceId,action,name,revision,requestId,confirmed'],
    ['deviceSetPrimary', '设置或接管主力机', 'deviceId,parents,revision,transferId,confirmed'], ['deviceVerify', '校验主力机原件', ''], ['deviceName', '修改设备名', 'name'],
    ['pairingKey', '查看或生成配对密钥', ''], ['agentConfigure', '开启或关闭 MCP', 'enabled'], ['agentGrant', '新建 Agent 凭证', 'name,days'], ['agentRevoke', '撤销 Agent 凭证', 'id'],
    ['agentPreferencesSave', '保存整理偏好', 'content,parents'], ['agentSkillExport', '生成 Skill 导出', ''],
    ['skillInstallCheck', '检查 Skill 安装更新', ''], ['skillInstallPreview', '预览 Skill 安装操作', 'action,id,directory'],
    ['skillInstallConfirm', '确认 Skill 安装操作', 'token,confirmed'], ['skillInstallConfigure', '配置 Skill 自动更新', 'id,mode,confirmed'], ['skillInstallUnlink', '解除 Skill 关联', 'id,confirmed'],
    ['vaultSave', '保存账号密码', 'accountId,parents,value'], ['vaultLock', '锁定密码库', ''],
    ['workspacePublish', '发布阅读位置', 'tabs,selectedTab'], ['workspaceAdopt', '接续其他电脑阅读位置', 'id']
  ]],
  ['local', [
    ['vaultUnlock', '本机解锁或初始化密码库', ''], ['vaultResetMaster', '本机管理主密码与恢复配置', ''],
    ['updateStatus', '查看本机软件更新', ''], ['updateCheck', '检查软件更新', ''], ['updateDownload', '下载软件更新', ''],
    ['updatePause', '暂停更新下载', ''], ['updateResume', '继续更新下载', ''], ['updateRestartDownload', '重新下载软件更新', ''],
    ['updateInstall', '重启并安装更新', ''], ['updateConfigure', '设置更新偏好', ''],
    ['storageRestart', '重启并应用工作区变更', ''], ['chooseDirectory', '本机选择目录', ''], ['chooseFile', '本机选择文件', ''],
    ['openAsset', '用本机应用打开附件', 'id'], ['bindLocalFile', '绑定本机文件', 'id'], ['openLocalFile', '打开已绑定文件', 'id'],
    ['openExternal', '打开外部网址', 'url'], ['printPdf', '打印或导出 PDF', ''], ['libraryOpenFolder', '打开知识库目录', 'id']
  ]]
];

export const agentOperations = Object.fromEntries(groups.flatMap(([mode, rows]) => rows.map(([method, label, fields]) =>
  [method, { method, label, mode, parameters: fields, confirmation: mode === 'confirm' || mode === 'local' }])));
export const secretResults = new Set(['pairingKey', 'agentGrant', 'vaultSave']);
export const localOnlyInputs = new Set(['vaultUnlock', 'vaultResetMaster', 'updateConfigure']);
