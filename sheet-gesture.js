function dismiss(backdrop) {
  backdrop?.remove();
}

function enableSheetGesture(backdrop) {
  if (!(backdrop instanceof HTMLElement) || !backdrop.classList.contains('backdrop')) return;
  const sheet = backdrop.querySelector('.sheet');
  const handle = sheet?.querySelector('.handle');
  if (!sheet || !handle || sheet.dataset.gestureReady) return;

  sheet.dataset.gestureReady = 'true';
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', '向下滑動面板或點一下以關閉');
  handle.tabIndex = 0;

  let startX = 0;
  let startY = 0;
  let distance = 0;
  let tracking = false;
  let dragging = false;

  const reset = () => {
    tracking = false;
    dragging = false;
    distance = 0;
  };

  const finish = () => {
    if (!tracking) return;
    const shouldDismiss = dragging && distance >= 84;
    tracking = false;
    dragging = false;
    sheet.style.transition = 'transform .2s ease';
    if (shouldDismiss) {
      sheet.style.transform = 'translateY(110%)';
      window.setTimeout(() => dismiss(backdrop), 180);
      return;
    }
    sheet.style.transform = '';
    window.setTimeout(() => {
      sheet.style.transition = '';
      distance = 0;
    }, 220);
  };

  sheet.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || sheet.scrollTop > 0) return;
    if (event.target.closest('input, select, textarea, button')) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    distance = 0;
    tracking = true;
    dragging = false;
  }, { passive: true });

  sheet.addEventListener('touchmove', event => {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!dragging) {
      if (deltaY <= 8) return;
      if (Math.abs(deltaX) > deltaY) {
        reset();
        return;
      }
      if (sheet.scrollTop > 0) {
        reset();
        return;
      }
      dragging = true;
      sheet.style.transition = 'none';
    }
    distance = Math.max(0, deltaY);
    event.preventDefault();
    sheet.style.transform = `translateY(${distance}px)`;
  }, { passive: false });

  sheet.addEventListener('touchend', finish);
  sheet.addEventListener('touchcancel', finish);

  handle.addEventListener('click', () => dismiss(backdrop));
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
