// A home-screen icon saved from 语法记忆 starts at /grammar/; at launch the app opens 今日安排 instead.
// Pages opened later in the same launch (e.g. the 语法记忆 link) are left alone.
(() => {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let first = false;
  try {
    first = sessionStorage.getItem('jlpt:launched') !== '1';
    sessionStorage.setItem('jlpt:launched', '1');
  } catch {}
  if (standalone && first && location.pathname.startsWith('/grammar/')) location.replace('/review/');
})();
