(() => {
  'use strict';
  const drafts=new Map(),expanded=new Set();
  const fieldLabels={attendance:'出勤',meal:'饮食',learning:'学习内容',behavior:'课堂表现',remarks:'老师评语'};
  function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function button(label){const node=el('button',label,'adm-btn adm-btn-primary');node.type='button';return node;}
  const safeImage=value=>typeof value==='string'&&/^https:\/\//.test(value);
  window.HomeworkFeedback={
    hasPending: () => !!document.querySelector('.hw-feedback[open]'),
    mount(card,student,date,api){
      const key=student.id+'|'+date,details=el('details',undefined,'hw-feedback');details.dataset.feedbackStudent=student.id;
      details.append(el('summary','每日反馈与错题反馈'));
      const body=el('div',undefined,'hw-feedback-body');details.append(body);card.append(details);
      let loading=false,loaded=false;
      async function load(){
        if(loading)return;loading=true;body.replaceChildren(el('p','正在读取反馈…'));
        try{
          const data=await api.studentFeedback({studentId:student.id,date});
          if(!details.isConnected)return;
          body.replaceChildren();loaded=true;
          const caption=el('p',`${date} · 保存后家长端重新查询即可查看。`,'hw-muted');body.append(caption);
          const form=el('form',undefined,'hw-feedback-form');form.dataset.feedbackForm=student.id;
          form.append(el('h3','每日反馈'));
          const draft=drafts.get(key)||data.report||{};
          for(const [name,label]of Object.entries(fieldLabels)){
            const wrap=el('label',label),input=el(['attendance','meal'].includes(name)?'select':'textarea');input.name=name;input.className='adm-form-input';
            if(name==='attendance'||name==='meal')for(const item of name==='attendance'?['','正常','请假','迟到']:['','全部吃完','一般','较少']){const option=el('option',item||'请选择');option.value=item;input.append(option);}
            else {input.maxLength=3000;input.rows=3;}
            input.value=draft[name]||'';wrap.append(input);form.append(wrap);
          }
          form.addEventListener('input',()=>drafts.set(key,Object.fromEntries(new FormData(form))));
          const save=button('保存每日反馈'),status=el('p','', 'hw-feedback-status');status.setAttribute('role','status');save.type='submit';form.append(save,status);
          form.addEventListener('submit',async event=>{
            event.preventDefault();save.disabled=true;status.textContent='正在保存…';
            try{await api.saveStudentFeedback({studentId:student.id,date,...Object.fromEntries(new FormData(form))});drafts.delete(key);status.textContent='已保存，家长端可查询本次反馈。';}
            catch(error){status.textContent=error.message||'保存失败，请重试';}finally{save.disabled=false;}
          });body.append(form);
          const mistakes=el('section',undefined,'hw-feedback-mistakes');mistakes.append(el('h3','错题反馈'));
          const list=el('div');list.dataset.mistakeList=student.id;
          for(const row of data.mistakes){
            const item=el('article',undefined,'hw-mistake');item.dataset.mistakeId=row._id;
            item.append(el('strong',row.subject||'错题'),el('p',row.note||''));
            if(safeImage(row.imageURL)){const image=el('img');image.src=row.imageURL;image.alt='错题照片';image.loading='lazy';item.append(image);}else item.append(el('p','图片暂不可用，请稍后刷新'));
            const remove=button('删除这条错题');remove.className='adm-btn adm-btn-secondary';
            remove.addEventListener('click',async()=>{if(!window.confirm('确认删除这条错题？家长端将不再显示。'))return;remove.disabled=true;
              try{await api.deleteStudentMistake({studentId:student.id,mistakeId:row._id});await load();}catch(error){status.textContent=error.message;remove.disabled=false;}});
            item.append(remove);list.append(item);
          }
          if(!data.mistakes.length)list.append(el('p','该日期暂无错题。'));
          const upload=el('form',undefined,'hw-mistake-form');upload.dataset.mistakeForm=student.id;
          const subject=el('select');subject.name='subject';subject.className='adm-form-input';subject.setAttribute('aria-label','错题科目');for(const name of ['语文','数学','英语','其他'])subject.append(el('option',name));
          const photo=el('input');photo.type='file';photo.accept='image/jpeg,image/png,image/webp';photo.required=true;photo.setAttribute('aria-label','错题照片');
          const note=el('textarea');note.name='note';note.maxLength=3000;note.placeholder='错题说明';note.setAttribute('aria-label','错题说明');note.className='adm-form-input';
          const submit=button('上传并同步家长端');submit.type='submit';const uploadStatus=el('p');uploadStatus.setAttribute('role','status');
          let requestId=null;upload.addEventListener('input',()=>{requestId=null;});
          upload.append(subject,photo,note,el('p','支持 JPEG、PNG、WebP，单张不超过 2 MB。'),submit,uploadStatus);
          upload.addEventListener('submit',async event=>{
            event.preventDefault();const file=photo.files[0];if(!file||file.size>2*1024*1024){uploadStatus.textContent='请选择不超过 2 MB 的图片';return;}
            submit.disabled=true;uploadStatus.textContent='正在上传…';
            try{
              const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
              requestId=requestId||crypto.randomUUID();await api.saveStudentMistake({studentId:student.id,date,subject:subject.value,note:note.value,imageBase64:base64,requestId});
              await load();const done=el('p','错题已保存，家长端可查询。');done.setAttribute('role','status');body.prepend(done);
            }catch(error){uploadStatus.textContent=error.message||'上传失败，请重试';}finally{submit.disabled=false;}
          });
          mistakes.append(list,upload);body.append(mistakes);
        }catch(error){
          body.replaceChildren(el('p',error.message||'读取失败'));
          if(error.code==='FEEDBACK_UNLINKED'||error.code==='DATA_CHANGED'){const link=el('a','前往学生管理核对关联');link.href='students.html';body.append(link);}
          const retry=button('重试');retry.addEventListener('click',load);body.append(retry);
        }finally{loading=false;}
      }
      details.addEventListener('toggle',()=>{if(details.open){expanded.add(key);if(!loaded)load();}else expanded.delete(key);});
      if(expanded.has(key)||window.homeworkRequestedStudent===student.id){card.open=true;details.open=true;}
    }
  };
})();
