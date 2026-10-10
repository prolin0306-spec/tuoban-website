(() => {
  'use strict';
  const form=document.getElementById('adminLogin'),button=document.getElementById('btnLogin'),status=document.getElementById('loginStatus');
  const target=window.adminAuth.destination(new URLSearchParams(location.search).get('next'));
  const enter=()=>location.replace(target);
  window.adminAuth.session().then(enter).catch(error=>{if(error.code!=='AUTH_REQUIRED')status.textContent=error.message;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();button.disabled=true;status.textContent='正在验证账号…';
    try{await window.adminAuth.login(document.getElementById('username').value.trim(),document.getElementById('password').value);enter();}
    catch(error){status.textContent=error.message||'登录失败，请重试';}
    finally{document.getElementById('password').value='';button.disabled=false;}
  });
})();
