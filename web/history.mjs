const dayKey = date => `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;

export function groupHistory(tasks, cli, archived, now = new Date()) {
  const today = dayKey(now), yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate()-1);
  const groups = new Map();
  const activity = task => Number(task.last_activity || task.updated || task.created_at || 0);
  const visible = tasks.filter(task => task.cli === cli && !!task.archived_at === archived)
    .sort((a,b) => activity(b)-activity(a) || a.id.localeCompare(b.id));
  for (const task of visible) {
    const time = activity(task), date = new Date(time*1000);
    const dated = time > 0 && Number.isFinite(date.getTime());
    const key = dated ? dayKey(date) : 'undated';
    const label = !dated ? '更早' : key === today ? '今天' : key === dayKey(yesterday) ? '昨天'
      : `${date.getFullYear() === now.getFullYear() ? '' : date.getFullYear()+'年'}${date.getMonth()+1}月${date.getDate()}日`;
    if (!groups.has(key)) groups.set(key, {key, label, tasks:[]});
    groups.get(key).tasks.push(task);
  }
  return [...groups.values()];
}
