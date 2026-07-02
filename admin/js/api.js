(() => {
  'use strict';

  const db = () => window.adminDb;

  window.adminAPI = {

    // --- 学生 ---
    getStudents() {
      return db().collection('children').get().then((r) => r.data || []);
    },

    searchStudents(q) {
      const isPhone = /^\d+$/.test(q);
      if (isPhone) {
        return db().collection('children')
          .where({ parentPhone: parseInt(q, 10) })
          .get().then((r) => r.data || []);
      }
      // CloudBase 不支持模糊搜索，拉全量再过滤
      return this.getStudents().then((list) =>
        list.filter((s) => s.name && s.name.includes(q))
      );
    },

    getStudent(childId) {
      return db().collection('children').doc(childId).get()
        .then((r) => r.data && r.data.length ? r.data[0] : r.data);
    },

    // --- 日报 ---
    _isToday(rep) {
      const t = adminAPI.today();
      return rep.date === t || (typeof rep.date === 'string' && rep.date.startsWith(t));
    },

    getTodayReports() {
      return db().collection('daily_reports').get()
        .then((r) => (r.data || []).filter((rep) => adminAPI._isToday(rep)));
    },

    getReport(childId) {
      return db().collection('daily_reports')
        .where({ childId })
        .get()
        .then((r) => {
          const list = (r.data || []).filter((rep) => adminAPI._isToday(rep));
          return list.length > 0 ? list[0] : null;
        });
    },

    saveReport(data) {
      const today = adminAPI.today();
      return db().collection('daily_reports')
        .where({ childId: data.childId })
        .get()
        .then((r) => {
          const list = (r.data || []).filter((rep) => adminAPI._isToday(rep));
          const doc = {
            childId: data.childId,
            date: today,
            attendance: data.attendance || '',
            meal: data.meal || '',
            learning: data.learning || '',
            behavior: data.behavior || '',
            remarks: data.remarks || '',
            updatedAt: new Date()
          };

          if (list.length > 0) {
            doc.createdAt = list[0].createdAt || new Date();
            return db().collection('daily_reports').doc(list[0]._id).update(doc);
          }
          doc.createdAt = new Date();
          return db().collection('daily_reports').add(doc);
        });
    },

    // --- 工具 ---
    today() {
      const d = new Date();
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }
  };

})();
