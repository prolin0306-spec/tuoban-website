(() => {
  window.initSidebar('dashboard.html');
  const api=window.createHomeworkAPI(window.HOMEWORK_CONFIG,window.cloudbase);
  window.adminAuth.session().then(async session=>{
    const [classes,stats]=await Promise.all([api.classes(),api.feedbackOverview()]);
    const grid=document.getElementById('statsGrid');
    for(const [label,value] of [['学生总数',stats.total],['今日已填写',stats.done],['今日未填写',stats.pending]]) {
      const card=document.createElement('div');card.className='adm-stat-card';
      const number=document.createElement('strong');number.className='adm-stat-value';number.textContent=String(value);
      const text=document.createElement('span');text.className='adm-stat-label';text.textContent=label;card.append(number,text);grid.append(card);
    }
    document.getElementById('topbarInfo').textContent=session.teacher.name+(session.teacher.role==='boss'?' · 管理员':' · 老师');
    document.getElementById('dashboardStatus').textContent=`已登录，可管理 ${classes.length} 个班级。`;
    document.getElementById('dashboardLinks').hidden=false;
  }).catch(error=>{document.getElementById('dashboardStatus').textContent=error.message||'加载失败';document.getElementById('dashboardLogin').hidden=false;});
})();
