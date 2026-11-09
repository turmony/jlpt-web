const nameInput=document.getElementById('device-name');
const list=document.getElementById('device-list');
const problem=document.getElementById('devices-error');

function guessName() {
  const ua=navigator.userAgent;
  if(ua.includes('iPad')||(ua.includes('Macintosh')&&navigator.maxTouchPoints>1)) return 'iPad';
  return ua.includes('iPhone')?'iPhone':'';
}

const installUrl=()=>`/api/news/install/${encodeURIComponent(nameInput.value.trim())}/jlpt-news.user.js`;
function go(suffix) {
  if(!nameInput.value.trim()) {show('请先填写设备名称');nameInput.focus();return;}
  location.href=installUrl()+suffix;
}

function show(message) {problem.textContent=message||'';problem.hidden=!message;}

function stamp(seconds) {
  const date=new Date(seconds*1000),two=value=>String(value).padStart(2,'0');
  return `${date.getMonth()+1}/${date.getDate()} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

async function call(path,body) {
  const response=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
  let data=null;
  try {data=await response.json();} catch {}
  if(response.status===401) {location.href='/login.html';throw new Error('请先登录');}
  if(!response.ok) throw new Error(data?.error||'请求失败（'+response.status+'）');
  return data;
}

function row(device) {
  const item=document.createElement('li');
  const name=document.createElement('span');name.className='device-name';name.textContent=device.name;
  const installed=document.createElement('span');installed.className='muted';installed.textContent='安装 '+stamp(device.installed);
  const used=document.createElement('span');used.className='muted';used.textContent='最近使用 '+(device.last_used==null?'未使用':stamp(device.last_used));
  const revoke=document.createElement('button');revoke.type='button';revoke.textContent='作废';
  revoke.addEventListener('click',async()=>{
    if(!confirm(`作废「${device.name}」后，这台设备上的脚本立即失效。`)) return;
    try {await call('/api/news/devices/revoke',{id:device.id});await refresh();}
    catch(error) {show(error.message);}
  });
  item.append(name,installed,used,revoke);
  return item;
}

async function refresh() {
  try {
    const {devices}=await call('/api/news/devices');
    show('');
    list.replaceChildren(...devices.map(row));
  } catch(error) {show(error.message);}
}

nameInput.value=guessName();
document.getElementById('install').addEventListener('click',()=>go(''));
document.getElementById('download').addEventListener('click',()=>go('?download=1'));
refresh();
