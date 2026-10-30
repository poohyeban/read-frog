# 时间轴与播放位置调度

CueTimeline使用按start稳定排序的数组、prefix-max-end数组和完整cue身份Map。当前第一条覆盖字幕查询O(log n)，支持相同开始时间、重叠、极长字幕、逆向Seek；窗口查询O(log n + 扫描候选数)，病态重叠最坏O(n)，未声称所有窗口都O(log n)。构建O(n log n)，纯译文更新复用时间索引并只复制值数组，O(n+m)；新增批次排序后线性合并为O(n+m log m)。重分段会创建新轨版本并失效不匹配身份的旧译文。

已接管Scheduler、source fallback atom、Coordinator及Transcript active-index路径。相同cue的显示引用保持稳定；基线已是0次同cue无意义commit，此处不虚报新的React收益。

Coordinator按当前覆盖区间→后续窗口选取任务；最多2批×5条。旧位置无关任务取消，同身份pending复用，事件同回合合并。监听loadedmetadata/loadeddata/seeking/seeked/playing/timeupdate/ratechange；从0启动立即响应，异步恢复的位置再重排；不能保证远程已开始请求无计费中止。网络并发仍由已有队列负责。

AI分段使用可重用的规范60秒窗口（避免切断本地基线字幕），先选覆盖当前时间的窗口，高倍速扩展窗口数而不是无限扩大单请求。Seek离开当前任务窗口时取消旧代次。保留原文/本地规则作为等待和失败回退。

针对性字幕/时间轴回归：59文件439测试通过。新增入队顺序测试覆盖0、35:20、40:00、0→35:20、5:00→40:00、反向Seek、连续Seek、长字幕、2x/4x及同开始时间；完整浏览器前后数据在最终收敛后生成。

失败结果已作为调度输入区分success/empty/temporary/permanent/cancelled；冷却30秒、单会话自动恢复最多一次，手动重新启用可重置。阶段4补充配置失效、队列优先级和专项恢复验证。
