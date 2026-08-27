function dismiss(backdrop) {
  backdrop?.remove();
}

function enableSheetGesture(backdrop) {
  if (!(backdrop instanceof HTMLElement) || !backdrop.classList.contains('backdrop')) return;
  const sheet = backdrop.querySelector('.sheet');
  const handle = sheet?.querySelector('.handle');
  if (!sheet || !handle || handle.dataset.gestureReady) return;

  handle.dataset.gestureReady = 'true';
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', '向下滑動或點一下以關閉');
  handle.tabIndex = 0;
  handle.style.touchAction = 'none';

  let startY = 0;
  let distance = 0;
  let dragging = false;

  handle.addEventListener('pointerdown', event => {
    startY = event.clientY;
    distance = 0;
    dragging = true;
    handle.setPointerCapture?.(event.pointerId);
    sheet.style.transition = 'none';
  });

  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    distance = Math.max(0, event.clientY - startY);
    sheet.style.transform = `translateY(${distance}px)`;
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = 'transform .2s ease';
    if (distance >= 72) {
      sheet.style.transform = 'translateY(110%)';
      window.setTimeout(() => dismiss(backdrop), 180);
    } else {
      sheet.style.transform = '';
      window.setTimeout(() => { sheet.style.transition = ''; }, 220);
    }
  };

  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('click', () => {
    if (distance < 8) dismiss(backdrop);
  });
  handle.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') dismiss(backdrop);
  });
}

new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      enableSheetGesture(node);
      node.querySelectorAll?.('.backdrop').forEach(enableSheetGesture);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') dismiss(document.querySelector('.backdrop'));
});

