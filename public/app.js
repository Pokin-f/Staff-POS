(() => {
  const tableScreen = document.getElementById('table-screen');
  const menuScreen = document.getElementById('menu-screen');
  const checkoutScreen = document.getElementById('checkout-screen');
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

  const qrImage = document.getElementById('qr-image');
  const checkoutAmount = document.getElementById('checkout-amount');
  const countdownEl = document.getElementById('countdown');
  const paidAmountEl = document.getElementById('paid-amount');

  const ITEM_META = {
    beer: { image: 'images/beer_pitcher.png', tone: 'beer', alt: 'Bottle of Chang beer' },
    regency: { image: 'images/regency.png', tone: 'regency', alt: 'Bottle of Regency brandy' }
  };

  let menu = [];
  const basket = {}; // { itemId: qty }
  let selectedTable = null;
  let currentOrderId = null;
  let pollTimer = null;
  let countdownTimer = null;

  function money(n) {
    return `฿${Number(n).toFixed(0)}`;
  }

  function basketTotal() {
    return menu.reduce((sum, item) => sum + (basket[item.id] || 0) * item.price, 0);
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
    basketTotalEl.textContent = money(basketTotal());
    checkoutBtn.disabled = basketTotal() <= 0;
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
    tableScreen.classList.toggle('hidden', screen !== 'table');
    menuScreen.classList.toggle('hidden', screen !== 'menu');
    checkoutScreen.classList.toggle('hidden', screen !== 'checkout');
  }

  async function loadTables() {
    const res = await fetch('/api/orders/tables');
    const list = await res.json();
    tableGridEl.innerHTML = '';
    for (const label of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-btn';
      btn.textContent = label;
      btn.dataset.table = label;
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

  function showCheckoutState(state) {
    qrState.classList.toggle('hidden', state !== 'qr');
    paidState.classList.toggle('hidden', state !== 'paid');
    expiredState.classList.toggle('hidden', state !== 'expired');
    cancelledState.classList.toggle('hidden', state !== 'cancelled');
  }

  function resetToMenu() {
    stopPolling();
    stopCountdown();
    for (const key of Object.keys(basket)) delete basket[key];
    currentOrderId = null;
    selectedTable = null;
    renderMenu();
    showScreen('table');
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
      showCheckoutState('paid');
      paidAmountEl.textContent = `${money(order.total)} received`;
      setTimeout(resetToMenu, 4000);
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
    const items = menu
      .filter((item) => (basket[item.id] || 0) > 0)
      .map((item) => ({ id: item.id, qty: basket[item.id] }));

    checkoutBtn.disabled = true;
    let order;
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, table: selectedTable })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
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
    qrImage.src = order.qrImage;
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

  loadTables();
  loadMenu();
})();
