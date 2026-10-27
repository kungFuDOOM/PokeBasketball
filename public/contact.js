// Tap-to-copy for the SOL address on the contact page.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('copy-addr');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const addr = btn.dataset.copy || '';
    try {
      await navigator.clipboard.writeText(addr);
      btn.textContent = 'Copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('sol-addr'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});
