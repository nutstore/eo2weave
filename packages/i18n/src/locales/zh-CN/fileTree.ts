// 文件树
export const fileTree = {
    pending: {
      create: "新增",
      modify: "修改",
      delete: "删除",
    },
    copyPath: "复制路径",
    inspectElement: "元素审查",
    deleteFile: "删除",
    deleteConfirm: "确定要删除「{name}」吗？",
    deleteFileTitle: "确认删除",
    emptyStateHint: "未选择本地目录也可继续使用",
    emptyStateDescription: "AI 修改的文件会暂存在这里，确认后才会写入本地",
    draftFiles: "未确认的修改",
    gitBranch: "Git 分支",
    detachedHead: "分离头指针",
    approvedNotSynced: "已确认，等待写入本地磁盘",
    loadFailed: "目录无法访问",
    opfsDraftRoot: "OPFS 草稿",
} as const
