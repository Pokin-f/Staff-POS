(() => {
  const staffScreen = document.getElementById('staff-screen');
  const tableScreen = document.getElementById('table-screen');
  const menuScreen = document.getElementById('menu-screen');
  const checkoutScreen = document.getElementById('checkout-screen');
  const staffGridEl = document.getElementById('staff-grid');
  const currentStaffEl = document.getElementById('current-staff');
  const menuStaffEl = document.getElementById('menu-staff');
  const ticketStaffEl = document.getElementById('ticket-staff');
  const tableGridEl = document.getElementById('table-grid');
  const currentTableEl = document.getElementById('current-table');
  const ticketTableEl = document.getElementById('ticket-table');
  const menuItemsEl = document.getElementById('menu-items');
  const basketTotalEl = document.getElementById('basket-total');
  const checkoutBtn = document.getElementById('checkout-btn');

  const qrState = document.getElementById('qr-state');
  const paidState = document.getElementById('paid-state');
  const expiredState = document.getElementById('expired-state');
  const cancelledState = document.getElementById('cancelled-state');

  const paidHeadingEl = document.getElementById('paid-heading');
  const ticketCard = document.querySelector('#checkout-screen .ticket');
  const docketTableEl = document.getElementById('docket-table');
  const docketGroupEl = document.getElementById('docket-group');
  const docketItemsEl = document.getElementById('docket-items');
  const docketGuestsWrap = document.getElementById('docket-guests-wrap');
  const docketGuestsEl = document.getElementById('docket-guests');
  const docketFooterEl = document.getElementById('docket-footer');

  const slipPreviewWrap = document.getElementById('slip-preview-wrap');
  const slipPreview = document.getElementById('slip-preview');
  const slipInput = document.getElementById('slip-input');
  const slipCameraWrap = document.getElementById('slip-camera-wrap');
  const slipVideo = document.getElementById('slip-video');
  const slipRetakeBtn = document.getElementById('slip-retake-btn');

  const couponInput = document.getElementById('coupon-input');
  const couponApplyBtn = document.getElementById('coupon-apply-btn');
  const couponEntry = document.getElementById('coupon-entry');
  const couponApplied = document.getElementById('coupon-applied');
  const couponAppliedText = document.getElementById('coupon-applied-text');
  const couponRemoveBtn = document.getElementById('coupon-remove-btn');
  const basketDiscountNote = document.getElementById('basket-discount-note');

  const qrImage = document.getElementById('qr-image');
  const qrFrame = document.getElementById('qr-frame');
  const staticQrHint = document.getElementById('static-qr-hint');
  const staticQrAmount = document.getElementById('static-qr-amount');
  const slipPrimaryBtn = document.getElementById('slip-primary-btn');
  const slipHintGateway = document.getElementById('slip-hint-gateway');
  const slipLinky = document.getElementById('slip-linky');
  const recheckBtn = document.getElementById('recheck-btn');
  const checkoutAmount = document.getElementById('checkout-amount');
  const countdownEl = document.getElementById('countdown');
  const paidAmountEl = document.getElementById('paid-amount');

  const trayBtn = document.getElementById('tray-btn');
  const trayCountEl = document.getElementById('tray-count');
  const trayPanel = document.getElementById('tray-panel');
  const trayList = document.getElementById('tray-list');
  const trayEmpty = document.getElementById('tray-empty');
  const trayTitle = document.getElementById('tray-title');

  const ITEM_META = {
    beer: { image: 'images/beer_pitcher.png', tone: 'beer', alt: 'Bottle of Chang beer' },
    regency: { image: 'images/regency.png', tone: 'regency', alt: 'Bottle of Regency brandy' }
  };

  const LAST_STAFF_KEY = 'pos.lastCollector';

  let menu = [];
  const basket = {}; // { itemId: qty }
  let staffRoster = [];
  let selectedStaff = null;
  let selectedTable = null;
  let appliedCoupon = null; // { code, type, value }
  let currentOrderId = null;
  let checkoutState = 'qr';
  let stateBeforeSlip = 'qr';
  let slipDataUrl = null;
  let slipStream = null; // active getUserMedia stream, if the in-page camera is on
  let pollTimer = null;
  let countdownTimer = null;
  let openOrders = []; // paid, not yet carried out

  function money(n) {
    return `฿${Number(n).toFixed(0)}`;
  }

  function basketSubtotal() {
    return menu.reduce((sum, item) => sum + (basket[item.id] || 0) * item.price, 0);
  }

  // Mirror of config/coupons.js computeDiscount for live preview. The server
  // recomputes authoritatively at checkout, so this is display-only.
  function couponDiscount(subtotal) {
    if (!appliedCoupon) return 0;
    const raw = appliedCoupon.type === 'percent'
      ? (subtotal * appliedCoupon.value) / 100
      : appliedCoupon.value;
    return Math.max(0, Math.min(Math.round(raw), subtotal));
  }

  function basketItems() {
    return menu
      .filter((item) => (basket[item.id] || 0) > 0)
      .map((item) => ({ id: item.id, qty: basket[item.id] }));
  }

  function renderMenu() {
    menuItemsEl.innerHTML = '';
    for (const item of menu) {
      const qty = basket[item.id] || 0;
      const meta = ITEM_META[item.id] || {};
      const card = document.createElement('div');
      card.className = 'menu-card';
      card.dataset.tone = meta.tone || '';
      card.innerHTML = `
        <div class="menu-card-photo-tile">
          <img class="menu-card-photo" src="${meta.image || ''}" alt="${meta.alt || item.name}">
        </div>
        <div class="menu-card-body">
          <div class="menu-card-name-row">
            <h3 class="menu-card-name">${item.name}</h3>
            <span class="menu-card-price">${money(item.price)}</span>
          </div>
          <div class="qty-row">
            <button class="qty-btn" data-action="dec" data-id="${item.id}" aria-label="Remove one ${item.name}">&minus;</button>
            <div class="qty-value" aria-live="polite">${qty}</div>
            <button class="qty-btn" data-action="inc" data-id="${item.id}" aria-label="Add one ${item.name}">+</button>
          </div>
        </div>
      `;
      menuItemsEl.appendChild(card);
    }
    const subtotal = basketSubtotal();
    const discount = couponDiscount(subtotal);
    basketTotalEl.textContent = money(subtotal - discount);
    if (discount > 0) {
      basketDiscountNote.textContent = `${appliedCoupon.code}: −${money(discount)} off ${money(subtotal)}`;
      basketDiscountNote.classList.remove('hidden');
    } else {
      basketDiscountNote.classList.add('hidden');
    }
    checkoutBtn.disabled = subtotal <= 0;
  }

  function renderCoupon() {
    const active = !!appliedCoupon;
    couponEntry.classList.toggle('hidden', active);
    couponApplied.classList.toggle('hidden', !active);
    if (active) {
      couponAppliedText.textContent = `Coupon ${appliedCoupon.code} applied`;
      couponInput.value = '';
    }
  }

  menuItemsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.qty-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const current = basket[id] || 0;
    if (btn.dataset.action === 'inc') {
      basket[id] = current + 1;
    } else {
      basket[id] = Math.max(0, current - 1);
    }
    renderMenu();
  });

  async function loadMenu() {
    const res = await fetch('/api/orders/menu');
    menu = await res.json();
    renderMenu();
  }

  function showScreen(screen) {
    staffScreen.classList.toggle('hidden', screen !== 'staff');
    tableScreen.classList.toggle('hidden', screen !== 'table');
    menuScreen.classList.toggle('hidden', screen !== 'menu');
    checkoutScreen.classList.toggle('hidden', screen !== 'checkout');
  }

  // ---- Who's collecting ----

  // Every order starts here, so the accounting sheet always records which staff
  // member took the money. The previous pick stays highlighted because the same
  // person usually works a run of orders — one tap to confirm, not a hunt.
  async function loadStaff() {
    let list = [];
    try {
      const res = await fetch('/api/orders/staff');
      if (res.ok) list = await res.json();
    } catch (err) {
      list = [];
    }
    staffRoster = Array.isArray(list) ? list : [];
    renderStaff();
  }

  function lastStaff() {
    try {
      return localStorage.getItem(LAST_STAFF_KEY);
    } catch (err) {
      return null; // private mode / storage disabled — just don't pre-highlight
    }
  }

  function rememberStaff(name) {
    try {
      localStorage.setItem(LAST_STAFF_KEY, name);
    } catch (err) {
      /* non-fatal */
    }
  }

  function renderStaff() {
    staffGridEl.innerHTML = '';

    // If the roster never arrived (offline tablet, failed fetch) the picker
    // must not become a dead end — offer an unnamed way through so the bar
    // keeps serving. The order still logs, just without a collector.
    if (staffRoster.length === 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'staff-btn staff-btn-unassigned';
      btn.dataset.staff = '';
      btn.textContent = 'Continue without name';
      staffGridEl.appendChild(btn);
      return;
    }

    const previous = lastStaff();
    for (const name of staffRoster) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'staff-btn';
      btn.dataset.staff = name;
      btn.textContent = name;
      if (name === previous) btn.classList.add('is-last');
      staffGridEl.appendChild(btn);
    }
  }

  function selectStaff(name) {
    selectedStaff = name || '';
    if (selectedStaff) rememberStaff(selectedStaff);
    const label = selectedStaff || 'Unassigned';
    currentStaffEl.textContent = label;
    menuStaffEl.textContent = label;
    showScreen('table');
  }

  staffGridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.staff-btn');
    if (!btn) return;
    selectStaff(btn.dataset.staff);
  });

  function backToStaff() {
    renderStaff(); // refresh the "last used" highlight
    showScreen('staff');
  }

  document.getElementById('change-staff-btn').addEventListener('click', backToStaff);
  document.getElementById('menu-change-staff-btn').addEventListener('click', backToStaff);

  async function loadTables() {
    const res = await fetch('/api/orders/tables');
    const list = await res.json();
    tableGridEl.innerHTML = '';
    for (const table of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-btn';
      btn.dataset.table = table.label;

      const no = document.createElement('span');
      no.className = 'table-btn-no';
      no.textContent = table.label;
      btn.appendChild(no);

      // The group sitting at the table (PE10, อาจารย์, …) is how staff
      // recognise it. Half the tables seat more than one group, so those get a
      // "+" to warn that the label is only the dominant one.
      if (table.group) {
        const group = document.createElement('span');
        group.className = 'table-btn-group';
        group.textContent = table.mixed ? `${table.group} +` : table.group;
        btn.appendChild(group);
        btn.title = `Table ${table.label} · ${table.group}${table.mixed ? ' (mixed)' : ''} · ${table.seats} seated`;
      }

      tableGridEl.appendChild(btn);
    }
  }

  function selectTable(label) {
    selectedTable = label;
    currentTableEl.textContent = label;
    showScreen('menu');
  }

  tableGridEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.table-btn');
    if (!btn) return;
    selectTable(btn.dataset.table);
  });

  document.getElementById('walkin-btn').addEventListener('click', () => {
    selectTable('Walk-in');
  });

  document.getElementById('change-table-btn').addEventListener('click', () => {
    showScreen('table');
  });

  // ---- Coupon ----

  couponApplyBtn.addEventListener('click', async () => {
    const code = couponInput.value.trim();
    if (!code) return;
    const items = basketItems();
    if (items.length === 0) {
      alert('Add items to the basket before applying a coupon.');
      return;
    }
    couponApplyBtn.disabled = true;
    try {
      const res = await fetch('/api/orders/validate-coupon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, items })
      });
      const data = await res.json();
      if (!res.ok || !data.valid) {
        alert(data.reason || data.error || 'Invalid coupon');
        return;
      }
      appliedCoupon = { code: data.code, type: data.type, value: data.value };
      renderCoupon();
      renderMenu();
    } catch (err) {
      alert('Could not check the coupon. Try again.');
    } finally {
      couponApplyBtn.disabled = false;
    }
  });

  couponInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') couponApplyBtn.click();
  });

  couponRemoveBtn.addEventListener('click', () => {
    appliedCoupon = null;
    renderCoupon();
    renderMenu();
  });

  function hideAllTicketSections() {
    qrState.classList.add('hidden');
    paidState.classList.add('hidden');
    expiredState.classList.add('hidden');
    cancelledState.classList.add('hidden');
    slipPreviewWrap.classList.add('hidden');
    slipCameraWrap.classList.add('hidden');
  }

  function showCheckoutState(state) {
    stopSlipCamera();
    checkoutState = state;
    hideAllTicketSections();
    // 'paid' and 'slip' are the same screen — the hand-off docket — because
    // what the server has to do is identical however the payment was confirmed.
    ({
      qr: qrState,
      paid: paidState,
      expired: expiredState,
      cancelled: cancelledState,
      slip: paidState
    })[state].classList.remove('hidden');
    // The docket is read by someone other than the operator, so give it room.
    ticketCard.classList.toggle('is-docket', state === 'paid' || state === 'slip');
  }

  // ---- Hand-off docket ----

  // Same convention as the table grid: the dominant group, with a "+" when the
  // table seats more than one. The full list runs six codes wide on some
  // tables and would bury the table number it sits next to.
  function groupLabel(tableGroup) {
    const groups = (tableGroup || '').split(',').map((g) => g.trim()).filter(Boolean);
    if (groups.length === 0) return '';
    return groups.length > 1 ? `${groups[0]} +` : groups[0];
  }

  // What the server staff needs to act on: the drinks to carry, the table to
  // carry them to, and who is sitting there. Built from the order the server
  // returned (not local state) so it reflects what was actually recorded.
  function renderDocket(order) {
    docketTableEl.textContent = order.table || selectedTable || '–';
    docketGroupEl.textContent = groupLabel(order.tableGroup);

    docketItemsEl.innerHTML = '';
    for (const line of order.items || []) {
      const li = document.createElement('li');
      li.className = 'docket-item';
      li.innerHTML =
        `<span class="docket-item-qty">${line.qty}&times;</span>` +
        `<span class="docket-item-name"></span>`;
      li.querySelector('.docket-item-name').textContent = line.name;
      docketItemsEl.appendChild(li);
    }

    // Walk-ins have no seating snapshot — drop the block rather than show an
    // empty label the server would have to puzzle over.
    const guests = order.guests || [];
    docketGuestsWrap.classList.toggle('hidden', guests.length === 0);
    docketGuestsEl.textContent = guests.join(' · ');

    const collector = order.collectedBy || selectedStaff || '';
    docketFooterEl.textContent = collector
      ? `Taken by ${collector} · ${money(order.total)} paid`
      : `${money(order.total)} paid`;
  }

  // Success is a full stop, not a timeout: the drinks still have to be poured
  // and carried. Both buttons keep the staff member; only the table differs.
  function finishOrder() {
    stopPolling();
    stopCountdown();
    stopSlipCamera();
    for (const key of Object.keys(basket)) delete basket[key];
    currentOrderId = null;
    appliedCoupon = null;
    slipDataUrl = null;
    slipInput.value = '';
    renderCoupon();
    renderMenu();
  }

  document.getElementById('more-orders-btn').addEventListener('click', () => {
    finishOrder();
    showScreen('menu');
  });

  document.getElementById('another-table-btn').addEventListener('click', () => {
    finishOrder();
    selectedTable = null;
    showScreen('table');
  });

  function stopSlipCamera() {
    if (slipStream) {
      slipStream.getTracks().forEach((t) => t.stop());
      slipStream = null;
    }
    slipVideo.srcObject = null;
  }

  function resetToMenu() {
    stopPolling();
    stopCountdown();
    stopSlipCamera();
    for (const key of Object.keys(basket)) delete basket[key];
    currentOrderId = null;
    selectedTable = null;
    // Cleared so the next order is explicitly attributed rather than inheriting
    // whoever ran the last one; the picker still highlights them for one tap.
    selectedStaff = null;
    appliedCoupon = null;
    slipDataUrl = null;
    slipInput.value = '';
    renderCoupon();
    renderMenu();
    renderStaff();
    showScreen('staff');
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function startCountdown(expiresAt) {
    stopCountdown();
    const tick = () => {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        countdownEl.textContent = '0:00';
        stopCountdown();
        return;
      }
      const totalSec = Math.floor(remainingMs / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      countdownEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
      countdownEl.classList.toggle('urgent', totalSec <= 60);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function applyOrderState(order) {
    if (order.status === 'paid') {
      stopPolling();
      stopCountdown();
      paidHeadingEl.textContent = 'Paid';
      paidAmountEl.textContent = `${money(order.total)} received`;
      renderDocket(order);
      showCheckoutState('paid');
      refreshTray();
    } else if (order.status === 'expired') {
      stopPolling();
      stopCountdown();
      showCheckoutState('expired');
    } else if (order.status === 'cancelled') {
      stopPolling();
      stopCountdown();
      showCheckoutState('cancelled');
    }
  }

  // With a static PromptPay QR nothing confirms itself: the QR carries no
  // amount and no order reference, so the gateway has nothing to report. Call
  // out the amount the customer has to type, promote slip capture to the
  // primary action, and drop the gateway-only "Check now" button.
  function applyPaymentMode(mode, total) {
    const isStatic = mode === 'static_qr';
    staticQrHint.classList.toggle('hidden', !isStatic);
    staticQrAmount.textContent = money(total);
    qrFrame.classList.toggle('static', isStatic);
    slipPrimaryBtn.classList.toggle('hidden', !isStatic);
    recheckBtn.classList.toggle('hidden', isStatic);
    slipHintGateway.classList.toggle('hidden', isStatic);
    slipLinky.classList.toggle('hidden', isStatic);
  }

  function startPolling(orderId) {
    stopPolling();
    pollTimer = setInterval(async () => {
      const res = await fetch(`/api/orders/${orderId}`);
      if (!res.ok) return;
      const order = await res.json();
      applyOrderState(order);
    }, 2500);
  }

  checkoutBtn.addEventListener('click', async () => {
    const items = basketItems();

    checkoutBtn.disabled = true;
    let order;
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          table: selectedTable,
          collectedBy: selectedStaff,
          couponCode: appliedCoupon ? appliedCoupon.code : undefined
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Coupon got claimed between apply and checkout — clear it so the staff
        // can retry without the dead code.
        if (res.status === 409) {
          appliedCoupon = null;
          renderCoupon();
          renderMenu();
        }
        throw new Error(err.error || 'Could not create order');
      }
      order = await res.json();
    } catch (err) {
      alert(err.message);
      checkoutBtn.disabled = false;
      return;
    }

    currentOrderId = order.id;
    checkoutAmount.textContent = money(order.total);
    ticketTableEl.textContent = order.table || selectedTable || '';
    const collector = order.collectedBy || selectedStaff || '';
    ticketStaffEl.textContent = collector ? ` · ${collector}` : '';
    qrImage.src = order.qrImage;
    applyPaymentMode(order.paymentMode, order.total);
    showCheckoutState('qr');
    showScreen('checkout');
    startCountdown(order.expiresAt);
    startPolling(order.id);
  });

  document.getElementById('cancel-btn').addEventListener('click', async () => {
    if (!currentOrderId) return;
    await fetch(`/api/orders/${currentOrderId}/cancel`, { method: 'POST' });
    resetToMenu();
  });

  document.getElementById('recheck-btn').addEventListener('click', async () => {
    if (!currentOrderId) return;
    const res = await fetch(`/api/orders/${currentOrderId}/recheck`, { method: 'POST' });
    if (res.ok) {
      const order = await res.json();
      applyOrderState(order);
    }
  });

  document.getElementById('retry-btn').addEventListener('click', resetToMenu);
  document.getElementById('new-order-btn').addEventListener('click', resetToMenu);

  // ---- Slip fallback ----

  // Downscale to a max dimension and re-encode as JPEG so uploads stay small
  // (no dependency needed — pure canvas). Returns a data URL.
  function compressImage(file, maxDim = 1280, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bad image')); };
      img.src = url;
    });
  }

  // Try the in-page live camera first (no app swap). It needs a secure context
  // (HTTPS or localhost); when that's unavailable — e.g. plain-HTTP LAN — fall
  // back to the native file/camera picker so slip capture still works.
  async function openSlipCapture() {
    if (!currentOrderId) return;
    stateBeforeSlip = checkoutState;
    const canUseCamera = window.isSecureContext &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (canUseCamera) {
      try {
        slipStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        slipVideo.srcObject = slipStream;
        hideAllTicketSections();
        slipCameraWrap.classList.remove('hidden');
        return;
      } catch (err) {
        // No camera / permission denied — fall through to the file picker.
        slipStream = null;
      }
    }
    slipInput.value = ''; // let re-picking the same file fire 'change'
    slipInput.click();
  }

  function showSlipPreview(dataUrl, fromCamera) {
    slipDataUrl = dataUrl;
    slipPreview.src = dataUrl;
    slipRetakeBtn.classList.toggle('hidden', !fromCamera);
    hideAllTicketSections();
    slipPreviewWrap.classList.remove('hidden');
  }

  document.querySelectorAll('.js-upload-slip').forEach((btn) => {
    btn.addEventListener('click', openSlipCapture);
  });

  // In-page camera: grab the current video frame, downscale, and preview it.
  document.getElementById('slip-capture-btn').addEventListener('click', () => {
    const w = slipVideo.videoWidth;
    const h = slipVideo.videoHeight;
    if (!w || !h) return;
    const maxDim = 1280;
    let cw = w;
    let ch = h;
    if (Math.max(w, h) > maxDim) {
      if (w >= h) { ch = Math.round((h * maxDim) / w); cw = maxDim; }
      else { cw = Math.round((w * maxDim) / h); ch = maxDim; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d').drawImage(slipVideo, 0, 0, cw, ch);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    stopSlipCamera();
    showSlipPreview(dataUrl, true);
  });

  document.getElementById('slip-camera-cancel-btn').addEventListener('click', () => {
    slipDataUrl = null;
    showCheckoutState(stateBeforeSlip);
  });

  slipRetakeBtn.addEventListener('click', openSlipCapture);

  slipInput.addEventListener('change', async () => {
    const file = slipInput.files && slipInput.files[0];
    if (!file) return;
    let dataUrl;
    try {
      dataUrl = await compressImage(file);
    } catch (err) {
      alert('Could not read that image. Try another photo.');
      return;
    }
    showSlipPreview(dataUrl, false);
  });

  document.getElementById('slip-cancel-btn').addEventListener('click', () => {
    slipDataUrl = null;
    showCheckoutState(stateBeforeSlip);
  });

  document.getElementById('slip-confirm-btn').addEventListener('click', async (e) => {
    if (!currentOrderId || !slipDataUrl) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/orders/${currentOrderId}/slip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: slipDataUrl })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not record slip');
      }
      const order = await res.json();
      stopPolling();
      stopCountdown();
      slipDataUrl = null;
      paidHeadingEl.textContent = 'Slip recorded';
      paidAmountEl.textContent = `${money(order.total)} recorded from slip`;
      renderDocket(order);
      showCheckoutState('slip');
      refreshTray();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- To-serve tray ----
  //
  // Every paid order that hasn't been carried out yet, grouped into one box per
  // table — two tables waiting means two boxes. Reachable from every screen,
  // and served off with one tap. State lives in the DB (served_at), not the
  // page, so a reload or a second tablet sees the same backlog.

  function minutesSince(ts) {
    if (!ts) return 0;
    return Math.max(0, Math.floor((Date.now() - ts) / 60000));
  }

  function waitedLabel(ts) {
    const mins = minutesSince(ts);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function groupOrdersByTable(orders) {
    const byTable = new Map();
    for (const order of orders) {
      const key = order.table || 'Walk-in';
      if (!byTable.has(key)) {
        byTable.set(key, { table: key, tableGroup: order.tableGroup, guests: order.guests || [], orders: [] });
      }
      byTable.get(key).orders.push(order);
    }
    // Longest-waiting table first — that's the one someone is still thirsty at.
    return [...byTable.values()].sort((a, b) => (a.orders[0].paidAt || 0) - (b.orders[0].paidAt || 0));
  }

  function renderTrayCount() {
    trayCountEl.textContent = String(openOrders.length);
    trayBtn.classList.toggle('has-orders', openOrders.length > 0);
  }

  function renderTray() {
    const tables = groupOrdersByTable(openOrders);
    trayList.innerHTML = '';
    trayEmpty.classList.toggle('hidden', tables.length > 0);
    trayTitle.textContent = tables.length === 0
      ? 'Nothing waiting'
      : `${openOrders.length} order${openOrders.length === 1 ? '' : 's'} · ${tables.length} table${tables.length === 1 ? '' : 's'}`;

    for (const entry of tables) {
      const box = document.createElement('section');
      box.className = 'tray-table';

      const head = document.createElement('header');
      head.className = 'tray-table-head';
      head.innerHTML =
        `<span class="tray-table-label">Table</span>` +
        `<strong class="tray-table-no"></strong>` +
        `<span class="tray-table-group"></span>`;
      head.querySelector('.tray-table-no').textContent = entry.table;
      head.querySelector('.tray-table-group').textContent = groupLabel(entry.tableGroup);
      box.appendChild(head);

      if (entry.guests.length) {
        const guests = document.createElement('p');
        guests.className = 'tray-guests';
        guests.textContent = entry.guests.join(' · ');
        box.appendChild(guests);
      }

      const list = document.createElement('ul');
      list.className = 'tray-orders';
      for (const order of entry.orders) {
        const li = document.createElement('li');
        li.className = 'tray-order';

        const body = document.createElement('div');
        body.className = 'tray-order-body';

        const items = document.createElement('p');
        items.className = 'tray-order-items';
        items.textContent = (order.items || []).map((l) => `${l.qty}× ${l.name}`).join(' · ');

        const meta = document.createElement('p');
        meta.className = 'tray-order-meta';
        const waited = waitedLabel(order.paidAt);
        meta.textContent = order.collectedBy
          ? `${order.collectedBy} · ${waited} · ${money(order.total)}`
          : `${waited} · ${money(order.total)}`;
        // Ten minutes on the tray means something went wrong on the floor.
        if (minutesSince(order.paidAt) >= 10) meta.classList.add('is-late');

        body.appendChild(items);
        body.appendChild(meta);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary tray-serve-btn';
        btn.dataset.id = order.id;
        btn.textContent = 'Served';

        li.appendChild(body);
        li.appendChild(btn);
        list.appendChild(li);
      }
      box.appendChild(list);
      trayList.appendChild(box);
    }
  }

  async function refreshTray() {
    try {
      const res = await fetch('/api/orders/open');
      if (!res.ok) return;
      openOrders = await res.json();
    } catch (err) {
      return; // keep the last known list rather than blanking the tray
    }
    renderTrayCount();
    if (!trayPanel.classList.contains('hidden')) renderTray();
  }

  function openTray() {
    renderTray();
    trayPanel.classList.remove('hidden');
    refreshTray();
  }

  trayBtn.addEventListener('click', openTray);
  document.getElementById('tray-close-btn').addEventListener('click', () => {
    trayPanel.classList.add('hidden');
  });
  // Tapping the dimmed backdrop closes too, but not a tap inside the sheet.
  trayPanel.addEventListener('click', (e) => {
    if (e.target === trayPanel) trayPanel.classList.add('hidden');
  });

  trayList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tray-serve-btn');
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/orders/${btn.dataset.id}/serve`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not mark it served');
      // Drop it locally first so the box disappears on the tap, then reconcile.
      openOrders = openOrders.filter((o) => o.id !== btn.dataset.id);
      renderTrayCount();
      renderTray();
      refreshTray();
    } catch (err) {
      btn.disabled = false;
      alert('Could not mark that order served. Try again.');
    }
  });

  loadStaff();
  loadTables();
  loadMenu();
  refreshTray();
  // Cheap heartbeat so the badge stays honest if another tablet takes an order.
  setInterval(refreshTray, 15000);
})();
