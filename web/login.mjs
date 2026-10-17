const form = document.querySelector('#login-form');
try {
  if ((await fetch('/api/session')).ok) location.replace('/review/');
} catch { /* The form remains usable after connection recovery. */ }
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const error = document.querySelector('#error');
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#password').value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    location.replace('/review/');
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally { button.disabled = false; }
});
